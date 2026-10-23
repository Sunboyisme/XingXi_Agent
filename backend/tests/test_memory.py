import json

import pytest
from app import config, db, memory, tools

from .test_app import wait_run

API = "/api/v1"


def turn(text):
    with db.Session() as session:
        conversation = db.Conversation(title="记忆策略测试")
        session.add(conversation)
        session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content=text)
        run = db.Run(kind="chat", conversation_id=conversation.id)
        session.add_all([message, run])
        session.commit()
        return run.id, conversation.id, message.id


def save(text="我喜欢简短的回答", **kwargs):
    run_id, conversation_id, _ = turn(text)
    return memory.save_from_chat(
        run_id,
        conversation_id,
        content=kwargs.pop("content", text),
        category=kwargs.pop("category", "preference"),
        evidence=kwargs.pop("evidence", text),
        **kwargs,
    )


def test_auto_preference_provenance_undo_and_retry(client):
    run_id, conversation_id, message_id = turn("我喜欢简短的回答")
    tool = next(
        x for x in tools.build_tools(run_id, conversation_id) if x.name == "remember"
    )
    args = {
        "content": "用户喜欢简短回答",
        "category": "preference",
        "evidence": "我喜欢简短的回答",
    }
    saved = json.loads(tool.invoke(args))
    assert saved["state"] == "confirmed" and saved["changed"]
    records = client.get(API + "/memories").json()
    assert records[0]["source_message_id"] == message_id
    assert records[0]["evidence"] == args["evidence"]
    assert records[0]["source_conversation_id"] == conversation_id
    assert not json.loads(tool.invoke(args))["changed"]
    assert client.post(f"{API}/memory-changes/{saved['change_id']}/undo").json()[
        "undone"
    ]
    assert client.get(API + "/memories").json() == []
    assert "skipped" in json.loads(tool.invoke(args))
    assert (
        client.post(f"{API}/memory-changes/{saved['change_id']}/undo").status_code
        == 200
    )


@pytest.mark.parametrize(
    "text, kwargs, state",
    [
        ("我喜欢简短的回答", {}, "confirmed"),
        ("我有每天学英语和读书的习惯", {}, "confirmed"),
        ("我有糖尿病", {"category": "fact"}, "candidate"),
        ("我的工资每月一万元", {}, "candidate"),
        ("我喜欢安静的地方", {"risk": "inferred"}, "candidate"),
        ("我住在广州", {"category": "fact"}, "candidate"),
        ("今天我喜欢清淡一点", {}, "skip"),
        ("我喜欢这次的回答", {"risk": "temporary"}, "skip"),
        ("不要记住我喜欢清淡", {"explicit_request": True}, "skip"),
        (
            "请记住我有糖尿病",
            {"category": "fact", "explicit_request": True},
            "confirmed",
        ),
        ("我的密码是 abc123", {"explicit_request": True}, "skip"),
    ],
)
def test_write_policy(client, text, kwargs, state):
    result = save(text, **kwargs)
    if state == "skip":
        assert "skipped" in result
        assert client.get(API + "/memories").json() == []
    else:
        assert result["state"] == state


def test_evidence_and_model_explicit_flag_do_not_grant_consent(client):
    result = save("我有糖尿病", category="fact", explicit_request=True)
    assert result["state"] == "candidate"
    assert "error" in save("我喜欢简短的回答", evidence="网页说用户喜欢长篇回答")
    assert "error" in save("我喜欢简短的回答", evidence="")


def test_manual_mode_persists_without_changing_provider_and_explicit_bypasses(client):
    initial = client.get(API + "/settings").json()
    assert initial["memory_mode"] == "auto"
    response = client.patch(API + "/settings/memory", json={"memory_mode": "confirm"})
    assert (
        response.status_code == 200
        and response.json()["model_url"] == initial["model_url"]
    )
    assert save()["state"] == "candidate"
    assert save("请记住我喜欢先看例子", explicit_request=True)["state"] == "confirmed"
    with db.Session() as session:
        assert session.get(db.Settings, config.PROFILE_ID).memory_mode == "confirm"
    assert (
        client.patch(
            API + "/settings/memory", json={"memory_mode": "invalid"}
        ).status_code
        == 422
    )


