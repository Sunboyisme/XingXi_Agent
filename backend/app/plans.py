"""Canonical plans. Reminder rows are private scheduling rules, never separate items."""

import re
from datetime import UTC, date, datetime, timedelta
from threading import RLock
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from .config import PROFILE_ID
from .db import (
    CalendarBatch,
    CalendarEvent,
    Notification,
    PlanOccurrence,
    PlanSegment,
    Reminder,
    Session,
    now,
)
from .plan_schedule import due_for, utc
from . import plan_recurrence as recurrence

lock = RLock()


class PlanWrite(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    notes: str = Field(default="", max_length=6000)
    start: str
    end: str
    all_day: bool = False
    timezone: str = "Asia/Shanghai"
    status: Literal["planned", "completed", "ended", "deleted"] = "planned"
    recurrence: Literal["none", "daily", "weekly", "monthly"] = "none"
    repeat_interval: int = Field(default=1, ge=1, le=365)
    repeat_until: str | None = None
    repeat_count: int | None = Field(default=None, ge=1, le=10000)
    calendar_display: Literal["summary", "always"] = "summary"
    reminder_enabled: bool = False
    reminder_offsets: list[int] | None = Field(
        default=None,
        max_length=10,
        description="相对每次计划开始的本地分钟偏移，可为负数；支持多个时间。",
    )
    reminder_time: str = "09:00"
    reminder_at: str | None = None

    @model_validator(mode="after")
    def validate_dates(self):
        try:
            zone = ZoneInfo(self.timezone)
        except (KeyError, ValueError):
            raise ValueError("无效时区") from None
        self.title = self.title.strip()
        if not self.title or not re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d", self.reminder_time
        ):
            raise ValueError("请检查标题与提醒时间")
        if self.all_day:
            start, end = date.fromisoformat(self.start), date.fromisoformat(self.end)
            self.start, self.end = start.isoformat(), end.isoformat()
            self.reminder_at = None
        else:
            start, end = (
                datetime.fromisoformat(self.start),
                datetime.fromisoformat(self.end),
            )
            if start.tzinfo is None or end.tzinfo is None:
                raise ValueError("时间必须包含时区")
            self.start, self.end = utc(start), utc(end)
            if self.reminder_at is not None:
                reminder = datetime.fromisoformat(self.reminder_at)
                if reminder.tzinfo is None:
                    raise ValueError("提醒时间必须包含时区")
                self.reminder_at = utc(reminder)
        if end <= start:
            raise ValueError("结束须晚于开始；全天结束日期不包含当天")
        if self.repeat_until and self.repeat_count is not None:
            raise ValueError("截止日期和重复次数只能选择一项")
        if self.repeat_until:
            date.fromisoformat(self.repeat_until)
            first_date = start.astimezone(zone).date() if isinstance(start, datetime) else start
            if self.repeat_until < first_date.isoformat() and not hasattr(self, "series_start"):
                raise ValueError("重复截止日期不能早于开始日期")
        if self.recurrence == "none" and (self.repeat_until or self.repeat_count):
            raise ValueError("不重复的计划不能设置重复截止条件")
        if self.reminder_offsets is None:
            if self.all_day:
                h, m = map(int, self.reminder_time.split(":"))
                self.reminder_offsets = [h * 60 + m]
            elif self.reminder_at:
                self.reminder_offsets = [
                    round(
                        (
                            datetime.fromisoformat(self.reminder_at)
                            .astimezone(zone)
                            .replace(tzinfo=None)
                            - start.astimezone(zone).replace(tzinfo=None)
                        ).total_seconds()
                        / 60
                    )
                ]
            else:
                self.reminder_offsets = [0]
        if len(set(self.reminder_offsets)) != len(self.reminder_offsets) or any(
            abs(x) > 525600 for x in self.reminder_offsets
        ):
            raise ValueError("提醒时间不能重复，且须在计划开始前后一年内")
        if self.reminder_enabled and not self.reminder_offsets:
            raise ValueError("请至少设置一个提醒时间")
        if self.reminder_offsets:
            offset = self.reminder_offsets[0]
            if self.all_day:
                minute = offset % 1440
                self.reminder_time = f"{minute // 60:02d}:{minute % 60:02d}"
            else:
                self.reminder_at = (
                    utc(start.astimezone(zone) + timedelta(minutes=offset))
                    if offset
                    else None
                )
        return self


class PlanRead(PlanWrite):
    id: str
    reminder_id: str | None = None
    source_message_id: str | None = None
    occurrence_start: str | None = None
    series_start: str
    series_end: str
    series_status: str = "planned"
    series_all_day: bool = False
    series_title: str = ""
    occurrence_index: int = 0
    next_reminder_at: str | None = None
    is_exception: bool = False


class PlanUpdate(PlanWrite):
    scope: Literal["this", "future", "series"] = "series"
    occurrence_start: str | None = None


