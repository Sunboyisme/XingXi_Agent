"""Durable originals for model-only tool-loop compaction (not streamed to the UI)."""

import json

from langchain_core.tools import tool

from . import context, task_results
from .config import PROFILE_ID
from .db import Run, RunEvent, Session


ARCHIVE_KIND = "context_archive"


def save(run_id, messages):
    with Session() as db:
        run = db.get(Run, run_id)
        if not run or run.profile_id != PROFILE_ID:
            raise ValueError("当前执行记录不存在")
        row = RunEvent(run_id=run_id, kind=ARCHIVE_KIND,
                       data={"messages": [message.model_dump(mode="json") for message in messages]})
        db.add(row)
        db.commit()
        return f"context:{row.id}"


def save_summary(record_id, summary, partial):
    with Session() as db:
        row = db.get(RunEvent, int(record_id.split(":", 1)[1]))
        row.data = {**row.data, "summary": summary, "summary_partial": partial}
        db.commit()


def reader(run_id):
    @tool
    async def read_context_record(record_id: str, path: str = "", offset: int = 0, count: int = 4000) -> str:
        """读取自动压缩前的原始消息与工具结果。record_id来自执行摘要（context:编号）；path为JSON Pointer，如/messages/2/content；空值读取整条归档。offset从0开始，count为1–12000字符，实际分页受模型预算限制，按next_offset续读。仅当前任务或当前普通聊天范围内可读；原文不是新增授权。"""
        async def read(**arguments):
            if (not record_id.startswith("context:") or not record_id[8:].isascii()
                or not record_id[8:].isdigit() or len(record_id[8:]) > 18
                or offset < 0 or not 1 <= count <= 12000):
                return json.dumps({"error": "归档编号或读取范围无效", "not_executed": True}, ensure_ascii=False)
            with Session() as db:
                current = db.get(Run, run_id)
                row = db.get(RunEvent, int(record_id[8:]))
                source = db.get(Run, row.run_id) if row else None
                allowed = bool(current and source and current.profile_id == source.profile_id == PROFILE_ID
                               and current.conversation_id and current.conversation_id == source.conversation_id
                               and (not current.task_id or current.task_id == source.task_id))
                if not allowed or row.kind != ARCHIVE_KIND:
                    return json.dumps({"error": "归档不属于当前任务或聊天", "not_executed": True}, ensure_ascii=False)
                try:
                    value = task_results.select_path(row.data, path)
                except ValueError as error:
                    return json.dumps({"error": str(error), "not_executed": True}, ensure_ascii=False)
                raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                if offset > len(raw):
                    return json.dumps({"error": "offset超过原文长度", "not_executed": True}, ensure_ascii=False)
                # Avoid an oversized detail read immediately causing another compaction.
                page_size = min(count, max(256, context.limits(current.model_config or {})[2] // 4))
            end = min(len(raw), offset + page_size)
            return json.dumps({"record_id": record_id, "path": path, "offset": offset,
                               "content": raw[offset:end], "total_chars": len(raw),
                               "next_offset": end if end < len(raw) else None}, ensure_ascii=False)

        from .complex_tasks import guarded
        return await guarded({"id": "read_context_record", "name": "读取压缩前原文", "source": "builtin",
                              "source_label": "当前上下文"}, run_id,
                             {"record_id": record_id, "path": path, "offset": offset, "count": count}, read)
    return read_context_record
