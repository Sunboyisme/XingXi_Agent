"""Civil-time recurrence expansion; series anchors never drift on short months."""

import calendar
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo


def utc(value):
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def local_start(plan):
    zone = ZoneInfo(plan.timezone)
    value = datetime.fromisoformat(plan.start)
    return value.replace(tzinfo=zone) if plan.all_day else value.astimezone(zone)


def occurrence(plan, index):
    if index < 0 or (plan.recurrence == "none" and index):
        return None
    if getattr(plan, "repeat_count", None) is not None and index >= plan.repeat_count:
        return None
    base = local_start(plan)
    if plan.recurrence == "monthly":
        month = base.year * 12 + base.month - 1 + index * plan.repeat_interval
        year, month = divmod(month, 12)
        start = base.replace(
            year=year,
            month=month + 1,
            day=min(base.day, calendar.monthrange(year, month + 1)[1]),
        )
    else:
        step = (7 if plan.recurrence == "weekly" else 1) * plan.repeat_interval
        start = base + timedelta(days=index * step)
    if getattr(plan, "repeat_until", None) and start.date().isoformat() > plan.repeat_until:
        return None
    end = datetime.fromisoformat(plan.end)
    end = (
        end.replace(tzinfo=base.tzinfo) if plan.all_day else end.astimezone(base.tzinfo)
    )
    finish = start + (end.replace(tzinfo=None) - base.replace(tzinfo=None))
    return (
        (start.date().isoformat(), finish.date().isoformat())
        if plan.all_day
        else (utc(start), utc(finish))
    )


def index_near(plan, value):
    local = value.astimezone(ZoneInfo(plan.timezone))
    base = local_start(plan)
    if plan.recurrence == "none":
        return 0
    if plan.recurrence == "monthly":
        return max(
            0,
            ((local.year - base.year) * 12 + local.month - base.month)
            // plan.repeat_interval,
        )
    return max(
        0,
        (local.date() - base.date()).days
        // ((7 if plan.recurrence == "weekly" else 1) * plan.repeat_interval),
    )


def due_for(plan, start, offset):
    value = datetime.fromisoformat(start)
    zone = ZoneInfo(plan.timezone)
    local = value.replace(tzinfo=zone) if plan.all_day else value.astimezone(zone)
    return utc(local + timedelta(minutes=offset))
