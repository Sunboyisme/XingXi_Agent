"""User-facing regressions for the token optimization fixes, using isolated fixtures."""

import json

import pytest
from pydantic import ValidationError

from app import agent, artifacts, calendar_policy, office, schemas, tools
from . import mock_provider
from .test_app import API, wait_run
from .test_eval_execution import request_run


@pytest.mark.parametrize("value", ["", "   ", None])
def test_optional_learning_time_can_be_cleared(value):
    result = schemas.GoalCreate(title="HTML", weekly_minutes=value)
    assert result.weekly_minutes is None


@pytest.mark.parametrize("value", [0, -1, 10081, "invalid"])
def test_invalid_learning_time_is_still_rejected(value):
    with pytest.raises(ValidationError):
        schemas.GoalCreate(title="HTML", weekly_minutes=value)


@pytest.mark.parametrize("user_request,authorized", [
    ("创建明天的日程", True),
    ("在2030-11-01创建、修改并删除活动计划", True),
    ("先给方案，创建明天的日程", False),
    ("不要保存日历计划", False),
    ("创建项目计划文档", False),
])
def test_calendar_authorization_uses_actual_user_request(user_request, authorized):
    assert calendar_policy.creation_authorized(user_request) is authorized


def test_calendar_examples_are_not_rewritten_as_execution_receipts():
    text = "示例：\n```text\n计划已成功保存。\n```\n> 已为你创建明天的日程。"
    assert agent._verify_plan_execution("no-run", text) == text


@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", ["txt", "md"])
async def test_generated_text_can_be_searched_by_its_real_filename(suffix):
    conversation_id, run_id = request_run("检索报告里的预算")
    saved = artifacts.save_file(run_id, f"report.{suffix}", "活动预算100元".encode("utf-8"))
    path, _ = artifacts.file_record(saved["id"])
    assert path.suffix == ".bin"
    result = await office.search_file(saved["id"], conversation_id, "预算")
    assert result["matches"] and "100元" in str(result["matches"])


def test_unseeded_tool_can_be_discovered_and_used_without_changing_user_text(configured, monkeypatch):
    seen = []
    user_text = "广州出门需要带伞吗？"

    def response(body):
        definitions = {item["function"]["name"] for item in body.get("tools", [])}
        if "discover_tools" not in definitions:
            return {"content": json.dumps({"decision": "chat"})}
        seen.append(body)
        last = body["messages"][-1]
        if last.get("role") != "tool":
            name, args, call_id = "discover_tools", {"names": ["get_weather"]}, "discover-weather"
        elif last.get("tool_call_id") == "discover-weather":
            assert "get_weather" in definitions
            name, args, call_id = "get_weather", {"city": "广州", "days": 1}, "weather"
        else:
            return {"content": "广州有雨，出门带伞。来源：https://example.com/weather"}
        return {"content": None, "tool_calls": [{"id": call_id, "type": "function",
                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}

    async def weather(**kwargs):
        return {"location": "广州", "condition": "有雨", "source": "https://example.com/weather"}

    monkeypatch.setattr(mock_provider, "reply", response)
    monkeypatch.setattr(tools.weather, "get_weather", weather)
    conversation = configured.post(API + "/conversations", json={}).json()["id"]
    run = wait_run(configured, configured.post(f"{API}/conversations/{conversation}/messages", json={"content": user_text}))
    assert run["status"] == "completed", run
    assert "带伞" in run["result"]["content"]
    first_tools = {item["function"]["name"] for item in seen[0]["tools"]}
    assert "get_weather" not in first_tools
    for body in seen:
        current_user = next(message for message in reversed(body["messages"]) if message["role"] == "user")
        assert current_user["content"] == user_text
        assert "天气必须查询真实工具" in body["messages"][0]["content"] or body is seen[0]
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    business_calls = [event for event in events if event["kind"] == "tool"]
    assert len(business_calls) == 1
    assert business_calls[0]["data"]["tool_id"] == "get_weather"
    assert business_calls[0]["data"]["status"] == "completed"
