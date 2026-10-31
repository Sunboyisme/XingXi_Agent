"""Resolve short replies against this conversation, without inventing a task."""

import re
import threading
import time

from sqlalchemy import and_, or_, select

from .config import PROFILE_ID
from .db import MESSAGE_ORDER, Message

_CONFIRMATION = re.compile(
    r"(?:确认|确定|同意|可以|好的|好|行|对|是的|没问题|就这样|写入|创建|保存|安排|"
    r"按这个方案|就按这个方案|ok|okay|yes)"
    r"(?:的|吧)?(?:你)?(?:把这个|按这个方案|按这个|直接)?"
    r"(?:创建|安排|保存|写入|写进)?(?:日历里?|日程里?|日志里?)?(?:吧)?",
    re.IGNORECASE,
)


class ProposalStore:
    """Per-conversation proposals waiting for the user's next-turn confirmation."""

    def __init__(self, ttl=24 * 60 * 60):
        self.ttl = ttl
        self.lock = threading.Lock()
        self._items: dict[str, dict] = {}

    def put(self, key, value):
        with self.lock:
            now = time.time()
            # Expired proposals of other conversations are dropped here, so the
            # cache cannot grow with every conversation that never confirms.
            for stale in [k for k, v in self._items.items() if now - v["created_at"] > self.ttl]:
                del self._items[stale]
            self._items[key] = {**value, "created_at": now}

    def get(self, key):
        with self.lock:
            value = self._items.get(key)
            if value and time.time() - value["created_at"] > self.ttl:
                del self._items[key]
                return None
            return value

    def pop(self, key):
        with self.lock:
            self._items.pop(key, None)


def is_confirmation(text: str) -> bool:
    compact = re.sub(r"[\s，,。.!！~～]", "", text or "")
    compound = re.fullmatch(r"(?:(?:可以|好的|好|行|确认|确定|同意)[，,]?)?(?:就)?按(?:这个|上述|刚才的|上面这份)(?:方案|安排)(?:执行|创建|写入|写进日历)?(?:吧)?", compact, re.IGNORECASE)
    return bool(compact) and bool(_CONFIRMATION.fullmatch(compact) or compound)


def choice_context(db, message):
    """Resolve a short selection only against the immediately preceding reply."""
    from . import clarifications
    structured = clarifications.choice_context(db, message)
    if structured:
        return structured
    compact = re.sub(r"[\s。！!，,]", "", message.content or "")
    if not re.fullmatch(r"(?:选|选择|第)?[1-9](?:个|项)?|都要|全部|两个都要|都选", compact):
        return None
    previous = prior_messages(db, message, limit=1)
    if not previous or previous[0].role != "assistant":
        return {"error": "这次选择对应哪一个选项？请补充选项内容。"}
    reply = previous[0]
    # Numbered option paragraphs only, never a code block or an ordinary list
    # that the assistant did not invite the user to select from.
    text = re.sub(r"```[\s\S]*?```", "", reply.content)
    if not re.search(r"选|回.{0,5}[1-9]|[1-9].{0,8}或.{0,8}[1-9]|都要", text):
        return {"error": "这次选择对应哪一个选项？请补充选项内容。"}
    matches = list(re.finditer(r"(?:^|\n)\s*(?:\*\*)?([1-9])\s*[.、．）):：]\s*", text))
    options = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end].strip()
        body = re.split(r"\n\s*(?:你(?:回|选)|请(?:回|选)|回复|选择)", body)[0].strip()
        if match[1] in options:
            return {"error": "上一条回复包含多组编号，请说明选择的具体内容。"}
        options[match[1]] = body
    selected = list(options) if compact in {"都要", "全部", "两个都要", "都选"} else re.search(r"[1-9]", compact)[0]
    if len(options) < 2 or any(key not in options for key in selected):
        return {"error": "没有找到这次选择对应的明确选项，请补充选项内容。"}
    return {"source_message_id": reply.id, "source_created_at": reply.created_at,
            "selected": [{"number": key, "content": options[key]} for key in selected],
            "context": prior_context(db, message)}


def prior_messages(db, message, limit=16):
    """Only messages preceding this run's source, including equal-time imports."""
    ordinal = select(MESSAGE_ORDER).where(Message.id == message.id).correlate(None).scalar_subquery()
    return list(reversed(db.scalars(select(Message).where(
        Message.conversation_id == message.conversation_id,
        Message.profile_id == PROFILE_ID,
        or_(Message.created_at < message.created_at,
            and_(Message.created_at == message.created_at, MESSAGE_ORDER < ordinal)),
    ).order_by(Message.created_at.desc(), MESSAGE_ORDER.desc()).limit(limit)).all()))


def prior_context(db, message):
    records = prior_messages(db, message)
    # Keep the last substantive request and the proposal the user saw. This
    # also recovers chains of "可以" -> clarification -> "同意" from older runs.
    start = next((index for index in range(len(records) - 1, -1, -1)
                  if records[index].role == "user" and not is_confirmation(records[index].content)), 0)
    return [{"id": value.id, "role": value.role, "text": value.content[:12000],
             "truncated": len(value.content) > 12000}
            for value in records[start:] if not (value.provider_context or {}).get("incomplete")]
