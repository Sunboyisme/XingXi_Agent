"""Historical facts need current authorization and original user provenance.

These regression cases are source only until the user requests a test run.
"""

import json

import pytest

from app import context, db, memory, tools


def history_turn():
    with db.Session() as session:
        conversation = db.Conversation(title="历史记忆来源")
        session.add(conversation)
        session.flush()
        records = []
        for role, text in [
            ("user", "福袋的左眼做过手术，睡觉时眼睑闭不上。"),
            ("user", "上周测眼压正常，医生说等猫癣好了再处理。"),
            ("assistant", "可以考虑提前复诊，这只是建议。"),
            ("user", "帮我把福袋现在的信息记下吧"),
        ]:
            record = db.Message(conversation_id=conversation.id, role=role, content=text)
            session.add(record)
            session.flush()
            records.append(record)
        run = db.Run(kind="chat", conversation_id=conversation.id,
                     source_message_id=records[-1].id)
        session.add(run)
        session.commit()
        return run.id, conversation.id, [(row.id, row.content) for row in records]


def test_history_summary_preserves_authorization_provenance_and_undo(client):
    run_id, conversation_id, records = history_turn()
    remember = next(item for item in tools.build_tools(run_id, conversation_id) if item.name == "remember")
    arguments = {
        "content": "福袋左眼术后睡觉时眼睑闭不上；用户说上周眼压正常，医生建议猫癣好后再处理。",
        "category": "fact", "risk": "sensitive", "explicit_request": True,
        "evidence": records[-1][1],
        "source_quotes": [{"message_id": key, "quote": text} for key, text in records[:2]],
    }
    result = json.loads(remember.invoke(arguments))
    assert result["state"] == "confirmed" and result["changed"]
    saved = client.get("/api/v1/memories").json()[0]
    assert saved["source_message_id"] == records[-1][0]
    assert all(text in saved["evidence"] and key in saved["evidence"]
               for key, text in [*records[:2], records[-1]])
    assert "提前复诊" not in saved["content"]
    assert not json.loads(remember.invoke(arguments))["changed"]
    memory.undo(result["change_id"])
    assert "skipped" in json.loads(remember.invoke(arguments))


@pytest.mark.parametrize("kind", ["assistant", "other_conversation", "future", "false_quote", "no_consent"])
def test_history_rejects_untrusted_or_unauthorized_sources(client, kind):
    run_id, conversation_id, records = history_turn()
    source_id, quote = records[0]
    with db.Session() as session:
        if kind == "assistant":
            source_id, quote = records[2]
        elif kind in ("other_conversation", "future"):
            target_id = conversation_id
            if kind == "other_conversation":
                other = db.Conversation(title="另一个会话")
                session.add(other)
                session.flush()
                target_id = other.id
            source = db.Message(conversation_id=target_id, role="user", content=quote)
            session.add(source)
            session.flush()
            source_id = source.id
        elif kind == "false_quote":
            quote = "医生已经确认恢复正常。"
        session.commit()
    result = memory.save_from_chat(run_id, conversation_id, content="福袋的健康记录",
        explicit_request=kind != "no_consent", evidence=records[-1][1],
        source_quotes=[{"message_id": source_id, "quote": quote}])
    assert "error" in result and not result["changed"]
    assert client.get("/api/v1/memories").json() == []


def test_existing_historical_quote_can_be_resolved_and_search_filters_user(client):
    run_id, conversation_id, records = history_turn()
    result = memory.save_from_chat(run_id, conversation_id, content="福袋左眼术后睡觉时眼睑闭不上。",
        explicit_request=True, evidence=records[0][1])
    assert result["state"] == "confirmed"
    found = context.search_history(conversation_id, "福袋", role="user")
    assert found and all(item["role"] == "user" for item in found)
