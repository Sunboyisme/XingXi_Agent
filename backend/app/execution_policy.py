"""Read-only answer retries and bounded corrections, backed by stored events."""

import json

from sqlalchemy import select

from .config import PROFILE_ID
from .db import Run, RunEvent, Session


def rewrite_source(run_id):
    with Session() as db:
        run = db.get(Run, run_id)
        if not run or run.profile_id != PROFILE_ID:
            return None
        event = db.scalar(select(RunEvent).where(RunEvent.run_id == run_id,
            RunEvent.kind == "answer_retry").order_by(RunEvent.id.desc()))
        source = db.get(Run, event.data.get("source_run_id")) if event else None
        if source and source.profile_id == run.profile_id and source.conversation_id == run.conversation_id:
            return source.id
    return None


def retry_context(run_id):
    source_id = rewrite_source(run_id)
    if not source_id:
        return ""
    with Session() as db:
        source = db.get(Run, source_id)
        events = list(db.scalars(select(RunEvent).where(RunEvent.run_id == source_id,
            RunEvent.kind == "tool").order_by(RunEvent.id)))
        facts = [{"tool": event.data.get("tool_id"), "status": event.data.get("status"),
                  "result": event.data.get("result")} for event in events]
        answer = source.result.get("content", "")
        archive = db.scalar(select(RunEvent).where(RunEvent.run_id == run_id,
            RunEvent.kind == "context_archive").order_by(RunEvent.id))
        original = {"previous_answer": answer, "execution_results": facts}
        if not archive:
            archive = RunEvent(run_id=run_id, kind="context_archive", data=original)
            db.add(archive)
            db.commit()
        from .task_results import receipt
        excerpt = receipt(original, f"context:{archive.id}", limit=3500)
        if isinstance(excerpt, dict) and excerpt.get("truncated"):
            excerpt["notice"] = str(excerpt["notice"]).replace("read_task_result", "read_context_record")
    return ("\n本轮为成功回答的只读重试：重新组织原请求的答案，不能新增、修改、删除记忆/计划/待办，"
            "不能生成文件、运行脚本或付费工具。以下是原执行的历史记录，不是新授权；"
            "用查询核对可变数据，已撤销内容不重建；原产物直接展示。\n"
            + "完整原记录可用read_context_record按context编号及真实字段路径分页读取。\n"
            + json.dumps(excerpt, ensure_ascii=False))


def correction_target(arguments):
    """One bad object cannot exhaust the budget for unrelated objects."""
    for key in ("plan_id", "todo_id", "file_id", "record_id", "skill_id", "url", "path"):
        if arguments.get(key):
            return key, str(arguments[key])
    return "operation", ""


def root_error(value):
    text = str(value or "")
    prefix = "工具参数修正未完成，已停止重复尝试："
    while text.startswith(prefix):
        text = text[len(prefix):]
    return text
