"""Resolve short replies against this conversation, without inventing a task."""

import re

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


def is_confirmation(text: str) -> bool:
    compact = re.sub(r"[\s，,。.!！~～]", "", text or "")
    return bool(compact) and bool(_CONFIRMATION.fullmatch(compact))


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
