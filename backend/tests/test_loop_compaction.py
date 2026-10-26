"""Tool-loop compaction regressions; execute only with explicit user authorization."""

import asyncio
import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
import pytest
from sqlalchemy import select

from app import context_archive, db, loop_compaction
from .test_complex_tasks import task_records


def exchange(number, content):
    key = f"call-{number}"
    return [AIMessage(content="", tool_calls=[{"id": key, "name": "read_url", "args": {"url": f"https://example.com/{number}"}}]),
            ToolMessage(content=content, tool_call_id=key, name="read_url")]


@pytest.mark.asyncio
async def test_summaries_survive_next_model_round_without_mutating_graph_history(monkeypatch):
    _, _, run_id, _, _ = task_records()
    messages = [HumanMessage(content="分析资料，保留来源")]
    for index in range(5):
        messages.extend(exchange(index, "资料" * 350))
    originals = [message.model_dump() for message in messages]
    compactor = loop_compaction.LoopCompactor(run_id, {"context_tokens": 4096})
    calls = []

    async def summarize(*args):
        calls.append(args)
        return "前三份资料已读取，尚未生成文件。", False

    monkeypatch.setattr(compactor, "summarize", summarize)
    result = await compactor.prepare(messages, 100, 3072)
    assert result[0] is messages[0]
    assert result[-4:] == messages[-4:]
    assert len(result) < len(messages)
    assert [message.model_dump() for message in messages] == originals
    assert await compactor.prepare(messages, 100, 3072) == result
    assert len(calls) == 1
    with db.Session() as session:
        archives = session.scalars(select(db.RunEvent).where(db.RunEvent.kind == context_archive.ARCHIVE_KIND)).all()
        assert len(archives) == 1
        assert archives[0].data["messages"] == [message.model_dump(mode="json") for message in messages[1:-4]]


def test_parallel_tool_calls_and_incomplete_groups_are_never_split():
    human = HumanMessage(content="当前授权")
    call = AIMessage(content="", tool_calls=[{"id": key, "name": "calculate", "args": {}} for key in ("a", "b")])
    result_a = ToolMessage(content="1", tool_call_id="a")
    result_b = ToolMessage(content="2", tool_call_id="b")
    values = [human, call, result_a]
    entries = [loop_compaction.Entry(value, index, index + 1) for index, value in enumerate(values)]
    assert loop_compaction.completed_groups(entries) == []
    entries.append(loop_compaction.Entry(result_b, 3, 4))
    assert loop_compaction.completed_groups(entries) == [(1, 4)]
    entries.append(loop_compaction.Entry(ToolMessage(content="重复回执", tool_call_id="b"), 4, 5))
    assert loop_compaction.completed_groups(entries) == []


@pytest.mark.asyncio
async def test_failed_summary_falls_back_to_durable_scoped_originals(monkeypatch):
    _, _, run_id, _, _ = task_records()
    raw = json.dumps({"error": "来源正文不完整", "not_executed": False, "recoverable": True,
                      "content": "原始证据" * 6000}, ensure_ascii=False)
    messages = [HumanMessage(content="核对资料"), *exchange(1, raw)]
    compactor = loop_compaction.LoopCompactor(run_id, {"context_tokens": 4096})

    async def fail(*args):
        raise TimeoutError("摘要服务超时")

    monkeypatch.setattr(compactor, "summarize", fail)
    compacted = await compactor.prepare(messages, 100, 3072)
    assert 100 + sum(map(loop_compaction.message_cost, compacted)) < 3072
    receipt = json.loads(compacted[1].content)
    assert receipt["summary_partial"] is True
    assert receipt["tool_receipts"][0]["error"] == "来源正文不完整"
    assert receipt["tool_receipts"][0]["not_executed"] is False
    reader = context_archive.reader(run_id)
    offset, parts = 0, []
    while offset is not None:
        page = json.loads(await reader.ainvoke({"record_id": receipt["source_record_id"],
                                               "path": "/messages/1/content", "offset": offset, "count": 4000}))
        parts.append(page["content"])
        offset = page["next_offset"]
    assert "".join(parts) == raw
    _, _, foreign_run, _, _ = task_records()
    rejected = json.loads(await context_archive.reader(foreign_run).ainvoke({"record_id": receipt["source_record_id"]}))
    assert rejected["not_executed"] is True and "不属于" in rejected["error"]


@pytest.mark.asyncio
async def test_cancelled_summary_keeps_originals_without_installing_replacement(monkeypatch):
    _, _, run_id, _, _ = task_records()
    messages = [HumanMessage(content="停止前的请求"), *exchange(1, "工具原文" * 4000)]
    compactor = loop_compaction.LoopCompactor(run_id, {"context_tokens": 4096})

    async def cancel(*args):
        raise asyncio.CancelledError()

    monkeypatch.setattr(compactor, "summarize", cancel)
    with pytest.raises(asyncio.CancelledError):
        await compactor.prepare(messages, 100, 3072)
    assert compactor.replacements == []
    with db.Session() as session:
        archive = session.scalar(select(db.RunEvent).where(db.RunEvent.kind == context_archive.ARCHIVE_KIND))
        assert archive.data["messages"][1]["content"] == messages[-1].content


@pytest.mark.asyncio
async def test_summary_calls_have_bounded_input_and_mark_unseen_remainder(monkeypatch):
    calls = []

    class Model:
        async def ainvoke(self, messages):
            calls.append(messages)
            assert sum(map(loop_compaction.message_cost, messages)) <= 3072 - 128
            return AIMessage(content="已读取部分来源，需按编号继续核对。")

    monkeypatch.setattr(loop_compaction.provider, "model", lambda config: Model())
    compactor = loop_compaction.LoopCompactor("unused", {"context_tokens": 4096})
    values = exchange(1, "长正文" * 30000)
    entries = [loop_compaction.Entry(value, index, index + 1) for index, value in enumerate(values)]
    summary, partial = await compactor.summarize(entries, "保留准确数字", 3072, 384)
    assert summary and partial and len(calls) == 4


def test_archive_originals_are_not_broadcast_in_run_event_stream(client):
    _, _, run_id, _, _ = task_records()
    context_archive.save(run_id, [HumanMessage(content="不应在事件流中传输的完整原文")])
    with db.Session() as session:
        session.get(db.Run, run_id).status = "completed"
        session.add(db.RunEvent(run_id=run_id, kind="context", data={"status": "compacted"}))
        session.commit()
    response = client.get(f"/api/v1/runs/{run_id}/events")
    assert response.status_code == 200
    assert "compacted" in response.text
    assert "完整原文" not in response.text and "context_archive" not in response.text


@pytest.mark.asyncio
async def test_latest_explicit_archive_page_is_kept_out_of_compression(monkeypatch):
    _, _, run_id, _, _ = task_records()
    messages = [HumanMessage(content="核对原文"), *exchange(1, "之前资料" * 3000),
                AIMessage(content="", tool_calls=[{"id": "read", "name": "read_context_record", "args": {}}]),
                ToolMessage(content='{"content":"本次明确请求的原文","next_offset":200}', tool_call_id="read")]
    compactor = loop_compaction.LoopCompactor(run_id, {"context_tokens": 4096})

    async def summarize(*args):
        return "旧资料已归档，接着核对本次读取内容。", False

    monkeypatch.setattr(compactor, "summarize", summarize)
    result = await compactor.prepare(messages, 100, 3072)
    assert result[-2:] == messages[-2:]
    assert json.loads(result[1].content)["source_record_id"].startswith("context:")
