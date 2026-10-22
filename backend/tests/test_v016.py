"""0.1.6 regression source; execute only when the user requests tests."""

import json
from datetime import date
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import agent, complex_tasks, db, feature_tools, memory, plan_execution, plan_targets, plans, provider, task_context, wechat
from .test_complex_tasks import task_records


def request_context(text):
    with db.Session() as session:
        conversation = db.Conversation(title="日期核对")
        session.add(conversation)
        session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content=text,
                             created_at="2026-10-22T08:00:00+00:00")
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, source_message_id=message.id)
        session.add(run)
        session.commit()
        return run.id, conversation.id


def query_proof(run_id, values):
    with db.Session() as session:
        session.add(db.RunEvent(run_id=run_id, kind="tool", data={
            "tool_id": "list_plans", "status": "completed", "result": values,
        }))
        session.commit()


def timed(day, **changes):
    return plans.PlanWrite(title=f"安排{day}", start=f"2026-10-{day}T07:00:00+08:00",
                           end=f"2026-10-{day}T08:00:00+08:00", **changes)


def test_local_day_selection_deletion_and_restoration_do_not_touch_neighbors():
    rows = plans.create_events([timed(day) for day in (24, 25, 26)])
    run_id, conversation = request_context("将25号的计划去掉")
    query_proof(run_id, plans.list_events("2026-10-24", "2026-10-27"))
    with pytest.raises(HTTPException):
        plan_targets.validate(run_id, conversation, rows[0]["id"], "2026-10-25")
    with pytest.raises(ValueError):
        plan_targets.validate(run_id, conversation, rows[2]["id"], "2026-10-26")
    tool = next(value for value in feature_tools.build(run_id, conversation) if value.name == "delete_plan")
    result = json.loads(tool.invoke({"plan_id": rows[1]["id"], "target_date": "2026-10-25"}))
    assert result["deleted"] and result["plan"]["local_start"].startswith("2026-10-25T07:")
    assert {value["id"] for value in plans.list_events("2026-10-24", "2026-10-27")} == {rows[0]["id"], rows[2]["id"]}
    restore_run, restore_conversation = request_context("恢复25号的计划")
    query_proof(restore_run, plans.list_events("2026-10-25", "2026-10-26", include_deleted=True))
    restore = next(value for value in feature_tools.build(restore_run, restore_conversation) if value.name == "action_plan")
    restored = json.loads(restore.invoke({"plan_id": rows[1]["id"], "action": "restore", "target_date": "2026-10-25"}))
    assert restored["id"] == rows[1]["id"] and restored["local_start"].startswith("2026-10-25T07:")
    assert len(plans.list_events("2026-10-24", "2026-10-27")) == 3


def test_date_guard_rejects_changed_records_and_wrong_relative_day():
    row = plans.create_events([timed(25)])[0]
    run_id, conversation = request_context("删除25号的计划")
    query_proof(run_id, [row])
    plans.update_event(row["id"], timed(25, notes="已有新修改"))
    # Content changes must also invalidate a destructive selection.
    with pytest.raises(HTTPException):
        plan_targets.validate(run_id, conversation, row["id"], "2026-10-25")
    with pytest.raises(ValueError):
        plan_targets.check_date_words("下周日", date(2026, 10, 25), date(2026, 10, 22))


def test_display_timezone_controls_query_without_changing_original_occurrence():
    row = plans.create_events([timed(25)])[0]
    values = plans.list_events("2026-10-24", "2026-10-25", "UTC")
    assert len(values) == 1 and values[0]["id"] == row["id"]
    assert values[0]["local_start"].startswith("2026-10-24T23:")
    assert values[0]["occurrence_start"] == row["occurrence_start"]
    assert plans.list_events("2026-10-25", "2026-10-26", "Asia/Shanghai")[0]["local_start"].startswith("2026-10-25T07:")


@pytest.mark.parametrize("before,after", [
    ("记一下我喜欢打羽毛球", "用户喜欢打羽毛球"),
    ("请帮我记住：我每周日不安排学习", "用户每周日不安排学习"),
    ("我暂时不喜欢辣的食物", "用户暂时不喜欢辣的食物"),
    ("不要记住我的密码", "不要记住我的密码"),
])
def test_memory_normalization_preserves_qualifications(before, after):
    assert memory.normalize_content(before) == after
    assert memory.normalize_content(after) == after


def test_memory_preview_is_read_only_and_selected_edit_checks_revision(client):
    with db.Session() as session:
        record = db.Memory(content="记一下我喜欢打羽毛球", category="preference", source="原会话",
                           evidence="记一下我喜欢打羽毛球", state="confirmed")
        session.add(record)
        session.commit()
        key, revision = record.id, record.revision
    preview = client.get("/api/v1/memories/normalization-preview").json()
    assert preview == [{"id": key, "revision": revision, "before": "记一下我喜欢打羽毛球", "after": "用户喜欢打羽毛球"}]
    with db.Session() as session:
        assert session.get(db.Memory, key).content == preview[0]["before"]
    payload = {"content": preview[0]["after"], "category": "preference", "source": "原会话", "state": "confirmed", "revision": revision}
    assert client.put(f"/api/v1/memories/{key}", json=payload).status_code == 200
    assert client.put(f"/api/v1/memories/{key}", json=payload).status_code == 409
    with db.Session() as session:
        assert session.get(db.Memory, key).evidence == "记一下我喜欢打羽毛球"


