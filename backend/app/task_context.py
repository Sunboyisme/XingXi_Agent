"""Bound execution identity shared by tools, without changing their public schemas."""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field

from sqlalchemy import select

from .db import MESSAGE_ORDER, Message, Run
from .config import PROFILE_ID


@dataclass
class Execution:
    task_id: str
    step_id: str
    revision: int
    message_id: str
    model_config: dict = field(default_factory=dict)
    consumed: set[str] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    operation_id: str = ""
    corrections: int = 0


current: ContextVar[Execution | None] = ContextVar("complex_task", default=None)


class TaskControl(Exception):
    """Stop this agent loop at a tool boundary, without fabricating a reply."""


class Replan(TaskControl):
    pass


class ToolInputLimit(TaskControl):
    """A bounded, actionable failure after rejected ordinary-chat tool inputs."""


def user_message(db, run_id, conversation_id):
    execution = current.get()
    run = db.get(Run, run_id)
    message_id = execution.message_id if execution else (run.source_message_id if run else None)
    if message_id:
        message = db.get(Message, message_id)
        if message and message.conversation_id == conversation_id and message.role == "user" and message.profile_id == PROFILE_ID:
            return message
        raise ValueError("执行对应的用户消息不存在")
    return db.scalar(select(Message).where(
        Message.conversation_id == conversation_id, Message.role == "user", Message.profile_id == PROFILE_ID,
    ).order_by(Message.created_at.desc(), MESSAGE_ORDER.desc()).limit(1))
