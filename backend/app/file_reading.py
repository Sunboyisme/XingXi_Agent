"""Search and coverage of immutable, authorized parsed files."""

import math
from collections import Counter

from sqlalchemy import select

from .config import PROFILE_ID
from .db import Run, RunEvent, Session


def ranges(indices):
    result = []
    for index in sorted(set(indices)):
        if result and index == result[-1][1] + 1:
            result[-1][1] = index
        else:
            result.append([index, index])
    return result


def record_read(run_id, file_id, parts, total, warnings):
    indices = [part["part"] for part in parts]
    with Session() as db:
        run = db.get(Run, run_id) if run_id else None
        if run:
            rows = db.scalars(select(RunEvent).join(Run, Run.id == RunEvent.run_id).where(
                Run.conversation_id == run.conversation_id, Run.profile_id == PROFILE_ID,
                RunEvent.kind == "file_read_progress"))
            for row in rows:
                if row.data.get("file_id") == file_id:
                    for first, last in row.data.get("read_ranges", []):
                        indices.extend(range(first, last + 1))
            db.add(RunEvent(run_id=run_id, kind="file_read_progress", data={
                "file_id": file_id, "read_ranges": ranges(indices), "total_parts": total,
                "source_truncated": any("截断" in item or "仅解析" in item or "仅提取" in item for item in warnings)}))
            db.commit()
    covered = len(set(indices))
    return {"read_ranges": ranges(indices), "read_parts": covered, "total_parts": total,
            "complete": covered == total, "scope": "已解析正文；解析警告中的缺失内容不在此范围"}


def search(chunks, query, offset=0, limit=8):
    from .retrieval import terms
    if not query.strip() or len(query) > 1000 or not 0 <= offset <= len(chunks) or not 1 <= limit <= 20:
        raise ValueError("query为1–1000字，offset从0开始，limit为1–20。")
    tokens = terms(query)
    texts = [part["text"].casefold() for part in chunks]
    frequency = Counter(token for token in tokens for text in texts if token in text)
    ranked = []
    for index, (chunk, text) in enumerate(zip(chunks, texts), 1):
        matched = [token for token in tokens if token in text]
        if not matched:
            continue
        score = sum(math.log(1 + len(chunks) / (1 + frequency[token])) for token in matched)
        if query.casefold() in text:
            score += 20
        first = min((text.find(token) for token in matched if token in text), default=0)
        start = max(0, first - 200)
        ranked.append({"part": index, "source": chunk["source"], "score": round(score, 4),
                       "excerpt": chunk["text"][start:start + 1000], "excerpt_offset": start,
                       "read_start": max(1, index - 1)})
    ranked.sort(key=lambda value: (-value["score"], value["part"]))
    end = min(len(ranked), offset + limit)
    return {"matches": ranked[offset:end], "total_matches": len(ranked), "searched_parts": len(chunks),
            "next_offset": end if end < len(ranked) else None,
            "notice": "仅关键词匹配，命中位置用read_file读取原文与相邻片段；未命中不等于全文无答案。"}


def verify_claims(run_id, text):
    import re
    with Session() as db:
        events = list(db.scalars(select(RunEvent).where(RunEvent.run_id == run_id,
            RunEvent.kind == "file_read_progress").order_by(RunEvent.id)))
    latest = {event.data["file_id"]: event.data for event in events}
    incomplete = [value for value in latest.values() if value.get("source_truncated") or
                  sum(last - first + 1 for first, last in value["read_ranges"]) < value["total_parts"]]
    if not incomplete:
        return text
    lines = []
    for line in text.splitlines():
        if re.search(r"(?:完整|全部|逐节).{0,8}(?:读完|阅读|读取)|(?:全文|整篇|整个文档).{0,12}(?:没有|不存在|未提到|未提及)", line):
            lines.append("当前只读取了部分已解析正文，尚不能确认全文是否包含所需信息；需继续定位或读取。")
        else:
            lines.append(line)
    return "\n".join(lines)
