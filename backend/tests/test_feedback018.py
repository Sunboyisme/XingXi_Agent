import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app import db, knowledge, office, office_formats, todos, tools

API = "/api/v1"


def test_todo_tool_update_preserves_omitted_notes_and_reminder(client):
    due = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    saved = client.post(API + "/todos", json={"title": "原待办", "notes": "保留备注", "reminder_at": due}).json()
    update = next(tool for tool in todos.build("review", None) if tool.name == "update_todo")
    value = json.loads(update.invoke({"todo_id": saved["id"], "changes": {"title": "新的标题"}}))
    assert value["title"] == "新的标题"
    assert value["notes"] == "保留备注"
    assert value["reminder_at"] == saved["reminder_at"]
    cleared = json.loads(update.invoke({"todo_id": saved["id"], "changes": {"reminder_at": None}}))
    assert cleared["title"] == "新的标题" and cleared["reminder_at"] is None


def test_editing_fired_todo_keeps_its_unread_notification(client):
    due = (datetime.now(UTC) - timedelta(minutes=1)).isoformat(timespec="microseconds")
    with db.Session() as session:
        row = db.Todo(title="已提醒事项", notes="原备注", reminder_at=due)
        session.add(row); session.flush()
        rule = db.Reminder(todo_id=row.id, title=row.title, body=row.notes, due_at=due, status="fired")
        session.add(rule); session.flush()
        note = db.Notification(reminder_id=rule.id, todo_id=row.id, occurrence_at=due, title=row.title, body=row.notes)
        session.add(note); session.commit(); key, note_id = row.id, note.id
    response = client.put(API + f"/todos/{key}", json={"title": "更新后的事项", "notes": "新备注", "reminder_at": due})
    assert response.status_code == 200
    with db.Session() as session:
        note = session.get(db.Notification, note_id)
        assert note.status == "pending" and note.title == "更新后的事项" and note.body == "新备注"
        assert not list(session.scalars(select(db.Reminder).where(db.Reminder.todo_id == key, db.Reminder.status == "active")))
    assert client.post(API + f"/todos/{key}/action", json={"action": "complete"}).status_code == 200
    with db.Session() as session:
        assert session.get(db.Notification, note_id).status == "cancelled"
    restored = client.post(API + f"/todos/{key}/action", json={"action": "restore"}).json()
    assert restored["reminder_at"] is None


@pytest.mark.asyncio
async def test_todo_partial_update_survives_the_agent_guard_serialization(client):
    due = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    saved = client.post(API + "/todos", json={"title": "守卫修改", "notes": "保留", "reminder_at": due}).json()
    with db.Session() as session:
        conversation = db.Conversation(title="工具检查")
        session.add(conversation); session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id)
        session.add(run); session.commit(); run_id = run.id
    original = next(tool for tool in todos.build(run_id, conversation.id) if tool.name == "update_todo")
    entry = {"id": "update_todo", "name": "修改待办", "description": "修改待办", "source": "builtin", "source_label": "内置工具"}
    guarded = tools._guard_tool(entry, {"update_todo": original}, run_id)
    arguments = original.args_schema.model_validate({"todo_id": saved["id"], "changes": {"title": "新标题"}}).model_dump()
    value = json.loads(await guarded(**arguments))
    assert value["title"] == "新标题" and value["notes"] == "保留" and value["reminder_at"] == saved["reminder_at"]