class PlanBatch(BaseModel):
    events: list[PlanWrite] = Field(min_length=1, max_length=100)


class PlanAction(BaseModel):
    action: Literal["complete", "restore", "end_series", "disable_reminders"]
    occurrence_start: str | None = None


def find(db, key):
    row = db.get(CalendarEvent, key)
    if row is None or row.profile_id != PROFILE_ID:
        raise HTTPException(404, "计划不存在")
    return row


def rules(db, key):
    return list(
        db.scalars(
            select(Reminder)
            .where(Reminder.plan_id == key, Reminder.status != "removed")
            .order_by(Reminder.position, Reminder.created_at, Reminder.id)
        )
    )


def serialize(db, row, start=None, end=None, status=None, *, root=None, occurrence_key=None, index=0, series_title=None):
    master = root or row
    value = {field: getattr(row, field) for field in PlanWrite.model_fields}
    active = [r.due_at for r in rules(db, master.id) if r.status == "active"]
    value.update(
        id=master.id, reminder_id=master.reminder_id,
        source_message_id=master.source_message_id,
        series_start=master.start, series_end=master.end, series_status=master.status, series_all_day=master.all_day, series_title=series_title or master.title,
        occurrence_start=occurrence_key or start or row.start,
        occurrence_index=index, next_reminder_at=min(active) if active else None,
        is_exception=bool((record := db.get(PlanOccurrence, (master.id, occurrence_key or start or row.start))) and record.override),
    )
    if start is not None:
        value.update(start=start, end=end)
    if status:
        value["status"] = status
    return value


def occurrence_key(value):
    try:
        point = datetime.fromisoformat(value)
        return utc(point) if point.tzinfo else date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(422, "请提供有效的本次日期或含时区时间") from None


def read_occurrence(db, row, key):
    key = occurrence_key(key)
    found = recurrence.resolve(db, row, key)
    if not found:
        raise HTTPException(422, "该日期不属于这个重复系列")
    rule, finish, index = found
    value, record = recurrence.effective(db, rule, key, finish)
    state = "completed" if record and record.status == "completed" else row.status
    return serialize(db, value, value.start, value.end, state, root=row, occurrence_key=key, index=index, series_title=rule.title)


def cancel_notes(db, key, start=None):
    query = select(Notification).where(
        Notification.plan_id == key,
        Notification.status.in_(["pending", "presented", "snoozed"]),
    )
    if start is not None:
        query = query.where(Notification.plan_occurrence_start == start)
    for note in db.scalars(query):
        note.status = "cancelled"


def completed(db, plan, start):
    row = db.get(PlanOccurrence, (plan.id, start))
    return row is not None and row.status == "completed"


def sync_rules(db, plan, offsets, reset=True):
    plan.reminder_offsets = list(offsets)
    union = list(offsets)
    for rule in recurrence.variants(db, plan):
        union.extend(offset for offset in rule.reminder_offsets if offset not in union)
    for record in db.scalars(select(PlanOccurrence).where(PlanOccurrence.plan_id == plan.id, PlanOccurrence.override.is_not(None))):
        union.extend(offset for offset in record.override.get("reminder_offsets", []) if offset not in union)
    existing, selected = rules(db, plan.id), []
    for position, offset in enumerate(union):
        rule = next((r for r in existing if r.offset_minutes == offset and r not in selected), None)
        if rule is None:
            rule = next((r for r in existing if r not in selected and r.offset_minutes not in union), None)
        changed = rule is not None and rule.offset_minutes != offset
        if rule is None:
            rule = Reminder(plan_id=plan.id, offset_minutes=offset, title=plan.title, body=plan.notes, timezone=plan.timezone, recurrence=plan.recurrence, due_at=due_for(plan, plan.start, offset))
            db.add(rule)
        if changed:
            for note in db.scalars(select(Notification).where(Notification.reminder_id == rule.id, Notification.status.in_(["pending", "presented", "snoozed"]))):
                note.status = "cancelled"
        rule.offset_minutes, rule.position = offset, position
        if plan.status != "planned":
            rule.status = "disabled"
        elif reset or changed or not rule.plan_occurrence_start:
            following = recurrence.next_due(db, plan, offset, datetime.now(UTC), allow_overdue=True)
            if following:
                rule.plan_occurrence_start, rule.due_at, value = following
                rule.title, rule.body, rule.timezone, rule.recurrence = value.title, value.notes, value.timezone, value.recurrence
                rule.status = "active"
            else:
                rule.status = "disabled"
        else:
            found = recurrence.resolve(db, plan, rule.plan_occurrence_start)
            if found:
                value, _ = recurrence.effective(db, found[0], rule.plan_occurrence_start, found[1])
                rule.title, rule.body = value.title, value.notes
        selected.append(rule)
    for rule in existing:
        if rule not in selected:
            rule.status = "removed"
            for note in db.scalars(select(Notification).where(Notification.reminder_id == rule.id, Notification.status.in_(["pending", "presented", "snoozed"]))):
                note.status = "cancelled"
    db.flush()
    plan.reminder_id = selected[0].id if selected else None
    if plan.status != "planned":
        cancel_notes(db, plan.id)


