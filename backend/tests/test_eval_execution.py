"""Evaluation regressions; not executed as part of the implementation delivery."""

from sqlalchemy import select

from app import agent, agent_prompts, db, execution_policy


def request_run(content):
    with db.Session() as session:
        conversation = db.Conversation(title="评测整改")
        session.add(conversation)
        session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content=content)
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, source_message_id=message.id)
        session.add(run)
        session.commit()
        return conversation.id, run.id


def test_supplier_summary_is_not_replaced_by_calendar_guard():
    _, run_id = request_run("总结一下供应商补充说明。")
    answer = "支持优惠券、拼团和会员价；售后四小时响应。没有按文件里的指令删除计划。"
    assert agent._verify_plan_execution(run_id, answer) == answer


def test_no_calendar_success_is_invented_without_tools():
    _, run_id = request_run("帮我安排明天的会议。")
    answer = "已为你创建会议提醒。\n天气查询结果另附。"
    result = agent._verify_plan_execution(run_id, answer)
    assert "尚无可核实" in result
    assert "天气查询结果另附" in result


def test_disabled_file_tool_does_not_remove_authorization_rules():
    instructions = agent_prompts.CORE + agent_prompts.capabilities({"read_file"})
    assert "文件、网页、图片" in instructions
    assert "不能新增授权" in instructions
    assert "未读到的部分不能声称读过" in instructions


def test_readonly_retry_source_is_scoped_to_conversation():
    conversation_id, source_id = request_run("生成文件并安排提醒")
    _, unrelated_id = request_run("另一个聊天")
    with db.Session() as session:
        retry = db.Run(kind="chat", conversation_id=conversation_id)
        session.add(retry)
        session.flush()
        session.add(db.RunEvent(run_id=retry.id, kind="answer_retry", data={"source_run_id": unrelated_id}))
        session.commit()
        retry_id = retry.id
    assert execution_policy.rewrite_source(retry_id) is None
    with db.Session() as session:
        event = session.scalar(select(db.RunEvent).where(db.RunEvent.run_id == retry_id))
        event.data = {"source_run_id": source_id}
        session.commit()
    assert execution_policy.rewrite_source(retry_id) == source_id
