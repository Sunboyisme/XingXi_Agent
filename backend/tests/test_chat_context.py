import asyncio
import json

import pytest
from app import context, db, model_profiles, provider
from langchain_core.messages import AIMessage, AIMessageChunk
from sqlalchemy import select

from .test_app import API, wait_run


def seed(count=14):
    with db.Session() as session:
        conversation = db.Conversation()
        session.add(conversation)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id)
        session.add(run)
        for i in range(count):
            session.add(
                db.Message(
                    conversation_id=conversation.id,
                    role="user" if i % 2 == 0 else "assistant",
                    content=f"记录{i}：" + "约定" * 100,
                )
            )
        config = model_profiles.resolve(session.get(db.Settings, "local"))
        session.commit()
        return run.id, conversation.id, config


@pytest.mark.asyncio
async def test_summary_incremental_originals_retained_and_searchable(
    configured, monkeypatch
):
    run, conversation, config = seed()
    calls = []

    class Summarizer:
        async def ainvoke(self, messages):
            calls.append(json.loads(messages[-1].content))
            return AIMessage(content="保留用户约定；当前任务尚未验收，不能打包。")

    monkeypatch.setattr(context, "SOFT_TOKENS", 500)
    monkeypatch.setattr(provider, "model", lambda value: Summarizer())
    summary, records = await context.prepare(run, conversation, config)
    assert "不能打包" in summary and len(records) == 8
    with db.Session() as session:
        checkpoint = session.get(db.ConversationSummary, conversation)
        first_cursor = checkpoint.through_message_id
        assert len(list(session.scalars(select(db.Message)))) == 14
        session.add(
            db.Message(
                conversation_id=conversation, role="user", content="新增约定" * 100
            )
        )
        session.commit()
    await context.prepare(run, conversation, config)
    assert calls[-1]["previous_summary"] == summary
    assert first_cursor not in calls[-1]["messages"]
    assert context.search_history(conversation, "约定")
    assert not context.search_history("unrelated-conversation", "约定")


@pytest.mark.asyncio
async def test_summary_failure_preserves_checkpoint_and_cancels_atomically(
    configured, monkeypatch
):
    run, conversation, config = seed()
    with db.Session() as session:
        records = list(
            session.scalars(
                select(db.Message).order_by(db.Message.created_at, db.MESSAGE_ORDER)
            )
        )
        session.add(
            db.ConversationSummary(
                conversation_id=conversation,
                content="原摘要",
                through_message_id=records[0].id,
            )
        )
        session.commit()

    class Broken:
        async def ainvoke(self, _):
            raise RuntimeError("synthetic failure")

    monkeypatch.setattr(context, "SOFT_TOKENS", 10)
    monkeypatch.setattr(context, "HARD_TOKENS", 1000)
    monkeypatch.setattr(provider, "model", lambda value: Broken())
    summary, kept = await context.prepare(run, conversation, config)
    assert summary == "原摘要" and kept[-1].id == records[-1].id
    with db.Session() as session:
        assert (
            session.get(db.ConversationSummary, conversation).through_message_id
            == records[0].id
        )
        assert any(
            e.data["status"] == "degraded" for e in session.scalars(select(db.RunEvent))
        )

    class Cancelled:
        async def ainvoke(self, _):
            raise asyncio.CancelledError()

    monkeypatch.setattr(provider, "model", lambda value: Cancelled())
    with pytest.raises(asyncio.CancelledError):
        await context.prepare(run, conversation, config)
    with db.Session() as session:
        assert session.get(db.ConversationSummary, conversation).content == "原摘要"


@pytest.mark.asyncio
async def test_latest_message_not_silently_cut(configured, monkeypatch):
    run, conversation, config = seed(1)
    monkeypatch.setattr(context, "HARD_TOKENS", 20)
    with pytest.raises(provider.ConfigurationError, match="缩短"):
        await context.prepare(run, conversation, config)


def test_reasoning_content_blocks_and_text_are_separate():
    message = AIMessageChunk(
        content=[
            {"type": "reasoning", "reasoning": "公开的推理片段"},
            {"type": "text", "text": "正文"},
        ]
    )
    assert context.reasoning_text(message) == "公开的推理片段"
    assert context.plain_text(message.content) == "正文"


def test_reasoning_stream_tool_rounds_and_history(configured, monkeypatch):
    from . import mock_provider

    original = mock_provider.reply
    monkeypatch.setattr(
        mock_provider,
        "reply",
        lambda body: {**original(body), "reasoning_content": "本地模拟思考片段"},
    )
    conversation = configured.post(API + "/conversations", json={}).json()["id"]
    result = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation}/messages",
            json={"content": "帮我计算 1+1"},
        ),
    )
    assert result["status"] == "completed", result
    messages = configured.get(f"{API}/conversations/{conversation}/messages").json()
    assert messages[-1]["reasoning"].count("本地模拟思考片段") == 2
    assert messages[-1]["run_id"] == result["id"]
    events = configured.get(f"{API}/runs/{result['id']}/tools").json()
    assert len([e for e in events if e["kind"] == "reasoning"]) == 2
    assert "provider_context" not in messages[-1]


def test_duplicate_active_turn_is_rejected(configured, monkeypatch):
    import time

    from . import mock_provider

    original = mock_provider.reply

    def slow(body):
        time.sleep(0.3)
        return original(body)

    monkeypatch.setattr(mock_provider, "reply", slow)
    conversation = configured.post(API + "/conversations", json={}).json()["id"]
    first = configured.post(
        f"{API}/conversations/{conversation}/messages", json={"content": "你好"}
    )
    assert (
        configured.post(
            f"{API}/conversations/{conversation}/messages", json={"content": "重复"}
        ).status_code
        == 409
    )
    assert (
        configured.post(f"{API}/conversations/{conversation}/retry").status_code == 409
    )
    assert wait_run(configured, first)["status"] == "completed"