def test_known_0017_export_upgrades_only_in_import_staging(client, tmp_path):
    import io
    import sqlite3
    import zipfile
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import config

    root = Path(__file__).resolve().parents[1]
    legacy = tmp_path / "legacy.sqlite"
    migration = Config(str(root / "alembic.ini"))
    migration.set_main_option("script_location", str(root / "migrations"))
    migration.set_main_option("sqlalchemy.url", f"sqlite:///{legacy.as_posix()}")
    command.upgrade(migration, "0017")
    with sqlite3.connect(legacy) as connection:
        old_table = connection.execute("SELECT sql FROM sqlite_master WHERE name='wechat_deliveries'").fetchone()[0]
    exported = client.post("/api/v1/settings/data/export").json()
    with zipfile.ZipFile(exported["path"]) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    staged = tmp_path / "archive.sqlite"
    staged.write_bytes(files["bai.sqlite"])
    with sqlite3.connect(staged) as connection:
        connection.execute("DROP TABLE wechat_deliveries")
        connection.execute(old_table)
        connection.execute("UPDATE alembic_version SET version_num='0017'")
    files["bai.sqlite"] = staged.read_bytes()
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    response = client.post("/api/v1/settings/data/inspect", files={"file": ("legacy.zip", raw.getvalue())})
    assert response.status_code == 200
    with sqlite3.connect(config.DATA_DIR / "bai.sqlite") as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0018"


@pytest.mark.asyncio
async def test_terminal_task_misclassified_as_continue_still_handles_new_edit(monkeypatch):
    task_id, _, _, _, conversation = task_records()
    with db.Session() as session:
        task = session.get(db.ComplexTask, task_id)
        task.status, task.model_config = "completed", {"provider_id": "custom", "model_name": "fixture"}
        message = db.Message(conversation_id=conversation, role="user", content="这个计划不好，帮我删掉吧")
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation, source_message_id=message.id, model_config=task.model_config)
        session.add(run)
        session.commit()
        run_id = run.id
    async def route(*args, **kwargs):
        return complex_tasks.Route(decision="continue", task_id=task_id)
    calls = []
    async def new_edit(*args, **kwargs):
        calls.append(args)
        return {"content": "按新的删除要求处理", "conversation_id": conversation}
    monkeypatch.setattr(provider, "ask_json", route)
    monkeypatch.setattr(agent, "_chat", new_edit)
    result = await complex_tasks.dispatch(run_id, conversation)
    assert len(calls) == 1 and "无需继续" not in result["content"]


def test_actual_receipts_collapse_nonrecurring_move_to_its_real_final_date():
    row = plans.create_events([timed(25)])[0]
    moved = plans.update_event(row["id"], timed(26))
    events = [SimpleNamespace(data={"tool_id": "create_plans", "status": "completed", "result": [row]}),
              SimpleNamespace(data={"tool_id": "update_plan", "status": "completed", "result": {**moved, "operation": "update"}})]
    facts = plan_execution.operation_facts(events)
    assert len(facts) == 1
    receipt = plan_execution.facts_receipt(facts)
    assert "2026-10-26 07:00" in receipt and "2026-10-25" not in receipt


@pytest.mark.asyncio
async def test_old_delete_receipt_is_not_reused_after_actual_plan_restoration():
    task_id, step_id, run_id, message_id, _ = task_records()
    row = plans.create_events([timed(25)])[0]
    calls = []
    async def remove(**arguments):
        calls.append(arguments)
        return json.dumps(plans.delete_event(row["id"]))
    entry = {"id": "delete_plan", "name": "删除计划", "source": "builtin", "source_label": "内置"}
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        await complex_tasks.guarded(entry, run_id, {"plan_id": row["id"]}, remove)
    finally:
        task_context.current.reset(token)
    plans.act(row["id"], plans.PlanAction(action="restore"))
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        with pytest.raises(task_context.TaskControl):
            await complex_tasks.guarded(entry, run_id, {"plan_id": row["id"]}, remove)
    finally:
        task_context.current.reset(token)
    assert len(calls) == 1 and plans.list_events("2026-10-25", "2026-10-26")[0]["status"] == "planned"


@pytest.mark.asyncio
async def test_wechat_missing_ret_is_accepted_without_exposing_upstream_body(monkeypatch):
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    monkeypatch.setattr(wechat.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    assert await wechat.request("/ilink/bot/sendmessage", body={}) == {}


@pytest.mark.asyncio
async def test_manual_wechat_probe_is_queued_once_and_timeout_remains_unknown(monkeypatch):
    vault = {"wechat_token": "synthetic-token", "wechat_context": "synthetic-context"}
    monkeypatch.setattr(wechat, "secret_get", lambda key: vault.get(key, ""))
    wechat.update_state(enabled=True, account_id="fixture-bot", owner_id="fixture-owner", needs_interaction=False)
    channel = wechat.WechatChannel()
    first = await channel.test_message("00000000-0000-0000-0000-000000000001")
    second = await channel.test_message("00000000-0000-0000-0000-000000000001")
    assert first["id"] == second["id"] and first["status"] == "pending"
    async def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("private-request-data")
    monkeypatch.setattr(wechat, "request", timeout)
    await channel.deliver()
    with db.Session() as session:
        row = session.get(db.WechatDelivery, first["id"])
        assert row.status == "uncertain" and row.diagnostics["error_kind"] == "read_timeout"
        assert "private-request-data" not in row.error
        assert len(session.scalars(select(db.WechatDelivery)).all()) == 1
    await channel.deliver()
    with db.Session() as session:
        assert session.get(db.WechatDelivery, first["id"]).status == "uncertain"
