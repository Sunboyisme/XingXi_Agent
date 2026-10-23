import asyncio
import io
import time
from datetime import datetime, timedelta, timezone
from PIL import Image
import pytest
from app import db, main, config, provider, reminders, schemas
from fastapi.testclient import TestClient

API = "/api/v1"


def wait_run(client, response):
    assert response.status_code == 200, response.text
    run_id = response.json()["id"]
    for _ in range(300):
        value = client.get(f"{API}/runs/{run_id}").json()
        if value["status"] not in ("queued", "running"):
            return value
        time.sleep(0.02)
    raise AssertionError("run did not finish")


def course(client, title="学习前端"):
    goal = client.post(
        API + "/learning/goals",
        json={"title": title, "objective": "能完成一个小实践", "foundation": "零基础"},
    ).json()
    run = wait_run(client, client.post(f"{API}/learning/goals/{goal['id']}/plan"))
    assert run["status"] == "completed", run.get("error")
    return client.get(f"{API}/learning/goals/{goal['id']}").json()


def test_auth_and_missing_provider(client):
    assert client.get(API + "/health", headers={"Authorization": ""}).status_code == 200
    assert (
        client.get(API + "/memories", headers={"Authorization": ""}).status_code == 401
    )
    conv = client.post(API + "/conversations", json={}).json()
    response = client.post(
        f"{API}/conversations/{conv['id']}/messages", json={"content": "你好"}
    )
    assert response.status_code == 400
    assert client.get(f"{API}/conversations/{conv['id']}/messages").json() == []


def test_settings_secrets_not_returned_and_validation(configured):
    text = configured.get(API + "/settings").text
    assert "synthetic-key" not in text
    assert configured.get(API + "/settings").json()["model_configured"] is True
    assert configured.post(API + "/settings/test").status_code == 200
    assert (
        configured.put(
            API + "/settings",
            json={
                "model_url": "https://user:password@example.com/v1",
                "model_name": "test",
            },
        ).status_code
        == 422
    )
    assert (
        configured.post(
            API + "/reminders",
            json={
                "title": "test",
                "due_at": "2030-01-01T00:00:00Z",
                "timezone": "Invalid/Zone",
            },
        ).status_code
        == 422
    )


def test_memory_confirm_edit_delete_and_restart(client):
    memory = client.post(
        API + "/memories", json={"content": "我正在学习前端", "state": "candidate"}
    ).json()
    changed = client.put(
        f"{API}/memories/{memory['id']}",
        json={"content": "我正在学习 React", "state": "confirmed"},
    ).json()
    assert changed["state"] == "confirmed"
    assert "React" in client.get(API + "/memories").json()[0]["content"]
    # A new session reads persisted state rather than React state.
    with db.Session() as session:
        assert session.get(db.Memory, memory["id"]).state == "confirmed"
    assert client.delete(f"{API}/memories/{memory['id']}").status_code == 200
    assert client.get(API + "/memories").json() == []


def test_reminder_dedup_cancel_and_recurrence(client):
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    value = client.post(
        API + "/reminders", json={"title": "复习", "due_at": yesterday.isoformat()}
    ).json()
    client.portal.call(reminders.tick)
    client.portal.call(reminders.tick)
    notes = client.get(API + "/notifications").json()
    assert len(notes) == 1 and notes[0]["overdue"]
    client.post(f"{API}/notifications/{notes[0]['id']}/ack?read=true")
    assert (
        client.post(f"{API}/notifications/{notes[0]['id']}/ack").json()["status"]
        == "read"
    )
    daily = client.post(
        API + "/reminders",
        json={
            "title": "每日学习",
            "due_at": yesterday.isoformat(),
            "recurrence": "daily",
        },
    ).json()
    client.portal.call(reminders.tick)
    daily_now = next(
        x for x in client.get(API + "/reminders").json() if x["id"] == daily["id"]
    )
    assert datetime.fromisoformat(daily_now["due_at"]) > datetime.now(timezone.utc)
    client.post(f"{API}/reminders/{daily['id']}/action", json={"action": "cancel"})
    assert not any(
        n["reminder_id"] == daily["id"]
        for n in client.get(API + "/notifications?pending_only=true").json()
    )
    client.put(
        f"{API}/reminders/{value['id']}",
        json={
            "title": "稍后复习",
            "due_at": (yesterday + timedelta(days=3)).isoformat(),
        },
    )
    client.portal.call(reminders.tick)
    assert len(client.get(API + "/notifications").json()) == 1


