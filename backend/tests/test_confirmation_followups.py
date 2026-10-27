"""Confirmation regressions; source only until the user requests execution."""

import pytest
from sqlalchemy import select

from app import agent, complex_tasks, db, followups, provider


def exchange(*, task_source=None, effect=False):
    """The proposal precedes the confirmation, even at the same clock tick."""
    stamp = "2026-10-23T03:40:07.000000+00:00"
    config = {"provider_id": "custom", "model_name": "fixture"}
    with db.Session() as session:
        conversation = db.Conversation(title="周日安排")
        session.add(conversation)
        session.flush()
        request = db.Message(conversation_id=conversation.id, role="user", content=task_source or "帮我列一个周日计划", created_at=stamp)
        session.add(request)
        session.flush()
        task = None
        if task_source:
            task = db.ComplexTask(conversation_id=conversation.id, source_message_id=request.id,
                                  message_ids=[request.id], goal="安排周日", status="waiting_input", model_config=config)
            session.add(task)
            session.flush()
        previous = db.Run(kind="chat", conversation_id=conversation.id, task_id=task.id if task else None,
                          source_message_id=request.id, model_config=config)
        session.add(previous)
        session.flush()
        proposal = db.Message(conversation_id=conversation.id, role="assistant", run_id=previous.id,
                              content="2026-10-25：09:00–10:00 学英语，10:00–11:00 读书。要按这个建到日历里吗？", created_at=stamp)
        session.add(proposal)
        session.flush()
        reply = db.Message(conversation_id=conversation.id, role="user", content="可以", created_at=stamp)
        session.add(reply)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, source_message_id=reply.id, model_config=config)
        session.add(run)
        if effect:
            step = db.TaskStep(task_id=task.id, source_message_id=request.id, ordinal=0, title="创建", instruction="创建计划")
            session.add(step)
            session.flush()
            session.add(db.TaskOperation(task_id=task.id, step_id=step.id, run_id=previous.id, revision=1,
                                        tool_id="create_plans", fingerprint="unresolved", policy="write", status="unknown"))
        session.commit()
        return conversation.id, run.id, reply.id, proposal.id, task.id if task else None


@pytest.mark.parametrize("text", ["可以", "可以的。", "同意", "同意你写进日志", "好的，创建吧", "OK"])
def test_confirmation_phrases(text):
    assert followups.is_confirmation(text)


@pytest.mark.parametrize("text", ["可以怎么安排", "不同意", "不要创建", "好像不行", "可以，改到下周", "可以吗？"])
def test_questions_and_amendments_are_not_plain_confirmations(text):
    assert not followups.is_confirmation(text)


@pytest.mark.asyncio
async def test_confirmation_goes_to_chat_with_original_proposal_without_classification(monkeypatch):
    conversation_id, run_id, reply_id, proposal_id, _ = exchange()
    with db.Session() as session:
        session.add(db.Message(conversation_id=conversation_id, role="assistant", content="未来的回复不属于这次确认", created_at="2026-10-24T00:00:00+00:00"))
        session.commit()

    async def chat(*args):
        with db.Session() as session:
            context = followups.prior_context(session, session.get(db.Message, reply_id))
        assert [value["role"] for value in context] == ["user", "assistant"]
        assert context[-1]["id"] == proposal_id and "09:00–10:00" in context[-1]["text"]
        return {"content": "continued"}

    async def unexpected(*args, **kwargs):
        raise AssertionError("short confirmation must not create a classifier/planner call")

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(provider, "ask_json", unexpected)
    result = await complex_tasks.dispatch(run_id, conversation_id)
    assert result["content"] == "continued"
    with db.Session() as session:
        assert session.scalar(select(db.ComplexTask.id)) is None


@pytest.mark.asyncio
async def test_confirmation_continues_the_task_that_asked_for_input(monkeypatch):
    conversation_id, run_id, reply_id, _, task_id = exchange(task_source="安排周日并输出行程文件")

    async def execute(current_run, selected):
        assert (current_run, selected) == (run_id, task_id)
        with db.Session() as session:
            task = session.get(db.ComplexTask, task_id)
            assert reply_id in task.pending_message_ids and reply_id in task.message_ids
        return {"content": "same task"}

    async def unexpected(*args, **kwargs):
        raise AssertionError("the immediately preceding task already identifies the target")

    monkeypatch.setattr(complex_tasks, "execute", execute)
    monkeypatch.setattr(provider, "ask_json", unexpected)
    monkeypatch.setattr(agent, "_chat", unexpected)
    assert (await complex_tasks.dispatch(run_id, conversation_id))["content"] == "same task"


@pytest.mark.asyncio
@pytest.mark.parametrize("effect", [False, True])
async def test_legacy_confirmation_task_cannot_hide_unresolved_writes(monkeypatch, effect):
    conversation_id, run_id, _, _, task_id = exchange(task_source="可以", effect=effect)

    async def chat(*args):
        assert not effect
        return {"content": "chat"}

    async def execute(*args):
        assert effect and args == (run_id, task_id)
        with db.Session() as session:
            assert session.scalar(select(db.TaskOperation.status)) == "unknown"
        return {"content": "verify existing write"}

    async def unexpected(*args, **kwargs):
        raise AssertionError("no new task may be classified from 可以")

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(complex_tasks, "execute", execute)
    monkeypatch.setattr(provider, "ask_json", unexpected)
    result = await complex_tasks.dispatch(run_id, conversation_id)
    assert result["content"] == ("verify existing write" if effect else "chat")
    with db.Session() as session:
        assert list(session.scalars(select(db.ComplexTask.id))) == [task_id]


@pytest.mark.asyncio
async def test_chat_mode_never_routes_into_a_task(monkeypatch):
    conversation_id, run_id, reply_id, _, task_id = exchange(task_source="安排周日并输出行程文件")
    with db.Session() as session:
        session.get(db.Message, reply_id).content = "如果下雨，流程该怎么调整？"
        session.get(db.Run, run_id).model_config = {"provider_id": "custom", "model_name": "fixture", "mode": "chat"}
        session.commit()

    async def chat(*args):
        return {"content": "chat"}

    async def unexpected(*args, **kwargs):
        raise AssertionError("chat mode must not classify, continue or amend a task")

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(complex_tasks, "execute", unexpected)
    monkeypatch.setattr(provider, "ask_json", unexpected)
    assert (await complex_tasks.dispatch(run_id, conversation_id))["content"] == "chat"
    with db.Session() as session:
        task = session.get(db.ComplexTask, task_id)
        assert reply_id not in task.message_ids and session.get(db.Run, run_id).task_id is None
