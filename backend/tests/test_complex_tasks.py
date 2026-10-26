"""Regression cases for durable effects; run only when explicitly requested."""

import asyncio
import json

import pytest
from sqlalchemy import select

from app import complex_tasks, db, provider, task_context, task_results


def test_compact_task_receipt_keeps_original_and_execution_facts():
    value = {"content": "正文" * 10000, "url": "https://example.com/source", "partial": True,
             "warnings": ["原网页仅提供部分正文"], "artifacts": [{"id": "file-1", "name": "report.pdf"}]}
    original = json.dumps(value, ensure_ascii=False)
    compact = task_results.receipt(value, "op-1")
    assert len(json.dumps(compact, ensure_ascii=False)) < len(original) // 2
    assert json.dumps(value, ensure_ascii=False) == original
    assert compact["result"]["url"] == value["url"]
    assert compact["result"]["warnings"] == value["warnings"]
    assert compact["result"]["artifacts"] == value["artifacts"]
    assert compact["result"]["partial"] is True
    assert "/content" in compact["omitted_paths"]
    assert task_results.select_path(value, "/content") == value["content"]
    assert task_results.select_path({"a/b": {"~key": ["原文"]}}, "/a~1b/~0key/0") == "原文"


def test_explicit_reads_and_actionable_failures_are_not_shortened():
    value = {"content": "请求的原文" * 4000}
    for tool_id in task_results.DIRECT_READS:
        assert json.loads(task_results.tool_response(value, "op-1", tool_id)) == value
    failure = {"error": "错误详情" * 2000, "not_executed": True}
    assert json.loads(task_results.tool_response(failure, "op-1", "remote", status="failed")) == failure
    assert task_results.receipt({"result": 42}, "op-1") == {"result": 42}


@pytest.mark.asyncio
async def test_compact_receipt_replay_and_paged_read_keep_durable_original():
    task_id, step_id, run_id, message_id, _ = task_records()
    original = {"content": "完整工具原文" * 3000, "url": "https://example.com/source"}
    calls = []

    async def operation(**arguments):
        calls.append(arguments)
        return json.dumps(original, ensure_ascii=False)

    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        compact = json.loads(await complex_tasks.guarded(ENTRY, run_id, {}, operation))
        record_id = compact["record_id"]
        with db.Session() as session:
            assert session.get(db.TaskOperation, record_id).result == original
        reader = complex_tasks.context_tool(run_id)
        parts, offset = [], 0
        while offset is not None:
            page = json.loads(await reader.ainvoke({"record_id": record_id, "path": "/content",
                                                   "offset": offset, "count": 6000}))
            parts.append(page["content"])
            offset = page["next_offset"]
        assert "".join(parts) == original["content"]
    finally:
        task_context.current.reset(token)
    token = task_context.current.set(task_context.Execution(task_id, step_id, 1, message_id))
    try:
        replay = json.loads(await complex_tasks.guarded(ENTRY, run_id, {}, operation))
        assert replay == compact
        assert len(calls) == 1
    finally:
        task_context.current.reset(token)


@pytest.mark.asyncio
async def test_step_context_filters_dependencies_but_directory_recovers_other_results():
    task_id, step_id, run_id, message_id, _ = task_records()
    other_task, other_step, _, _, _ = task_records()
    with db.Session() as session:
        dependency = session.get(db.TaskStep, step_id)
        dependency.status, dependency.output = "completed", {"content": "直接依赖成果"}
        unrelated = db.TaskStep(task_id=task_id, ordinal=1, title="其他成果", instruction="已执行",
                               source_message_id=message_id, status="completed", output={"content": "不默认携带"})
        session.add(unrelated)
        session.flush()
        current = db.TaskStep(task_id=task_id, ordinal=2, title="当前步骤", instruction="处理直接依赖",
                             source_message_id=message_id, dependencies=[dependency.id])
        session.add(current)
        session.flush()
        op = db.TaskOperation(task_id=task_id, step_id=unrelated.id, run_id=run_id, tool_id="web_search",
                              fingerprint="fixture", policy="read", status="completed", result={"content": "原始资料"})
        session.add(op)
        session.commit()
        context = complex_tasks.step_context(session, session.get(db.ComplexTask, task_id), current,
                                              [dependency, unrelated, current])
        assert [item["id"] for item in context["completed_steps"]] == [step_id]
        assert context["existing_operations"] == []
        assert context["other_steps"][0]["id"] == unrelated.id
        current_id, op_id = current.id, op.id
    token = task_context.current.set(task_context.Execution(task_id, current_id, 1, message_id))
    try:
        reader = complex_tasks.context_tool(run_id)
        directory = json.loads(await reader.ainvoke({"record_id": task_id, "path": "/operations"}))
        assert json.loads(directory["content"])[0]["id"] == op_id
        original = json.loads(await reader.ainvoke({"record_id": op_id, "path": "/content"}))
        assert original["content"] == "原始资料"
        for foreign_id in (other_task, other_step):
            with db.Session() as session:
                session.get(db.ComplexTask, task_id).status = "running"
                session.commit()
            with pytest.raises(task_context.TaskControl, match="记录不属于当前任务"):
                await reader.ainvoke({"record_id": foreign_id})
    finally:
        task_context.current.reset(token)


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


@pytest.mark.parametrize("status", ["completed", "cancelled"])
@pytest.mark.asyncio
async def test_continue_terminal_task_keeps_state_without_executing_again(monkeypatch, status):
    from app import agent

    task_id, _, _, _, conversation_id = task_records()
    config = {"provider_id": "custom", "model_name": "fixture"}
    with db.Session() as session:
        task = session.get(db.ComplexTask, task_id)
        task.status, task.reason, task.model_config = status, "", config
        message = db.Message(conversation_id=conversation_id, role="user", content="继续")
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation_id,
                     source_message_id=message.id, model_config=config)
        session.add(run)
        session.commit()
        run_id = run.id

    async def route(*args, **kwargs):
        return complex_tasks.Route(decision="continue", task_id=task_id)

    async def unexpected_execution(*args, **kwargs):
        raise AssertionError("终态任务不能重新执行模型与工具步骤")

    monkeypatch.setattr(provider, "ask_json", route)
    monkeypatch.setattr(agent, "_chat", unexpected_execution)
    result = await complex_tasks.dispatch(run_id, conversation_id)
    with db.Session() as session:
        assert session.get(db.ComplexTask, task_id).status == status
    assert "暂停" not in result["content"] and "发送“继续”" not in result["content"]
    assert ("任务已完成" if status == "completed" else "任务已结束") in result["content"]


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
