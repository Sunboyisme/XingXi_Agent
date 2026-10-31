"""Calendar cost/stream regressions; execute only on explicit user request."""

import json

import httpx
import pytest
from app import (
    agent,
    calendar_policy,
    complex_tasks,
    db,
    model_budget,
    model_profiles,
    provider,
    task_context,
    task_results,
    usage_cost,
)
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from .test_complex_tasks import task_records
from .test_eval_execution import request_run


@pytest.mark.parametrize("text,expected", [
    ("帮我安排一下这个计划，周日的跳过，从二号开始", True),
    ("把图片里的日程加到日历", True),
    ("删除明天的日历安排", True),
    ("帮我生成学习计划文档并安排提醒", False),
    ("继续此任务。", False),
    ("设计一个学习路线", False),
])
def test_calendar_batches_do_not_need_durable_task_planning(text, expected):
    assert calendar_policy.direct_request(text) is expected


async def test_attached_calendar_batch_skips_route_and_plan_models(monkeypatch):
    conversation_id, run_id = request_run("帮我安排一下这个计划，周日的跳过，从二号开始")
    with db.Session() as session:
        run = session.get(db.Run, run_id)
        run.model_config = {"provider_id": "fixture", "model_name": "fixture"}
        session.get(db.Message, run.source_message_id).attachment_ids = ["original-image"]
        session.commit()
    calls = []

    async def chat(*args, **kwargs):
        calls.append((args, kwargs))
        return {"content": "已按查询结果处理", "conversation_id": conversation_id}

    async def no_classifier(*args, **kwargs):
        pytest.fail("普通日历流程不能调用路由或复杂任务规划模型")

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(provider, "ask_json", no_classifier)
    with model_budget.scope():
        await complex_tasks.dispatch(run_id, conversation_id)
        assert model_budget.current.get().max_requests == 10
    assert len(calls) == 1 and not calls[0][1].get("task_instructions")
    with db.Session() as session:
        assert session.scalar(select(db.ComplexTask)) is None
        assert session.get(db.Run, run_id).task_id is None


def test_calendar_receipts_keep_all_rows_and_the_durable_original():
    rows = [{"id": f"plan-{index}", "title": f"任务{index}", "start": "2030-11-02", "end": "2030-11-03",
             "all_day": True, "status": "planned", "timezone": "Asia/Shanghai", "recurrence": "none",
             "reminder_enabled": False, "notes": "", "occurrence_start": "2030-11-02",
             "series_revision": "revision", "reminder_id": "internal", "series_title": "冗余" * 100}
            for index in range(13)]
    original = json.dumps(rows, ensure_ascii=False)
    for value in (rows, {"value": rows}):
        receipt = task_results.receipt(value, "record", limit=1600)
        response = json.loads(task_results.tool_response(value, "record", "list_plans"))
        for compact in (receipt, response):
            assert compact["count"] == 13 and compact["all_rows_included"]
            assert [item["id"] for item in compact["plans"]] == [item["id"] for item in rows]
            assert all(item["occurrence_start"] == "2030-11-02" for item in compact["plans"])
            assert "truncated" not in compact
        assert len(json.dumps(response, ensure_ascii=False)) < len(original)
    assert json.dumps(rows, ensure_ascii=False) == original


async def test_missing_write_replans_once_instead_of_repeating_step_three_times(monkeypatch):
    task_id, step_id, run_id, _, _ = task_records()
    with db.Session() as session:
        step = session.get(db.TaskStep, step_id)
        step.tools = ["create_plans"]
        session.commit()
    chats, plans = [], []

    async def chat(*args, **kwargs):
        chats.append(args)
        return {"content": "查询显示已有相同计划，未重复创建。"}

    async def replan(*args, **kwargs):
        plans.append(kwargs)
        # Keep an invalid requirement to exercise the second-failure stop.

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(complex_tasks, "make_plan", replan)
    monkeypatch.setattr(model_profiles, "resolve", lambda *args: {"provider_id": "fixture", "model_name": "fixture"})
    await complex_tasks.execute(run_id, task_id)
    assert len(chats) == 2 and plans == [{"repair": True}]
    with db.Session() as session:
        assert session.get(db.ComplexTask, task_id).status == "paused"
        assert "已停止自动补做" in session.get(db.ComplexTask, task_id).reason
        assert session.get(db.TaskStep, step_id).status == "pending"