def test_recurrence_keeps_local_hour_over_dst():
    result = reminders.next_occurrence(
        "2026-03-07T14:00:00+00:00",
        "daily",
        "America/New_York",
        datetime(2026, 3, 7, 15, tzinfo=timezone.utc),
    )
    assert result.startswith("2026-03-08T13:00:00")


def test_images_are_validated_stripped_and_guarded(client):
    assert (
        client.post(
            API + "/attachments",
            files={"file": ("fake.png", b"not a picture", "image/png")},
        ).status_code
        == 422
    )
    stream = io.BytesIO()
    Image.new("RGB", (3000, 1000), "blue").save(stream, "PNG")
    response = client.post(
        API + "/attachments",
        files={"file": ("test.png", stream.getvalue(), "image/png")},
    )
    assert response.status_code == 200
    picture = response.json()
    assert picture["width"] == 2048 and picture["media_type"] == "image/jpeg"
    with pytest.raises(provider.ConfigurationError):
        provider.user_content("图片", [picture["id"]])
    assert (
        client.get(f"{API}/attachments/{picture['id']}/content").headers["content-type"]
        == "image/jpeg"
    )


@pytest.mark.parametrize("topic", ["学习前端", "学习做饭", "学习养猫", "学习游戏策略"])
def test_domain_independent_course_and_no_overwrite(configured, topic):
    goal = course(configured, topic)
    assert len(goal["nodes"]) == 3
    assert all(topic in n["title"] for n in goal["nodes"])
    assert goal["nodes"][1]["prerequisites"] == [goal["nodes"][0]["id"]]
    assert configured.post(f"{API}/learning/goals/{goal['id']}/plan").status_code == 409


def test_invalid_course_is_atomic(configured, monkeypatch):
    async def malformed(*_, **__):
        return schemas.CoursePlan.model_validate(
            {
                "overview": "bad",
                "nodes": [
                    {
                        "key": "x",
                        "module": "m",
                        "title": "t",
                        "objective": "o",
                        "prerequisites": ["future"],
                        "exercise_type": "question",
                        "criteria": "c",
                    }
                ]
                * 3,
            }
        )

    monkeypatch.setattr(provider, "ask_json", malformed)
    goal = configured.post(API + "/learning/goals", json={"title": "测试", "objective": "掌握测试主题", "foundation": "零基础"}).json()
    run = wait_run(
        configured, configured.post(f"{API}/learning/goals/{goal['id']}/plan")
    )
    assert run["status"] == "failed"
    assert configured.get(f"{API}/learning/goals/{goal['id']}").json()["nodes"] == []


def test_tutor_checkpoint_survives_restart(configured):
    goal = course(configured)
    node = goal["nodes"][0]
    run = wait_run(
        configured, configured.post(f"{API}/learning/nodes/{node['id']}/lesson")
    )
    assert run["status"] == "completed"
    lesson = configured.get(f"{API}/learning/nodes/{node['id']}/lesson").json()
    assert lesson["state"] == "awaiting_submission"
    assert (
        configured.post(f"{API}/learning/nodes/{node['id']}/lesson").status_code == 409
    )
    # Fresh application lifespan and a freshly compiled graph load the disk checkpoint.
    with TestClient(main.app) as restarted:
        restarted.headers["Authorization"] = "Bearer " + config.AUTH_TOKEN
        run = wait_run(
            restarted,
            restarted.post(
                f"{API}/learning/lessons/{lesson['id']}/submit",
                json={
                    "submission_id": "first",
                    "answer": "概念描述事物，比如前端页面的结构。",
                },
            ),
        )
        assert run["status"] == "completed", run
        updated = restarted.get(f"{API}/learning/goals/{goal['id']}").json()
        assert updated["nodes"][0]["status"] == "passed"
        assert (
            restarted.post(
                f"{API}/learning/lessons/{lesson['id']}/submit",
                json={"submission_id": "first", "answer": "again"},
            ).status_code
            == 409
        )


