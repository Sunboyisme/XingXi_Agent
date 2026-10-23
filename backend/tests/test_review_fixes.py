"""Regression sources for the twelve-item static review; run only when requested."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import config, data_transfer, db, learning, main, model_profiles, office, plans, provider, runs, schemas
from .test_app import API


def plan(title="事项", **changes):
    return plans.PlanWrite(title=title, start="2030-11-01T09:00:00+08:00",
                          end="2030-11-01T10:00:00+08:00", **changes)


def test_rejected_attachment_does_not_block_later_messages(client, monkeypatch):
    monkeypatch.setattr(model_profiles, "resolve", lambda *_: {"vision_enabled": False})
    monkeypatch.setattr(provider, "model", lambda *_: object())
    monkeypatch.setattr(runs, "launch", lambda *_: None)
    conversation = client.post(API + "/conversations", json={}).json()
    with db.Session() as session:
        document = db.Attachment(name="待解析.txt", media_type="text/plain", width=0, height=0)
        session.add(document)
        session.flush()
        session.add(db.OfficeFile(id=document.id, size=1, status="parsing"))
        session.commit()
        document_id = document.id
    response = client.post(f"{API}/conversations/{conversation['id']}/messages",
                           json={"content": "读取附件", "attachment_ids": [document_id]})
    assert response.status_code == 409
    assert client.get(f"{API}/runs?conversation_id={conversation['id']}").json() == []
    assert client.post(f"{API}/conversations/{conversation['id']}/messages", json={"content": "你好"}).status_code == 200


def test_distinct_creation_steps_share_authorization_but_not_deduplication():
    source = db.uid()
    first = plans.create_events([plan("第一步")], source)[0]
    second = plans.create_events([plan("第二步")], source)[0]
    assert first["id"] != second["id"]
    assert plans.create_events([plan("第一步")], source)[0]["id"] == first["id"]
    # A later reminder request is a distinct write too.
    third = plans.create_events([plan("第一步", reminder_enabled=True, reminder_offsets=[-30])], source)[0]
    assert third["id"] != first["id"]
    assert len(plans.list_events()) == 3


def test_whole_series_retime_keeps_completed_and_moved_instances():
    original = plan(recurrence="daily", repeat_count=3)
    root = plans.create_events([original])[0]
    events = plans.list_events("2030-11-01", "2030-11-10")
    plans.act(root["id"], plans.PlanAction(action="complete", occurrence_start=events[0]["occurrence_start"]))
    single = {**original.model_dump(), "start": "2030-11-05T15:00:00+08:00", "end": "2030-11-05T16:00:00+08:00",
              "recurrence": "none", "repeat_count": None, "scope": "this", "occurrence_start": events[2]["occurrence_start"]}
    plans.update_event(root["id"], plans.PlanUpdate(**single))
    changed = {**original.model_dump(), "start": "2030-11-01T10:00:00+08:00", "end": "2030-11-01T11:00:00+08:00"}
    plans.update_event(root["id"], plans.PlanUpdate(**changed))
    result = plans.list_events("2030-11-01", "2030-11-10")
    assert len(result) == 3
    assert result[0]["status"] == "completed" and result[0]["start"] == events[0]["start"]
    assert result[1]["start"].startswith("2030-11-02T02:00")
    assert result[2]["start"].startswith("2030-11-05T07:00")
    assert result[0]["occurrence_start"].startswith("2030-11-01T02:00")
    try:
        plans.update_event(root["id"], plans.PlanUpdate(**{**changed, "repeat_count": 1}))
    except HTTPException as error:
        assert error.status_code == 422
    else:
        raise AssertionError("Truncation must not silently discard an exception")
    assert plans.list_events("2030-11-01", "2030-11-10") == result


def test_old_unread_notification_is_not_hidden_by_read_history(client):
    with db.Session() as session:
        reminder = db.Reminder(title="提醒", due_at="2030-11-01T01:00:00+00:00", status="disabled")
        session.add(reminder)
        session.flush()
        old = db.Notification(reminder_id=reminder.id, occurrence_at="2020-01-01T00:00:00+00:00",
                              created_at="2020-01-01T00:00:00+00:00", title="旧的未读", body="", status="presented")
        session.add(old)
        for index in range(55):
            session.add(db.Notification(reminder_id=reminder.id, occurrence_at=f"2030-01-01T00:00:{index:02d}+00:00",
                                        title="已读", body="", status="read"))
        session.commit()
        old_id = old.id
    assert old_id not in {note["id"] for note in client.get(API + "/notifications").json()}
    assert [note["id"] for note in client.get(API + "/notifications?unread_only=true").json()] == [old_id]
    assert len(client.get(API + "/notifications?offset=50").json()) == 6


def test_delete_chat_removes_owned_outputs_but_keeps_shared_image(client):
    with db.Session() as session:
        first, other = db.Conversation(title="删除"), db.Conversation(title="保留")
        image = db.Attachment(name="共享.jpg", media_type="image/jpeg", width=1, height=1)
        document = db.Attachment(name="独占.txt", media_type="text/plain", width=0, height=0)
        session.add_all([first, other, image, document])
        session.flush()
        run = db.Run(kind="chat", conversation_id=first.id, status="completed", result={"content": "需删除的内容"})
        session.add(run)
        session.flush()
        artifact = db.Artifact(run_id=run.id, name="成果.txt", media_type="text/plain", storage_name=db.uid() + ".bin")
        session.add_all([artifact, db.RunEvent(run_id=run.id, kind="tool", data={"text": "需删除的结果"}),
            db.Message(conversation_id=first.id, role="user", content="原文", attachment_ids=[image.id, document.id]),
            db.Message(conversation_id=other.id, role="user", content="保留", attachment_ids=[image.id]),
            db.OfficeFile(id=document.id, conversation_id=first.id, size=1, status="ready"),
            db.Memory(content="单独保存的记忆")])
        session.commit()
        first_id, run_id, image_id, document_id = first.id, run.id, image.id, document.id
        output_name = artifact.storage_name
    image_path = config.ATTACHMENTS_DIR / f"{image_id}.jpg"
    image_path.write_bytes(b"shared")
    document_path = office.root() / f"{document_id}.bin"
    document_path.write_bytes(b"owned")
    output_path = config.ATTACHMENTS_DIR / "artifacts" / output_name
    output_path.parent.mkdir(exist_ok=True)
    output_path.write_bytes(b"owned output")
    workspace = config.DATA_DIR / "skill-runs" / run_id
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "copy.txt").write_text("owned output", encoding="utf-8")
    assert client.delete(f"{API}/conversations/{first_id}").json()["deleted"]
    with db.Session() as session:
        assert session.get(db.Run, run_id) is None
        assert session.scalar(select(db.RunEvent).where(db.RunEvent.run_id == run_id)) is None
        assert session.get(db.Attachment, document_id) is None
        assert session.get(db.Attachment, image_id) is not None
        assert session.scalar(select(db.Memory)) is not None
    assert image_path.exists() and not document_path.exists() and not output_path.exists()
    assert not workspace.exists()


def test_startup_recovers_files_introduced_by_restore(monkeypatch):
    from fastapi.testclient import TestClient

    key = db.uid()
    def restored():
        with db.Session() as session:
            session.add(db.Attachment(id=key, name="恢复.txt", media_type="text/plain", width=0, height=0))
            session.flush()
            session.add(db.OfficeFile(id=key, size=1, status="parsing"))
            session.commit()
    monkeypatch.setattr(data_transfer, "apply_pending", restored)
    monkeypatch.setattr(office, "launch_parse", lambda *_: None)
    with TestClient(main.app, headers={"Authorization": "Bearer " + config.AUTH_TOKEN}) as client:
        assert client.get(f"{API}/files/{key}").json()["file_status"] == "failed"
        assert client.post(f"{API}/files/{key}/retry").json()["file_status"] == "queued"


def test_previous_export_schema_can_be_upgraded_in_staging(client, tmp_path):
    stage = tmp_path / "previous-export"
    stage.mkdir()
    (stage / "manifest.json").write_text('{"format":"xiaoxi-data","version":1,"schema":"0016"}', encoding="utf-8")
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    root = Path(__file__).resolve().parents[1]
    migration = Config(str(root / "alembic.ini"))
    migration.set_main_option("script_location", str(root / "migrations"))
    migration.set_main_option("sqlalchemy.url", "sqlite:///" + (stage / "bai.sqlite").as_posix())
    command.upgrade(migration, "0016")
    assert data_transfer.validate(stage)["counts"]["conversations"] == 0
    with data_transfer.connect(stage / "bai.sqlite") as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("0019",)


@pytest.mark.asyncio
async def test_failed_repractice_reopens_completed_course(monkeypatch):
    with db.Session() as session:
        goal = db.Goal(title="课程", objective="掌握", foundation="基础", status="completed")
        session.add(goal)
        session.flush()
        node = db.KnowledgeNode(goal_id=goal.id, ordinal=0, module="模块", title="知识点", objective="目标", status="passed")
        session.add(node)
        session.flush()
        lesson = db.Lesson(node_id=node.id, content="讲解", exercise="练习", criteria="标准", graph_thread_id=db.uid())
        session.add(lesson)
        session.commit()
        goal_id, node_id, lesson_id = goal.id, node.id, lesson.id
    async def feedback(*_, **kwargs):
        return schemas.Feedback(passed=False, explanation="仍需练习", strengths=[], gaps=["缺口"], next_step="重练", evidence="文字")
    monkeypatch.setattr(provider, "ask_json", feedback)
    await learning.assess({"node_id": node_id, "lesson_id": lesson_id, "submission": {"submission_id": db.uid(), "answer": "作答"}})
    with db.Session() as session:
        assert session.get(db.Goal, goal_id).status == "active"
        assert session.get(db.KnowledgeNode, node_id).status == "needs_practice"