def create_events(values, source_message_id=None):
    with lock, Session() as db:
        previous = (
            db.get(CalendarBatch, source_message_id) if source_message_id else None
        )
        if previous:
            return [
                serialize(db, row)
                for key in previous.event_ids
                if (row := db.get(CalendarEvent, key)) is not None
            ]
        result = []
        for value in values:
            if value.recurrence != "none" and value.status == "completed":
                raise HTTPException(422, "重复计划须明确完成本次，或结束整个系列")
            # A repeated tool call or an old reminder alias cannot create a second item.
            row = db.scalar(
                select(CalendarEvent).where(
                    CalendarEvent.profile_id == PROFILE_ID,
                    CalendarEvent.title == value.title,
                    CalendarEvent.start == value.start,
                    CalendarEvent.end == value.end,
                    CalendarEvent.status != "deleted",
                    CalendarEvent.recurrence == value.recurrence,
                    CalendarEvent.repeat_interval == value.repeat_interval,
                    CalendarEvent.repeat_until == value.repeat_until,
                    CalendarEvent.repeat_count == value.repeat_count,
                    CalendarEvent.notes == value.notes,
                    CalendarEvent.all_day == value.all_day,
                )
            )
            if row is None:
                row = CalendarEvent(
                    **value.model_dump(),
                    source_message_id=source_message_id,
                )
                db.add(row)
                db.flush()
                sync_rules(db, row, value.reminder_offsets)
            result.append(row)
        if source_message_id:
            db.add(
                CalendarBatch(
                    source_message_id=source_message_id,
                    event_ids=[r.id for r in result],
                )
            )
        db.commit()
        return [serialize(db, row) for row in result]


def update_event(key, value):
    with lock, Session() as db:
        row = find(db, key)
        if value.recurrence != "none" and value.status == "completed":
            raise HTTPException(422, "重复计划请完成本次，或明确结束整个系列")
        scope = getattr(value, "scope", "series")
        data = value.model_dump(include=set(PlanWrite.model_fields))
        if scope != "series":
            key_start = occurrence_key(getattr(value, "occurrence_start", None))
            found = recurrence.resolve(db, row, key_start)
            if not found:
                raise HTTPException(422, "该日期不属于这个重复系列")
            if row.recurrence == "none" and not db.scalar(select(PlanSegment).where(PlanSegment.plan_id == key)):
                raise HTTPException(422, "不重复的计划无需选择修改范围")
            if scope == "this":
                center = datetime.fromisoformat(value.start).date()
                for _, other, origin, _, _ in recurrence.instances(db, row, (center - timedelta(days=2)).isoformat(), (center + timedelta(days=3)).isoformat()):
                    if origin != key_start and other.start == value.start and other.all_day == value.all_day:
                        raise HTTPException(422, "同一时间已有本系列的事项，请选择其他时间")
                record = db.get(PlanOccurrence, (key, key_start))
                if record is None:
                    record = PlanOccurrence(plan_id=key, start=key_start, status="planned")
                    db.add(record)
                record.override = data
                cancel_notes(db, key, key_start)
            else:
                if value.recurrence == "none":
                    raise HTTPException(422, "结束重复请使用结束整个系列，或修改整个系列的重复规则")
                boundary = recurrence.day_of(key_start, found[0].timezone)
                if recurrence.day_of(value.start, value.timezone) < boundary:
                    raise HTTPException(422, "本次及以后不能移到所选日期之前，请选择仅本次")
                for segment in db.scalars(select(PlanSegment).where(PlanSegment.plan_id == key, PlanSegment.from_day >= boundary)):
                    db.delete(segment)
                db.flush()
                db.add(PlanSegment(plan_id=key, from_day=boundary, value=data))
                for note in db.scalars(select(Notification).where(Notification.plan_id == key, Notification.status.in_(["pending", "presented", "snoozed"]))):
                    if note.plan_occurrence_start and recurrence.day_of(note.plan_occurrence_start, row.timezone) >= boundary:
                        note.status = "cancelled"
            db.flush()
            sync_rules(db, row, row.reminder_offsets)
        else:
            reset = any(getattr(row, name) != getattr(value, name) for name in ("start", "end", "timezone", "recurrence", "repeat_interval", "repeat_until", "repeat_count", "reminder_enabled", "reminder_offsets", "status"))
            pattern_changed = any(getattr(row, name) != getattr(value, name) for name in ("start", "end", "all_day", "timezone", "recurrence", "repeat_interval", "repeat_until", "repeat_count"))
            changed_fields = {name: item for name, item in data.items() if getattr(row, name) != item}
            for segment in db.scalars(select(PlanSegment).where(PlanSegment.plan_id == key)):
                if pattern_changed:
                    db.delete(segment)
                else:
                    segment.value = {**segment.value, **changed_fields, **({"reminder_enabled": False} if not value.reminder_enabled else {})}
                reset = True
            for name, item in data.items():
                setattr(row, name, item)
            if not value.reminder_enabled:
                cancel_notes(db, key)
                for record in db.scalars(select(PlanOccurrence).where(PlanOccurrence.plan_id == key, PlanOccurrence.override.is_not(None))):
                    record.override = {**record.override, "reminder_enabled": False}
            if reset:
                cancel_notes(db, row.id)
            db.flush()
            sync_rules(db, row, value.reminder_offsets, reset)
        db.commit()
        if scope == "this":
            return read_occurrence(db, row, key_start)
        if scope == "future":
            return read_occurrence(db, row, value.start)
        return serialize(db, row)


