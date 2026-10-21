"""Regression cases for durable effects; run only when explicitly requested."""

import asyncio
import json

import pytest
from sqlalchemy import select

from app import complex_tasks, db, provider, task_context


def task_records():
    with db.Session() as session:
        conversation = db.Conversation(title="恢复任务")
        session.add(conversation)
        session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content="处理资料并生成报告")
        session.add(message)
        session.flush()
        task = db.ComplexTask(conversation_id=conversation.id, source_message_id=message.id,
                              goal=message.content, status="running", message_ids=[message.id])
        session.add(task)
        session.flush()
        step = db.TaskStep(task_id=task.id, ordinal=0, title="执行", instruction="执行已有授权操作",
                           source_message_id=message.id)
        run = db.Run(kind="chat", conversation_id=conversation.id, task_id=task.id,
                     source_message_id=message.id)
        session.add_all([step, run])
        session.commit()
        return task.id, step.id, run.id, message.id, conversation.id


ENTRY = {"id": "remote_action", "name": "外部操作", "source": "mcp", "source_label": "fixture"}


@pytest.mark.asyncio
async def test_committed_effect_is_reused_after_a_new_run():
    task_id, step_id, run_id, message_id, conversation_id = task_records()
    calls = []

    async def operation(**arguments):
        calls.append(arguments)
        return json.dumps({"summary": "外部操作已返回结果"})

    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        await complex_tasks.guarded(ENTRY, run_id, {"value": 1}, operation)
    finally:
        task_context.current.reset(token)
    with db.Session() as session:
        next_run = db.Run(kind="chat", conversation_id=conversation_id, task_id=task_id,
                          source_message_id=message_id)
        session.add(next_run)
        session.commit()
        next_id = next_run.id
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        result = json.loads(await complex_tasks.guarded(ENTRY, next_id, {"value": 1}, operation))
    finally:
        task_context.current.reset(token)
    assert len(calls) == 1
    assert result["summary"] == "外部操作已返回结果"


@pytest.mark.asyncio
async def test_cancelled_external_operation_is_not_blindly_repeated():
    task_id, step_id, run_id, message_id, _ = task_records()
    calls = []

    async def operation(**arguments):
        calls.append(arguments)
        raise asyncio.CancelledError()

    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        with pytest.raises(asyncio.CancelledError):
            await complex_tasks.guarded(ENTRY, run_id, {}, operation)
    finally:
        task_context.current.reset(token)
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        with pytest.raises(task_context.TaskControl):
            await complex_tasks.guarded(ENTRY, run_id, {}, operation)
    finally:
        task_context.current.reset(token)
    assert len(calls) == 1
    with db.Session() as session:
        assert session.scalar(select(db.TaskOperation)).status == "unknown"


@pytest.mark.asyncio
async def test_steering_is_consumed_before_another_effect_starts():
    task_id, step_id, run_id, message_id, conversation_id = task_records()
    with db.Session() as session:
        message = db.Message(conversation_id=conversation_id, role="user", content="预算改成五万元")
        session.add(message)
        session.flush()
        complex_tasks.queue_message(session, session.get(db.ComplexTask, task_id), message)
        session.commit()

    async def operation(**arguments):
        pytest.fail("补充要求尚未处理时不应发出后续操作")

    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        with pytest.raises(task_context.Replan):
            await complex_tasks.guarded(ENTRY, run_id, {}, operation)
        with db.Session() as session:
            assert task_context.user_message(session, run_id, conversation_id).id == message_id
    finally:
        task_context.current.reset(token)


@pytest.mark.asyncio
async def test_recovery_does_not_start_models_or_repeat_unknown_effects(monkeypatch):
    task_id, step_id, run_id, _, _ = task_records()
    with db.Session() as session:
        session.add(db.TaskOperation(task_id=task_id, step_id=step_id, run_id=run_id,
            tool_id="remote_action", fingerprint="a" * 64, policy="external", status="started"))
        session.commit()
    complex_tasks.recover()

    async def no_model(*args, **kwargs):
        pytest.fail("未核实的外部操作不能触发模型续跑")

    monkeypatch.setattr(provider, "ask_json", no_model)
    result = await complex_tasks.execute(run_id, task_id)
    assert "尚未核实" in result["content"]
    with db.Session() as session:
        assert session.get(db.ComplexTask, task_id).status == "waiting_input"


def test_learning_partial_strings_hide_json_and_incomplete_escapes():
    values = provider.partial_json_strings('{"content":"第一行\\n第二行\\u4e', ["content"])
    assert values == {"content": "第一行\n第二行"}
    values = provider.partial_json_strings('{"content":"hello\\ud83d', ["content"])
    assert values == {"content": "hello"}
