import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import CalendarEvent, Notification, Reminder, Session, now
from . import plan_recurrence
from .plans import lock

_tick_lock = asyncio.Lock()
STARTED_AT = now()


def utc_text(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def next_occurrence(due_at: str, recurrence: str, zone: str, after: datetime) -> str:
    local = datetime.fromisoformat(due_at).astimezone(ZoneInfo(zone))
    local_now = after.astimezone(ZoneInfo(zone))
    step = 1 if recurrence == "daily" else 7
    days = max(1, (local_now.date() - local.date()).days // step) * step
    candidate = local + timedelta(days=days)
    while candidate <= local_now:
        candidate += timedelta(days=step)
    return utc_text(candidate)


async def tick() -> None:
    async with _tick_lock:
        current = datetime.now(UTC)
        current_text = utc_text(current)
        with lock, Session() as db:
            for note in db.scalars(select(Notification).where(Notification.status == "snoozed", Notification.snoozed_until <= current_text)):
                note.status, note.snoozed_until = "pending", None
            due = db.scalars(
                select(Reminder).where(
                    Reminder.status == "active", Reminder.due_at <= current_text
                )
            ).all()
            for reminder in due:
                plan = db.get(CalendarEvent, reminder.plan_id) if reminder.plan_id else None
                if plan:
                    from .plans import completed
                    if plan.status != "planned":
                        reminder.status = "disabled"
                        continue
                    found = plan_recurrence.resolve(db, plan, reminder.plan_occurrence_start)
                    value = plan_recurrence.effective(db, found[0], reminder.plan_occurrence_start, found[1])[0] if found else None
                    if not value or not value.reminder_enabled or reminder.offset_minutes not in value.reminder_offsets or completed(db, plan, reminder.plan_occurrence_start):
                        following = plan_recurrence.next_due(db, plan, reminder.offset_minutes, current)
                        if following:
                            reminder.plan_occurrence_start, reminder.due_at, _ = following
                        else:
                            reminder.status = "disabled"
                        continue
                occurrence = reminder.due_at
                existing = db.scalar(
                    select(Notification).where(
                        Notification.reminder_id == reminder.id,
                        Notification.occurrence_at == occurrence,
                    )
                )
                if not existing:
                    db.add(
                        Notification(
                            reminder_id=reminder.id,
                            occurrence_at=occurrence,
                            title=value.title if plan else reminder.title,
                            body=value.notes if plan else reminder.body,
                            overdue=occurrence < STARTED_AT,
                            plan_id=plan.id if plan else None,
                            plan_occurrence_start=reminder.plan_occurrence_start,
                        )
                    )
                if plan:
                    following = plan_recurrence.next_due(db, plan, reminder.offset_minutes, current)
                    if following:
                        reminder.plan_occurrence_start, reminder.due_at, _ = following
                    else:
                        reminder.status = "fired"
                elif reminder.recurrence == "none":
                    reminder.status = "fired"
                else:
                    reminder.due_at = next_occurrence(
                        occurrence, reminder.recurrence, reminder.timezone, current
                    )
            db.commit()
