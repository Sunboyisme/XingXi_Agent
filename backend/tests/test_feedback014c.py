import pytest
from app import agent, db
from .test_app import API, wait_run


@pytest.mark.parametrize("answer", [
    "抱歉，创建具体子计划时遇到了系统错误，暂时无法保存。",
    "已为你创建明天的日程。",
    "计划已成功保存。",
])
def test_calendar_outcomes_require_actual_tool_execution(answer):
    assert "没有执行日历计划写入" in agent._verify_plan_execution("no-run", answer)


def test_calendar_advice_and_actual_tool_errors_are_preserved():
    advice = "建议你先把计划名称和时间写清楚，再确认是否创建。"
    assert agent._verify_plan_execution("no-run", advice) == advice
    with db.Session() as session:
        run = db.Run(kind="chat")
        session.add(run)
        session.flush()
        session.add(db.RunEvent(run_id=run.id, kind="tool", data={
            "tool_id": "create_plans", "status": "error",
            "result": {"error": "结束时间必须晚于开始时间"},
        }))
        session.commit()
        run_id = run.id
    answer = "创建计划失败：结束时间必须晚于开始时间。"
    assert agent._verify_plan_execution(run_id, answer) == answer


def test_chat_does_not_store_a_model_invented_plan_failure(configured, monkeypatch):
    from . import mock_provider

    prompts = []

    def invented_error(body):
        prompts.append(body["messages"][0]["content"])
        return {"content": "抱歉，创建具体子计划时遇到了系统错误，暂时无法保存。"}

    monkeypatch.setattr(mock_provider, "reply", invented_error)
    conversation = configured.post(API + "/conversations", json={}).json()["id"]
    run = wait_run(configured, configured.post(
        f"{API}/conversations/{conversation}/messages",
        json={"content": "确认上一条计划方案"},
    ))
    assert run["status"] == "completed", run
    messages = configured.get(f"{API}/conversations/{conversation}/messages").json()
    assert "没有执行日历计划写入" in messages[-1]["content"]
    assert "遇到了系统错误" not in messages[-1]["content"]
    assert "创建前必须先提出方案并询问用户，确认后才写入" not in prompts[0]
    assert "成功和失败都必须有本轮实际工具结果为依据" in prompts[0]
    assert configured.get(API + "/calendar/events").json() == []