def test_failed_assessment_can_retry(configured, monkeypatch):
    goal = course(configured)
    node = goal["nodes"][0]
    wait_run(configured, configured.post(f"{API}/learning/nodes/{node['id']}/lesson"))
    lesson = configured.get(f"{API}/learning/nodes/{node['id']}/lesson").json()
    original = provider.ask_json

    async def fail(*_, **__):
        raise RuntimeError("temporary outage")

    monkeypatch.setattr(provider, "ask_json", fail)
    failed = wait_run(
        configured,
        configured.post(
            f"{API}/learning/lessons/{lesson['id']}/submit",
            json={"submission_id": "fail", "answer": "回答"},
        ),
    )
    assert failed["status"] == "failed"
    assert (
        configured.get(f"{API}/learning/nodes/{node['id']}/lesson").json()["state"]
        == "awaiting_submission"
    )
    monkeypatch.setattr(provider, "ask_json", original)
    retried = wait_run(
        configured,
        configured.post(
            f"{API}/learning/lessons/{lesson['id']}/submit",
            json={"submission_id": "retry", "answer": "我不会"},
        ),
    )
    assert retried["status"] == "completed", retried
    assert (
        configured.get(f"{API}/learning/goals/{goal['id']}").json()["nodes"][0][
            "status"
        ]
        == "needs_practice"
    )


def test_skip_records_unverified_and_completes(configured):
    goal = course(configured)
    for node in goal["nodes"]:
        assert (
            configured.post(f"{API}/learning/nodes/{node['id']}/skip").json()["status"]
            == "skipped"
        )
    assert (
        configured.get(f"{API}/learning/goals/{goal['id']}").json()["status"]
        == "completed"
    )


def test_real_langchain_tool_loop_and_stream(configured):
    conv = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conv['id']}/messages",
            json={"content": "请记住我喜欢先看例子"},
        ),
    )
    assert run["status"] == "completed", run.get("error")
    assert run["result"]["content"] == "工具已经执行，结果已保存。"
    assert run["usage"]["total_tokens"] > 0
    memories = configured.get(API + "/memories").json()
    assert len(memories) == 1 and memories[0]["state"] == "confirmed"
    events = configured.get(f"{API}/runs/{run['id']}/events").text
    assert '"kind": "tool"' in events and '"kind": "delta"' in events


def test_conversation_creates_learning_framework_when_explicit(configured):
    conv = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conv['id']}/messages",
            json={"content": "我想学习做饭，零基础，能独立做晚餐"},
        ),
    )
    assert run["status"] == "completed", run.get("error")
    goals = configured.get(API + "/learning/goals").json()
    assert (
        len(goals) == 1
        and goals[0]["title"] == "学习做饭"
        and len(goals[0]["nodes"]) == 3
    )
    import json

    events = [
        json.loads(line[6:])
        for line in configured.get(f"{API}/runs/{run['id']}/events").text.splitlines()
        if line.startswith("data: ")
    ]
    text = "".join(
        event["data"].get("text", "") for event in events if event["kind"] == "delta"
    )
    assert "测试课程" not in text, (
        "Internal structured course JSON must not appear in chat text"
    )


def test_cancel_and_retry_does_not_duplicate_user_message(configured, monkeypatch):
    from app import agent

    async def slow(*_):
        await asyncio.sleep(30)
        return {}

    monkeypatch.setattr(agent, "chat", slow)
    conv = configured.post(API + "/conversations", json={}).json()
    response = configured.post(
        f"{API}/conversations/{conv['id']}/messages", json={"content": "你好"}
    )
    run_id = response.json()["id"]
    assert (
        configured.post(
            f"{API}/conversations/{conv['id']}/messages", json={"content": "第二条"}
        ).status_code
        == 409
    )
    configured.post(f"{API}/runs/{run_id}/cancel")
    run = wait_run(configured, response)
    assert run["status"] == "cancelled"

    async def quick(*_):
        return {"ok": True}

    monkeypatch.setattr(agent, "chat", quick)
    assert (
        wait_run(
            configured, configured.post(f"{API}/conversations/{conv['id']}/retry")
        )["status"]
        == "completed"
    )
    assert len(configured.get(f"{API}/conversations/{conv['id']}/messages").json()) == 1
