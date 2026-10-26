"""Isolated simulations for context budgets, tool repair and todo ordering."""
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage, SystemMessage
from sqlalchemy import select

from app import context, context_budget, db, tools, complex_tasks, model_profiles, provider, task_context
from .test_app import API, wait_run
from .test_complex_tasks import task_records


def test_model_context_setting_is_validated_and_resolved(configured):
    profile = configured.get(API + "/settings").json()["providers"][0]
    profile["models"][0]["context_tokens"] = 128000
    saved = configured.put(API + "/settings", json={"providers": [profile], "default_provider": profile["id"]})
    assert saved.status_code == 200
    with db.Session() as session:
        config = model_profiles.resolve(session.get(db.Settings, "local"))
    assert context.limits(config) == (128000, 8192, 119808)
    for invalid in [0, 4095, 2000001, 128000.5]:
        profile["models"][0]["context_tokens"] = invalid
        assert configured.put(API + "/settings", json={"providers": [profile]}).status_code == 422


def test_todo_order_persists_and_rejects_stale_or_cross_profile_ids(client):
    ids = [client.post(API + "/todos", json={"title": name}).json()["id"] for name in ["完成三个节点", "DeepAgent 3day", "微调实践"]]
    desired = ids[::-1]
    assert client.post(API + "/todos/reorder", json={"ids": desired}).status_code == 200
    assert [row["id"] for row in client.get(API + "/todos").json()] == desired
    assert client.post(API + "/todos/reorder", json={"ids": [ids[0], ids[0]]}).status_code == 422
    assert client.post(API + "/todos/reorder", json={"ids": [ids[0], "other-profile"]}).status_code == 409
    client.post(API + f"/todos/{ids[0]}/action", json={"action": "complete"})
    assert client.post(API + "/todos/reorder", json={"ids": desired}).status_code == 409
    assert [row["id"] for row in client.get(API + "/todos").json()] == desired[:-1]


@pytest.mark.asyncio
async def test_small_message_reports_overhead_not_user_error(configured):
    _, _, run_id, _, conversation_id = task_records()
    with pytest.raises(provider.ConfigurationError, match="系统提示"):
        await context.prepare(run_id, conversation_id, {"context_tokens": 4096}, overhead=4000)


@pytest.mark.asyncio
async def test_round_budget_preserves_tool_pairs_and_counts_usage(configured):
    _, _, run_id, _, _ = task_records()
    messages = [HumanMessage(content="旧问" * 3000), AIMessage(content="旧答"), HumanMessage(content="新任务"),
                AIMessage(content="", tool_calls=[{"id": "call1", "name": "calculate", "args": {"expression": "1+1"}}]),
                ToolMessage(content='{"result":2}', tool_call_id="call1")]
    class Request(SimpleNamespace):
        def override(self, **changes):
            return Request(**{**vars(self), **changes})
    request = Request(messages=messages, system_message=SystemMessage(content="系统"), tools=[])
    seen = []
    async def handler(request):
        seen.append(request.messages)
        return "ok"
    middleware = context_budget.ContextBudget(run_id, {"context_tokens": 4096}, 100)
    assert await middleware.awrap_model_call(request, handler) == "ok"
    assert seen[0] == messages[2:]
    request.messages = [HumanMessage(content="新任务"), ToolMessage(content="结果" * 5000, tool_call_id="x")]
    with pytest.raises(provider.ConfigurationError, match="已有操作结果保留"):
        await middleware.awrap_model_call(request, handler)


@pytest.mark.asyncio
async def test_prose_only_step_repairs_with_real_record_tool(configured, monkeypatch):
    from . import mock_provider
    task_id, step_id, run_id, message_id, _ = task_records()
    with db.Session() as session:
        step = session.get(db.TaskStep, step_id)
        step.tools = ["read_task_result"]
        step.instruction = "读取原始用户消息后总结"
        session.commit()
    calls = []
    def reply(body):
        calls.append(body.get("tool_choice"))
        if body["messages"][-1]["role"] == "tool":
            return {"content": "已实际核对原始要求。"}
        choice = body.get("tool_choice")
        if choice:
            return {"content": None, "tool_calls": [{"id": "read1", "type": "function", "function": {
                "name": "read_task_result", "arguments": json.dumps({"record_id": message_id})}}]}
        return {"content": "我已经核对了原始要求。"}
    async def review(schema, *args, **kwargs):
        assert schema is complex_tasks.Review
        return complex_tasks.Review(complete=True, summary="已核对原始要求")
    monkeypatch.setattr(mock_provider, "reply", reply)
    monkeypatch.setattr(provider, "ask_json", review)
    await complex_tasks.execute(run_id, task_id)
    with db.Session() as session:
        assert session.get(db.ComplexTask, task_id).status == "completed"
        assert session.get(db.TaskStep, step_id).status == "completed"
        actual = session.scalars(select(db.TaskOperation).where(db.TaskOperation.tool_id == "read_task_result")).all()
        assert len(actual) == 1 and actual[0].status == "completed"
        assert "处理资料" in actual[0].result["content"]
    assert any(choice for choice in calls)


@pytest.mark.asyncio
async def test_todo_task_queries_see_earlier_writes(configured):
    task_id, step_id, run_id, message_id, conversation_id = task_records()
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        registry = {tool.name: tool for tool in tools.build_tools(run_id, conversation_id)}
        assert json.loads(await registry["list_todos"].ainvoke({})) == {"value": []}
        created = json.loads(await registry["create_todo"].ainvoke({"title": "复习三个节点", "notes": "保留备注"}))
        result = json.loads(await registry["list_todos"].ainvoke({}))
        assert result["value"][0]["id"] == created["id"]
        edited = json.loads(await registry["update_todo"].ainvoke({"todo_id": created["id"], "changes": {"title": "复习四个节点"}}))
        assert edited["notes"] == "保留备注"
        await registry["action_todo"].ainvoke({"todo_id": created["id"], "action": "complete"})
        assert json.loads(await registry["list_todos"].ainvoke({})) == {"value": []}
    finally:
        task_context.current.reset(token)


def test_all_builtin_tool_descriptions_retain_parameter_guidance(client, isolate, monkeypatch):
    isolate["search"] = "synthetic-key"
    monkeypatch.setattr(tools.skills, "catalog", lambda: [{"id": "fixture"}])
    monkeypatch.setattr(tools.image_generation, "ready", lambda: True)
    originals = {tool.name: tool for tool in tools.builtin_tools("unused", "unused")}
    registered = {tool.name: tool for tool in tools.build_tools("unused", "unused")}
    assert set(registered) == set(tools.TOOL_INFO)
    for name, tool in registered.items():
        assert tool.description == originals[name].description
