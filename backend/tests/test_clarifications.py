"""Source-bound clarification regressions; run only on explicit user request."""

import json
from types import SimpleNamespace

import pytest
from app import clarifications, complex_tasks, db, followups
from app.clarification_models import ClarificationResponse, QuestionInput
from app.tool_discovery import ToolDiscovery
from fastapi import HTTPException
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from . import mock_provider
from .test_app import API, wait_run
from .test_complex_tasks import task_records
from .test_eval_execution import request_run


def questions(multiple=False):
    return [QuestionInput(question="从哪个日期开始？", options=[{"label": "11月2日"}, {"label": "12月2日"}], multiple=multiple)]


def saved_question():
    cid, rid = request_run("安排原来的五项计划，跳过周日")
    result = complex_tasks.save_reply(rid, cid, "请补充日期", clarification=clarifications.create(questions()))
    return cid, result["clarification"]


def response(request, options=None, custom=""):
    return ClarificationResponse(request_id=request["request_id"], source_message_id=request["source_message_id"],
        answers=[{"question_id": "q1", "option_ids": options or ["o1"], "custom_text": custom}])


async def test_asking_stops_at_the_question_tool():
    with pytest.raises(clarifications.Requested) as result:
        await clarifications.question_tool().ainvoke({"questions": [question.model_dump() for question in questions()]})
    assert len(result.value.request["questions"][0]["options"]) == 2
    assert "其他，我来填写" in clarifications.text(result.value.request)


async def test_question_and_write_batch_is_rejected_before_either_executes():
    discovery = ToolDiscovery([clarifications.question_tool()])
    calls = [{"id": "ask", "name": "ask_user_question", "args": {}},
             {"id": "write", "name": "create_plans", "args": {}}]
    state = {"messages": [AIMessage(content="", tool_calls=calls)]}

    async def no_execution(*args):
        pytest.fail("澄清与写入同批时不应执行任何一项")

    for call in calls:
        result = await discovery.awrap_tool_call(SimpleNamespace(tool_call=call, state=state), no_execution)
        assert result.status == "error" and json.loads(result.content)["not_executed"]


def test_planner_requires_options_for_a_new_clarification():
    with pytest.raises(ValidationError, match="questions"):
        complex_tasks.Plan(goal="安排计划", question="从哪个月开始？")
    plan = complex_tasks.Plan(goal="安排计划", questions=questions())
    assert plan.question == "从哪个日期开始？"


@pytest.mark.parametrize("options,custom", [(["invented"], ""), (["other"], "  "), (["o1"], "伪造附加回答"), (["o1", "o2"], ""), (["o1", "o1"], "")])
def test_invalid_or_ambiguous_answers_are_rejected(options, custom):
    cid, request = saved_question()
    with db.Session() as session, pytest.raises(HTTPException) as result:
        clarifications.resolve(session, cid, response(request, options, custom))
    assert result.value.status_code == 400


def test_custom_answer_is_saved_against_the_exact_question_and_cannot_repeat():
    cid, request = saved_question()
    with db.Session() as session:
        source, card, content, context = clarifications.resolve(session, cid, response(request, ["other"], "  明年1月2日  "))
        assert content == "补充回答：\n- 从哪个日期开始？：明年1月2日"
        message = db.Message(conversation_id=cid, role="user", content=content)
        session.add(message)
        session.flush()
        clarifications.accept(session, source, card, context, message)
        session.commit()
        assert clarifications.read(source, latest_id=message.id)["state"] == "answered"
        choice = followups.choice_context(session, message)
        assert choice["selected"][0]["content"].endswith("明年1月2日")
        with pytest.raises(HTTPException) as result:
            clarifications.resolve(session, cid, response(request))
        assert result.value.status_code == 409


def test_old_and_other_conversation_questions_cannot_be_submitted():
    cid, request = saved_question()
    other_cid, _ = request_run("另一个对话")
    with db.Session() as session:
        with pytest.raises(HTTPException) as result:
            clarifications.resolve(session, other_cid, response(request))
        assert result.value.status_code == 404
        session.add(db.Message(conversation_id=cid, role="user", content="先处理新的问题"))
        session.commit()
        with pytest.raises(HTTPException) as result:
            clarifications.resolve(session, cid, response(request))
        assert result.value.status_code == 409


def test_task_answer_queues_only_the_task_that_asked():
    task_id, _, rid, _, cid = task_records()
    with db.Session() as session:
        session.get(db.ComplexTask, task_id).status = "waiting_input"
        session.commit()
    request = complex_tasks.save_reply(rid, cid, "请补充", clarification=clarifications.create(questions()))["clarification"]
    with db.Session() as session:
        source, card, content, context = clarifications.resolve(session, cid, response(request))
        message = db.Message(conversation_id=cid, role="user", content=content)
        session.add(message)
        session.flush()
        clarifications.accept(session, source, card, context, message)
        assert session.get(db.ComplexTask, task_id).pending_message_ids == [message.id]
        assert message.provider_context["task_route"] == {"task_id": task_id, "decision": "supplement"}


def test_chat_question_completes_without_an_extra_model_round_and_answer_is_canonical(configured, monkeypatch):
    seen = []

    def reply(body):
        seen.append(body)
        if len(seen) == 1:
            assert {tool["function"]["name"] for tool in body["tools"]} == {"ask_user_question"}
            return {"content": None, "tool_calls": [{"id": "ask-date", "type": "function", "function": {
                "name": "ask_user_question", "arguments": json.dumps({"questions": [question.model_dump() for question in questions()]}, ensure_ascii=False),
            }}]}
        assert len(seen) == 2
        return {"content": "按你选择的11月2日继续讨论原来的安排。"}

    monkeypatch.setattr(mock_provider, "reply", reply)
    cid = configured.post(API + "/conversations", json={}).json()["id"]
    selection = {"mode": "chat", "use_memory": False, "use_knowledge": False}
    run = wait_run(configured, configured.post(f"{API}/conversations/{cid}/messages", json={"content": "需要讨论开始日期", "model_selection": selection}))
    assert run["status"] == "completed" and len(seen) == 1
    messages = configured.get(f"{API}/conversations/{cid}/messages").json()
    request = messages[-1]["clarification"]
    run = wait_run(configured, configured.post(f"{API}/conversations/{cid}/messages", json={
        "content": "伪造的其他选项", "model_selection": selection,
        "clarification_response": response(request).model_dump(),
    }))
    assert run["status"] == "completed" and len(seen) == 2
    messages = configured.get(f"{API}/conversations/{cid}/messages").json()
    assert messages[1]["clarification"]["state"] == "answered"
    assert "11月2日" in messages[2]["content"] and "伪造" not in messages[2]["content"]
