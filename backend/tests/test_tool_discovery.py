"""Regression sources for token-aware loading; do not call external models."""

import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from app import agent_prompts, context_budget
from app.tool_discovery import ToolDiscovery, schema_tokens


class Input(BaseModel):
    value: str = ""


class Request(SimpleNamespace):
    def override(self, **changes):
        return Request(**{**vars(self), **changes})


def tool(name, description="工具说明", **metadata):
    return StructuredTool.from_function(
        func=lambda value="": value, name=name, description=description,
        args_schema=Input, metadata=metadata,
    )


def prompt():
    return (agent_prompts.CORE + agent_prompts.CAPABILITY_MARKER
            + agent_prompts.RUNTIME_MARKER + "项目资料和用户约束"
            + agent_prompts.CLOCK_MARKER + "2026-10-29T12:00:00+08:00")


async def passthrough(request):
    return request


@pytest.mark.asyncio
async def test_initial_round_omits_unrelated_schemas_and_rules():
    discovery = ToolDiscovery([tool("get_weather"), tool("create_plans"), tool("list_plans")])
    original = Request(tools=discovery.registered_tools, messages=[HumanMessage(content="你好")],
                       system_message=SystemMessage(content=prompt()))
    exposed = await discovery.awrap_model_call(original, passthrough)
    assert [item.name for item in exposed.tools] == ["discover_tools"]
    assert "日历创建前" not in exposed.system_message.content
    assert original.tools == discovery.registered_tools
    assert agent_prompts.CORE in exposed.system_message.content


@pytest.mark.asyncio
async def test_discovery_loads_write_prerequisites_without_executing():
    discovery = ToolDiscovery([tool(name) for name in ["create_plans", "list_plans", "date_time", "get_weather"]])
    receipt = json.loads(await discovery.discover(names=["create_plans"]))
    assert receipt["loaded"] == ["create_plans"]
    assert set(receipt["also_loaded"]) == {"list_plans", "date_time"}
    request = Request(tools=[], messages=[], system_message=SystemMessage(content=prompt()))
    exposed = await discovery.awrap_model_call(request, passthrough)
    assert "日历创建前" in exposed.system_message.content
    assert "天气必须查询真实工具" not in exposed.system_message.content
    assert "get_weather" not in {item.name for item in exposed.tools}
    before = [item.name for item in exposed.tools]
    await discovery.discover(names=["get_weather"])
    after = [item.name for item in discovery.exposed_tools()]
    assert after[:len(before)] == before


@pytest.mark.asyncio
async def test_browse_and_miss_keep_pagination_without_loading_arbitrary_tools():
    discovery = ToolDiscovery([tool("alpha"), tool("beta"), tool("gamma")])
    first = json.loads(await discovery.discover(query="没有匹配用途", limit=1))
    assert first["next_offset"] == 1
    assert first["loaded"] == []
    assert discovery.loaded == []
    second = json.loads(await discovery.discover(offset=first["next_offset"], limit=1))
    assert first["items"][0]["name"] != second["items"][0]["name"]
    missing = json.loads(await discovery.discover(names=["disabled_tool"], limit=1))
    assert missing["not_found"] == ["disabled_tool"]
    assert missing["items"] and missing["loaded"] == []


@pytest.mark.asyncio
async def test_mcp_search_uses_full_description_and_service_name():
    remote = tool("mcp_123", "说明" * 300 + "unique_capability", source="mcp",
                  source_label="Remote Service", catalog_name="remote_read")
    discovery = ToolDiscovery([remote, tool("calculate")])
    assert "Remote Service：1个工具" in discovery.catalog_context()
    assert "unique_capability" not in discovery.catalog_context()
    receipt = json.loads(await discovery.discover(query="unique_capability"))
    assert receipt["loaded"] == ["mcp_123"]


@pytest.mark.asyncio
async def test_discover_and_execute_parallel_batch_cannot_bypass_rules():
    discovery = ToolDiscovery([tool("create_plans"), tool("list_plans")])
    await discovery.awrap_model_call(Request(system_message=SystemMessage(content=prompt())), passthrough)
    await discovery.discover(names=["create_plans"])
    call = Request(tool_call={"id": "write1", "name": "create_plans", "args": {}})
    executed = []

    async def execute(request):
        executed.append(request)
        return "executed"

    blocked = await discovery.awrap_tool_call(call, execute)
    assert json.loads(blocked.content)["not_executed"] is True
    assert executed == []
    await discovery.awrap_model_call(Request(system_message=SystemMessage(content=prompt())), passthrough)
    assert await discovery.awrap_tool_call(call, execute) == "executed"


def test_task_required_tools_are_preloaded_and_other_capabilities_stay_discoverable():
    discovery = ToolDiscovery([tool("read_file"), tool("list_files"), tool("get_weather")], required=["read_file"])
    names = {item.name for item in discovery.exposed_tools()}
    assert {"discover_tools", "read_file", "list_files"} <= names
    assert "get_weather" not in names
    assert "get_weather" in discovery.catalog_context()


@pytest.mark.asyncio
async def test_budget_uses_loaded_schemas_and_keeps_runtime_out_of_history(monkeypatch):
    events, prepared = [], []
    monkeypatch.setattr(context_budget, "emit", lambda *args: events.append(args[-1]))
    middleware = context_budget.ContextBudget("unused", {"context_tokens": 64000}, 999999)

    async def prepare(messages, overhead, hard):
        prepared.append(messages)
        return messages

    monkeypatch.setattr(middleware.compactor, "prepare", prepare)
    picture = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    messages = [HumanMessage(content="旧问"), AIMessage(content="旧答"),
                HumanMessage(content=[{"type": "text", "text": "看这张图片"}, picture])]
    exposed_tool = tool("get_weather")
    request = Request(messages=messages, system_message=SystemMessage(content=prompt()), tools=[exposed_tool])
    result = await middleware.awrap_model_call(request, passthrough)
    assert "2026-10-29" not in result.system_message.content
    assert "项目资料和用户约束" not in result.system_message.content
    assert result.messages[:2] == messages[:2]
    assert result.messages[-1].content[:2] == messages[-1].content
    assert "2026-10-29" in result.messages[-1].content[-1]["text"]
    assert len(messages[-1].content) == 2
    assert prepared[0] == messages
    assert events[-1]["tool_tokens"] == schema_tokens([exposed_tool])


def test_summary_insertion_preserves_clock_tail_and_runtime_split():
    combined = agent_prompts.append_context(prompt(), "\n历史摘要")
    assert combined.index("历史摘要") < combined.index(agent_prompts.CLOCK_MARKER)
    fixed, runtime = agent_prompts.split_runtime(combined)
    assert "历史摘要" not in fixed and "历史摘要" in runtime
    assert "用户原话" in fixed
