"""Regression sources for the interaction review; execution requires user request."""

from datetime import datetime

from app import agent, db, plans, provider, runs
from .test_app import API


def test_interrupted_text_survives_reload_and_retry_uses_current_connection(client, monkeypatch):
    monkeypatch.setattr(provider, "model", lambda *_: object())
    monkeypatch.setattr(runs, "launch", lambda *_: None)
    profile = {"id": "review", "provider_type": "custom", "label": "测试连接",
               "model_url": "https://old.example/v1", "api_key": "synthetic",
               "models": [{"name": "old", "thinking_mode": "none"}], "default_model": "old"}
    assert client.put(API + "/settings", json={"providers": [profile], "default_provider": "review"}).status_code == 200
    conversation = client.post(API + "/conversations", json={}).json()["id"]
    first = client.post(f"{API}/conversations/{conversation}/messages", json={"content": "解释这个概念"}).json()
    with db.Session() as session:
        session.get(db.Run, first["id"]).status = "cancelled"
        session.commit()
    runs.emit(first["id"], "delta", {"text": "已经显示的"})
    runs.emit(first["id"], "delta", {"text": "半段回答"})
    agent.persist_incomplete_reply(first["id"])
    agent.persist_incomplete_reply(first["id"])
    messages = client.get(f"{API}/conversations/{conversation}/messages").json()
    assert len(messages) == 2
    assert messages[-1]["content"] == "已经显示的半段回答"
    assert messages[-1]["run_status"] == "cancelled"

    updated = {**profile, "model_url": "https://new.example/v1", "models": [
        {"name": "new", "thinking_mode": "none"}], "default_model": "new"}
    assert client.put(API + "/settings", json={"providers": [updated]}).status_code == 200
    retry = client.post(f"{API}/conversations/{conversation}/retry", json={
        "model_selection": {"provider_id": "review", "model_name": "new", "thinking_enabled": False},
    })
    assert retry.status_code == 200, retry.text
    with db.Session() as session:
        retried = session.get(db.Run, retry.json()["id"])
        assert retried.model_config["model_url"] == "https://new.example/v1"
        assert retried.model_config["model_name"] == "new"
        assert retried.source_message_id == messages[0]["id"]
    assert len(client.get(f"{API}/conversations/{conversation}/messages").json()) == 2


def test_answer_reset_does_not_save_unverified_image_narration():
    with db.Session() as session:
        conversation = db.Conversation(title="图片")
        session.add(conversation)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, status="failed")
        session.add(run)
        session.commit()
        run_id = run.id
    runs.emit(run_id, "delta", {"text": "即将生成图片"})
    runs.emit(run_id, "answer", {"text": ""})
    agent.persist_incomplete_reply(run_id)
    with db.Session() as session:
        assert not session.query(db.Message).filter_by(run_id=run_id).first()


def test_cancel_one_moved_occurrence_stops_only_its_reminder_and_restore_keeps_move(client):
    original = plans.PlanWrite(title="每日会议", start="2030-11-01T09:00:00+08:00",
                              end="2030-11-01T10:00:00+08:00", recurrence="daily",
                              repeat_count=3, reminder_enabled=True, reminder_offsets=[0])
    root = plans.create_events([original])[0]
    events = plans.list_events("2030-11-01", "2030-11-10")
    key = events[0]["occurrence_start"]
    moved = {**original.model_dump(), "start": "2030-11-05T09:00:00+08:00",
             "end": "2030-11-05T10:00:00+08:00", "recurrence": "none", "repeat_count": None,
             "scope": "this", "occurrence_start": key}
    plans.update_event(root["id"], plans.PlanUpdate(**moved))
    with db.Session() as session:
        note = db.Notification(reminder_id=root["reminder_id"], plan_id=root["id"],
                               plan_occurrence_start=key, occurrence_at="2030-11-05T01:00:00+00:00",
                               title="每日会议", body="", status="snoozed")
        session.add(note)
        session.commit()
        note_id = note.id
    response = client.post(f"{API}/plans/{root['id']}/action", json={"action": "cancel_occurrence", "occurrence_start": key})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert response.json()["is_exception"]
    assert len([event for event in plans.list_events("2030-11-01", "2030-11-10") if event["status"] == "planned"]) == 2
    with db.Session() as session:
        assert session.get(db.Notification, note_id).status == "cancelled"
        following = plans.recurrence.next_due(session, session.get(db.CalendarEvent, root["id"]), 0,
                                              datetime.fromisoformat("2030-11-04T00:00:00+00:00"))
        assert following is None
    assert client.post(f"{API}/notifications/{note_id}/snooze", json={"minutes": 10}).status_code == 409
    restored = client.post(f"{API}/plans/{root['id']}/action", json={"action": "restore", "occurrence_start": key})
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "planned"
    assert restored.json()["start"].startswith("2030-11-05T01:00")
    with db.Session() as session:
        following = plans.recurrence.next_due(session, session.get(db.CalendarEvent, root["id"]), 0,
                                              datetime.fromisoformat("2030-11-04T00:00:00+00:00"))
        assert following[0] == key