def test_completing_todo_cancels_queued_delivery_after_notification_was_read(client):
    with db.Session() as session:
        row = db.Todo(title="已读通知待办")
        session.add(row); session.flush()
        due = datetime.now(UTC).isoformat()
        rule = db.Reminder(todo_id=row.id, title=row.title, body="", due_at=due, status="fired")
        session.add(rule); session.flush()
        note = db.Notification(todo_id=row.id, reminder_id=rule.id, title=row.title, body="", occurrence_at=due, status="read")
        session.add(note); session.flush()
        delivery = db.WechatDelivery(notification_id=note.id, source_key="review-pending", account_id="synthetic", content="未发送", status="pending")
        session.add(delivery); session.commit(); key, note_id, delivery_id = row.id, note.id, delivery.id
    client.post(API + f"/todos/{key}/action", json={"action": "complete"})
    with db.Session() as session:
        assert session.get(db.Notification, note_id).status == "read"
        assert session.get(db.WechatDelivery, delivery_id).status == "cancelled"


@pytest.mark.parametrize("paths", ["[null]", "[42]", '[{"name":"file"}]', '["../outside.md"]'])
def test_knowledge_rejects_invalid_relative_paths_without_writing_files(client, paths):
    response = client.post(API + "/knowledge/import", data={"paths": paths}, files={"files": ("readme.md", b"# text")})
    assert response.status_code == 422
    assert client.get(API + "/knowledge/documents").json() == []


def test_knowledge_ingestion_switch_retrieval_and_removal(client, monkeypatch):
    async def parse(operation, **kwargs):
        return office_formats.parse(base64.b64decode(kwargs["data"]), kwargs["name"])
    monkeypatch.setattr(office, "worker", parse)
    content = "# 雪豹护理\n\n雪豹的护理档案记录在高山观察站。".encode()
    uploaded = client.post(API + "/knowledge/import", data={"paths": '["资料/雪豹.md"]'}, files={"files": ("雪豹.md", content)}).json()[0]
    asyncio.run(knowledge.parse_once())
    key = uploaded["id"]
    assert client.get(API + f"/knowledge/documents/{key}/preview").json()["content"].encode() == content
    assert client.get(API + "/knowledge/search", params={"query": "雪豹护理"}).json() == []
    assert client.put(API + "/knowledge/config", json={"enabled": True}).status_code == 200
    found = client.get(API + "/knowledge/search", params={"query": "雪豹护理"}).json()
    assert found and found[0]["document_id"] == key and found[0]["relative_path"] == "资料/雪豹.md"
    assert client.delete(API + f"/knowledge/documents/{key}").status_code == 200
    assert client.get(API + "/knowledge/search", params={"query": "雪豹护理"}).json() == []
    with db.Session() as session:
        assert not list(session.scalars(select(db.KnowledgeChunk)))


def test_partial_0025_preview_migrates_without_losing_saved_lessons(client, tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import data_transfer
    import sqlite3
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    stage = tmp_path / "preview-export"
    stage.mkdir()
    target = stage / "bai.sqlite"
    configuration = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    configuration.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    configuration.set_main_option("sqlalchemy.url", "sqlite:///" + target.as_posix())
    command.upgrade(configuration, "0025")
    engine = create_engine("sqlite:///" + target.as_posix())
    with Session(engine) as session:
        goal = db.Goal(title="保留课程", objective="学习", foundation="入门")
        session.add(goal); session.flush()
        node = db.KnowledgeNode(goal_id=goal.id, ordinal=0, module="基础", title="第一章", objective="理解")
        session.add(node); session.flush()
        session.add(db.Lesson(id="saved", node_id=node.id, content="保留教学内容", exercise="题目", criteria="标准", graph_thread_id="thread"))
        session.commit()
    engine.dispose()
    with sqlite3.connect(target) as connection:
        connection.execute("ALTER TABLE lessons DROP COLUMN knowledge_sources")
    (stage / "manifest.json").write_text(json.dumps({"format": "xiaoxi-data", "version": 1, "schema": "0025"}), encoding="utf-8")
    # The compatibility check upgrades only the staged copy with trusted code.
    assert data_transfer.validate(stage)["counts"]["goals"] == 1
    with sqlite3.connect(target) as connection:
        assert connection.execute("SELECT content, knowledge_sources FROM lessons WHERE id='saved'").fetchone() == ("保留教学内容", "[]")