def delete_event(key):
    with lock, Session() as db:
        row = find(db, key)
        row.status = "deleted"
        for rule in rules(db, key):
            rule.status = "cancelled"
        cancel_notes(db, key)
        db.commit()


def act(key, value):
    with lock, Session() as db:
        row = find(db, key)
        if value.action == "disable_reminders":
            row.reminder_enabled = False
            for segment in db.scalars(select(PlanSegment).where(PlanSegment.plan_id == key)):
                segment.value = {**segment.value, "reminder_enabled": False}
            for record in db.scalars(select(PlanOccurrence).where(PlanOccurrence.plan_id == key, PlanOccurrence.override.is_not(None))):
                record.override = {**record.override, "reminder_enabled": False}
            for rule in rules(db, key):
                rule.status = "disabled"
            cancel_notes(db, key)
        elif value.action == "end_series":
            row.status = "ended"
            for rule in rules(db, key):
                rule.status = "cancelled"
            cancel_notes(db, key)
        else:
            start = value.occurrence_start
            if row.recurrence != "none" and not start:
                raise HTTPException(
                    422, "重复计划需要指定本次日期；结束整个系列请使用 end_series"
                )
            start = occurrence_key(start or row.start)
            if not recurrence.resolve(db, row, start):
                raise HTTPException(422, "该日期不属于这个重复系列")
            record = db.get(PlanOccurrence, (key, start))
            if value.action == "complete":
                if record is None:
                    db.add(PlanOccurrence(plan_id=key, start=start, status="completed"))
                else:
                    record.status, record.completed_at = "completed", now()
                if row.recurrence == "none":
                    row.status = "completed"
                cancel_notes(db, key, start)
                db.flush()
                sync_rules(db, row, row.reminder_offsets)
            else:
                if record:
                    if record.override:
                        record.status = "planned"
                    else:
                        db.delete(record)
                if row.recurrence == "none":
                    row.status = "planned"
                    sync_rules(db, row, [r.offset_minutes for r in rules(db, key)])
                elif row.status == "planned":
                    # A future occurrence may have been skipped while completed.
                    # Restoring it must not move any later occurrence or notification.
                    for rule in rules(db, key):
                        db.flush()
                        following = recurrence.next_due(db, row, rule.offset_minutes, datetime.now(UTC))
                        if following and (rule.status != "active" or following[1] < rule.due_at):
                            rule.plan_occurrence_start, rule.due_at, _ = following
                            rule.status = "active"
        db.commit()
        if value.action in ("complete", "restore"):
            return read_occurrence(db, row, start)
        return serialize(db, row)


def list_events(start=None, end=None):
    if start:
        date.fromisoformat(start)
    if end:
        date.fromisoformat(end)
    if bool(start) != bool(end):
        raise ValueError("请同时指定日期范围")
    if start and (end <= start or (date.fromisoformat(end) - date.fromisoformat(start)).days > 370):
        raise ValueError("日期范围须为 1–370 天")
    with lock, Session() as db:
        rows = list(db.scalars(select(CalendarEvent).where(CalendarEvent.profile_id == PROFILE_ID, CalendarEvent.status != "deleted").order_by(CalendarEvent.start)))
        if not start:
            return [serialize(db, row) for row in rows]
        result = []
        for row in rows:
            for rule, value, key, record, index in recurrence.instances(db, row, start, end):
                state = "completed" if record and record.status == "completed" else row.status
                if row.status != "ended" or state == "completed":
                    result.append(serialize(db, value, value.start, value.end, state, root=row, occurrence_key=key, index=index, series_title=rule.title))
                if len(result) > 5000:
                    raise ValueError("当前范围计划过多，请缩小范围")
        return sorted(result, key=lambda item: (item["start"], item["id"]))
