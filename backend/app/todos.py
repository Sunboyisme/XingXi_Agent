"""Todos have optional reminders, but never own calendar events."""
import json
from datetime import UTC, datetime
from typing import Literal, TypedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from langchain_core.tools import tool
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func

from . import db as store, plans, reminders
from .config import PROFILE_ID
from .schemas import RecordRead

router = APIRouter()
INFO = {name: (label, description, False) for name, label, description in (
    ("list_todos", "查询待办", "查询独立于日历的待办事项"),
    ("create_todo", "新增待办", "保存无排期的待办，可单独设置提醒"),
    ("update_todo", "修改待办", "修改已查询的待办及提醒"),
    ("action_todo", "处理待办", "完成、恢复或删除已查询的待办"))}


class TodoWrite(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    notes: str = Field(default="", max_length=6000)
    reminder_at: datetime | None = None
    timezone: str = "Asia/Shanghai"

    @field_validator("title")
    @classmethod
    def title_text(cls, value):
        if not value.strip():
            raise ValueError("请填写待办名称")
        return value.strip()

    @field_validator("reminder_at")
    @classmethod
    def aware(cls, value):
        if value and value.tzinfo is None:
            raise ValueError("提醒时间必须包含时区")
        return value

    @field_validator("timezone")
    @classmethod
    def zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("无效时区") from None
        return value


class TodoRead(RecordRead):
    title: str
    notes: str
    status: str
    reminder_at: str | None
    timezone: str


class TodoAction(BaseModel):
    action: Literal["complete", "restore", "delete"]


class TodoOrder(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=10000)
    status: Literal["active", "completed"] = "active"


@router.post("/todos/reorder")
def reorder(value: TodoOrder):
    with plans.lock, store.Session() as db:
        rows = db.scalars(select(store.Todo).where(store.Todo.profile_id == PROFILE_ID,
                         store.Todo.status == value.status)).all()
        if len(set(value.ids)) != len(value.ids):
            raise HTTPException(422, "排序不能包含重复待办")
        if set(value.ids) != {row.id for row in rows}:
            raise HTTPException(409, "待办列表已变化，请刷新后重新排序")
        positions = {key: index for index, key in enumerate(value.ids)}
        for row in rows:
            row.sort_order = positions[row.id]
        db.commit()
    return {"saved": True}


class TodoPatch(BaseModel):
    title: str | None = Field(default=None, max_length=300, description="省略时保留原名称")
    notes: str | None = Field(default=None, max_length=6000, description="省略时保留原备注，空字符串清空")
    reminder_at: datetime | None = Field(default=None, description="省略保留提醒；显式 null 取消提醒；时间必须带时区")
    timezone: str | None = Field(default=None, description="省略时保留原时区")


class TodoChanges(TypedDict, total=False):
    title: str | None
    notes: str | None
    reminder_at: str | None
    timezone: str | None


class TodoToolUpdate(BaseModel):
    todo_id: str
    changes: TodoChanges = Field(default_factory=dict, description="仅包含需要修改的字段；省略保留，reminder_at=null取消提醒")


def require(db, key):
    row = db.get(store.Todo, key)
    if not row or row.profile_id != PROFILE_ID or row.status == "deleted":
        raise HTTPException(404, "待办不存在或已经删除")
    return row


def cancel_reminders(db, key):
    for rule in db.scalars(select(store.Reminder).where(store.Reminder.todo_id == key)):
        rule.status = "removed"
    for note in db.scalars(select(store.Notification).where(store.Notification.todo_id == key)):
        if note.status in {"pending", "presented", "snoozed"}:
            note.status, note.snoozed_until = "cancelled", None
        for delivery in db.scalars(select(store.WechatDelivery).where(
                store.WechatDelivery.notification_id == note.id, store.WechatDelivery.status == "pending")):
            delivery.status = "cancelled"


def schedule(db, row):
    cancel_reminders(db, row.id)
    if row.status == "active" and row.reminder_at:
        db.add(store.Reminder(todo_id=row.id, title=row.title, body=row.notes,
                             due_at=row.reminder_at, timezone=row.timezone, recurrence="none"))


@router.get("/todos", response_model=list[TodoRead])
def list_todos(status: Literal["active", "completed", "all"] = "active", query: str = ""):
    with store.Session() as db:
        values = db.scalars(select(store.Todo).where(store.Todo.profile_id == PROFILE_ID,
            store.Todo.status != "deleted").order_by(store.Todo.sort_order, store.Todo.created_at, store.Todo.id))
        return [TodoRead.model_validate(row) for row in values if (status == "all" or row.status == status)
                and (not query or query.casefold() in (row.title + " " + row.notes).casefold())]


@router.get("/todos/{todo_id}", response_model=TodoRead)
def get_todo(todo_id: str):
    with store.Session() as db:
        return TodoRead.model_validate(require(db, todo_id))


def save(value, key=None):
    with plans.lock, store.Session() as db:
        row = require(db, key) if key else store.Todo()
        if key is None:
            row.sort_order = (db.scalar(select(func.max(store.Todo.sort_order)).where(store.Todo.profile_id == PROFILE_ID)) or 0) + 1
        due = reminders.utc_text(value.reminder_at) if value.reminder_at else None
        reminder_unchanged = bool(key and due == row.reminder_at)
        if due and value.reminder_at <= datetime.now(UTC) and (not key or due != row.reminder_at):
            raise HTTPException(422, "提醒时间已过去，请选择一个未来的时间。")
        row.title, row.notes, row.timezone, row.reminder_at = value.title, value.notes.strip(), value.timezone, due
        db.add(row)
        db.flush()
        if reminder_unchanged:
            # A text edit preserves fired/snoozed reminders and unread notices.
            for rule in db.scalars(select(store.Reminder).where(store.Reminder.todo_id == row.id)):
                rule.title, rule.body, rule.timezone = row.title, row.notes, row.timezone
            for note in db.scalars(select(store.Notification).where(store.Notification.todo_id == row.id,
                                    store.Notification.status.in_(["pending", "presented", "snoozed"]))):
                note.title, note.body = row.title, row.notes
        else:
            schedule(db, row)
        db.commit()
        return TodoRead.model_validate(row)


@router.post("/todos", response_model=TodoRead)
def create(value: TodoWrite):
    return save(value)


@router.put("/todos/{todo_id}", response_model=TodoRead)
def update(todo_id: str, value: TodoWrite):
    return save(value, todo_id)


@router.post("/todos/{todo_id}/action", response_model=TodoRead)
def action(todo_id: str, value: TodoAction):
    with plans.lock, store.Session() as db:
        row = require(db, todo_id)
        if value.action == "restore":
            if row.status != "active":
                row.status = "active"
                if row.reminder_at and datetime.fromisoformat(row.reminder_at) <= datetime.now(UTC):
                    row.reminder_at = None
                schedule(db, row)
        else:
            row.status = "completed" if value.action == "complete" else "deleted"
            cancel_reminders(db, row.id)
        db.commit()
        return TodoRead.model_validate(row)


@router.delete("/todos/{todo_id}", response_model=TodoRead)
def remove(todo_id: str):
    return action(todo_id, TodoAction(action="delete"))


def build(run_id, conversation_id):
    def output(value):
        return json.dumps(value.model_dump(mode="json") if isinstance(value, BaseModel)
                          else [row.model_dump(mode="json") for row in value], ensure_ascii=False)

    @tool
    def list_todos(query: str = "", status: Literal["active", "completed", "all"] = "active") -> str:
        """查询独立待办。修改、完成或删除之前先查询核对；不要求日历日期。"""
        return output(globals()["list_todos"](status, query))

    @tool
    def create_todo(title: str, notes: str = "", reminder_at: str | None = None, timezone: str = "Asia/Shanghai") -> str:
        """用户要求新增待办时保存。待办无排期，提醒可留空；提醒日期或时刻有歧义先询问。"""
        return output(create(TodoWrite(title=title, notes=notes, reminder_at=reminder_at, timezone=timezone)))

    @tool(args_schema=TodoToolUpdate)
    def update_todo(todo_id: str, changes: TodoChanges) -> str:
        """先查询目标再修改待办。仅传需修改的字段，省略的字段保留；显式reminder_at=null取消提醒。"""
        with plans.lock:
            with store.Session() as db:
                row = require(db, todo_id)
                payload = {key: getattr(row, key) for key in ("title", "notes", "reminder_at", "timezone")}
            patch = TodoPatch.model_validate(changes).model_dump(exclude_unset=True)
            payload.update({key: value for key, value in patch.items() if key in payload
                            and (value is not None or key == "reminder_at")})
            return output(update(todo_id, TodoWrite(**payload)))

    @tool
    def action_todo(todo_id: str, action: Literal["complete", "restore", "delete"]) -> str:
        """先查询核对待办再完成、恢复或删除；同名有歧义时询问，不能猜编号。"""
        return output(globals()["action"](todo_id, TodoAction(action=action)))

    return [list_todos, create_todo, update_todo, action_todo]