async def test_resuming_old_failed_step_replans_before_another_agent_call(monkeypatch):
    task_id, step_id, run_id, _, _ = task_records()
    with db.Session() as session:
        step = session.get(db.TaskStep, step_id)
        step.tools, step.output = ["create_plans"], {"validation_missing": "尚未调用create_plans"}
        session.commit()
    calls = []

    async def replan(*args, **kwargs):
        calls.append("replan")
        with db.Session() as session:
            task = session.get(db.ComplexTask, task_id)
            task.status, task.reason = "waiting_input", "需确认已有安排是否为同一事项"
            session.commit()

    async def no_repeat(*args, **kwargs):
        pytest.fail("旧的失败创建步骤必须先重新判断，不能直接补做")

    monkeypatch.setattr(agent, "_chat", no_repeat)
    monkeypatch.setattr(complex_tasks, "make_plan", replan)
    monkeypatch.setattr(model_profiles, "resolve", lambda *args: {"provider_id": "fixture", "model_name": "fixture"})
    await complex_tasks.execute(run_id, task_id)
    assert calls == ["replan"]


async def test_budget_blocks_generation_before_the_provider_is_called(monkeypatch):
    seen = []

    async def generate(*args, **kwargs):
        seen.append(args)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="已处理"))])

    monkeypatch.setattr(ChatOpenAI, "_agenerate", generate)
    llm = provider.CompatibleChatModel(model="fixture", api_key="synthetic")
    with model_budget.scope():
        budget = model_budget.current.get()
        budget.max_requests = 1
        await llm.ainvoke([HumanMessage(content="第一次")])
        with pytest.raises(task_context.ModelBudgetExceeded):
            await llm.ainvoke([HumanMessage(content="第二次")])
        assert budget.requests == 1
    assert len(seen) == 1
    assert model_budget.current.get() is None


def test_budget_counts_tools_and_cannot_be_reset_by_switching_purpose():
    from app.usage_cost import scope

    with model_budget.scope():
        budget = model_budget.current.get()
        budget.max_input_tokens = 100
        with scope(purpose="context_compaction"), pytest.raises(task_context.ModelBudgetExceeded):
            model_budget.reserve([HumanMessage(content="请求")], {"tools": [{"description": "参数" * 100}]})
        assert budget.requests == 0
        model_budget.reserve([HumanMessage(content="请求")], {})
        with scope(purpose="complex_task"):
            assert model_budget.current.get() is budget
            assert budget.requests == 1


class Source(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self):
        pass


async def test_sdk_close_after_done_is_completed_and_keeps_usage(monkeypatch):
    finishes = []
    monkeypatch.setattr(usage_cost, "finish", lambda *args: finishes.append(args))
    source = Source([b'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
                     b'data: [DO', b'NE]\r\n\r\n'])
    stream = usage_cost.MeteredStream(source, "call")
    iterator = stream.__aiter__()
    for _ in range(3):
        await anext(iterator)
    # The SDK exits at [DONE], without asking the source for an EOF iteration.
    await stream.aclose()
    await iterator.aclose()
    assert finishes and all(row[2] == "completed" for row in finishes)
    assert finishes[-1][1]["usage"]["prompt_tokens"] == 12


@pytest.mark.parametrize("chunks,expected", [
    ([b'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'], "interrupted"),
    ([b'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n'], "completed"),
    ([b'data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n'], "interrupted"),
])
async def test_stream_completion_requires_terminal_evidence(monkeypatch, chunks, expected):
    finishes = []
    monkeypatch.setattr(usage_cost, "finish", lambda *args: finishes.append(args))
    stream = usage_cost.MeteredStream(Source(chunks), "call")
    async for _ in stream:
        pass
    await stream.aclose()
    assert finishes and all(row[2] == expected for row in finishes)