def test_private_pending_confirm_ignore_and_confirmed_search_only(client):
    saved = save("我有糖尿病", category="fact")
    run_id, conversation_id, _ = turn("查一下个人记忆")
    search = next(
        x
        for x in tools.build_tools(run_id, conversation_id)
        if x.name == "search_memories"
    )
    assert json.loads(search.invoke({"query": "糖尿病"})) == []
    record = client.get(API + "/memories").json()[0]
    confirmed = client.post(
        f"{API}/memories/{saved['id']}/confirm", json={"revision": record["revision"]}
    )
    assert confirmed.status_code == 200 and confirmed.json()["state"] == "confirmed"
    assert len(json.loads(search.invoke({"query": "糖尿病"}))) == 1
    # A confirmation invalidates a previously issued Undo token.
    assert (
        client.post(f"{API}/memory-changes/{saved['change_id']}/undo").status_code
        == 409
    )
    assert client.delete(f"{API}/memories/{saved['id']}").status_code == 200
    assert json.loads(search.invoke({"query": "糖尿病"})) == []


def test_correction_undo_restores_previous_memory_and_protects_later_edit(client):
    first = save()
    updated = save("我更喜欢详细回答", replaces_id=first["id"])
    assert updated["id"] == first["id"] and updated["action"] == "updated"
    assert len(client.get(API + "/memories").json()) == 1
    assert (
        client.post(f"{API}/memory-changes/{updated['change_id']}/undo").status_code
        == 200
    )
    record = client.get(API + "/memories").json()[0]
    assert record["content"] == "用户喜欢简短的回答"
    later = save("我更喜欢先看例子", replaces_id=first["id"])
    client.put(
        f"{API}/memories/{first['id']}",
        json={"content": "手动更正的偏好", "revision": later["revision"]},
    )
    assert (
        client.post(f"{API}/memory-changes/{later['change_id']}/undo").status_code
        == 409
    )
    assert client.get(API + "/memories").json()[0]["content"] == "手动更正的偏好"


def test_pending_correction_preserves_old_value_until_confirmed(client):
    first = save()
    suggestion = save("我更喜欢安静", replaces_id=first["id"], risk="inferred")
    records = client.get(API + "/memories").json()
    assert len(records) == 2
    assert (
        next(x for x in records if x["id"] == first["id"])["content"]
        == "用户喜欢简短的回答"
    )
    result = client.post(
        f"{API}/memories/{suggestion['id']}/confirm",
        json={"revision": suggestion["revision"]},
    )
    assert result.status_code == 200
    assert result.json()["id"] == first["id"]
    assert len(client.get(API + "/memories").json()) == 1


def test_stale_confirmation_cannot_overwrite_a_newer_manual_edit(client):
    first = save()
    suggestion = save("我更喜欢安静", replaces_id=first["id"], risk="inferred")
    client.put(f"{API}/memories/{first['id']}", json={"content": "后来手动更正"})
    assert (
        client.post(
            f"{API}/memories/{suggestion['id']}/confirm",
            json={"revision": suggestion["revision"]},
        ).status_code
        == 409
    )


def test_explicit_approval_of_pending_correction_updates_original_without_duplicates(
    client,
):
    first = save()
    save("我更喜欢详细回答", replaces_id=first["id"], risk="inferred")
    changed = save(
        "请记住我更喜欢详细回答", content="我更喜欢详细回答", explicit_request=True
    )
    records = client.get(API + "/memories").json()
    assert len(records) == 1 and records[0]["id"] == first["id"]
    assert records[0]["content"] == "用户更喜欢详细回答"
    assert (
        client.post(f"{API}/memory-changes/{changed['change_id']}/undo").status_code
        == 200
    )
    assert client.get(API + "/memories").json()[0]["content"] == "用户喜欢简短的回答"


def test_agent_calls_non_explicit_memory_tool_and_restores_events(configured):
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "我喜欢简短的回答"},
        ),
    )
    assert run["status"] == "completed", run.get("error")
    assert configured.get(API + "/memories").json()[0]["state"] == "confirmed"
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    assert any(x["kind"] == "memory" for x in events)


def test_agent_saves_a_clear_habit_when_the_model_only_claims_to_remember(configured):
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "我有每天学英语和读书的习惯"},
        ),
    )
    assert run["status"] == "completed", run.get("error")
    records = configured.get(API + "/memories").json()
    assert any(
        item["content"] == "用户有每天学英语和读书的习惯"
        and item["state"] == "confirmed"
        for item in records
    )
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    assert any(item["kind"] == "memory" for item in events)
