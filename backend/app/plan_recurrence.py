"""Sparse rule segments and single-instance overrides; every instance keeps one plan id."""
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import PlanOccurrence, PlanSegment
from .plan_schedule import due_for, index_near, occurrence

FIELDS = ("title", "notes", "start", "end", "all_day", "timezone", "status", "recurrence", "repeat_interval", "repeat_until", "repeat_count", "calendar_display", "reminder_enabled", "reminder_offsets", "reminder_time", "reminder_at")
RULE_FIELDS = {"recurrence", "repeat_interval", "repeat_until", "repeat_count", "calendar_display", "status"}


def day_of(value, zone):
    parsed = datetime.fromisoformat(value)
    return parsed.astimezone(ZoneInfo(zone)).date().isoformat() if parsed.tzinfo else parsed.date().isoformat()


def variants(db, plan):
    changes = list(db.scalars(select(PlanSegment).where(PlanSegment.plan_id == plan.id).order_by(PlanSegment.from_day)))
    values = [(None, {name: getattr(plan, name) for name in FIELDS})] + [(row.from_day, row.value) for row in changes]
    return [SimpleNamespace(**value, id=plan.id, window_start=begin, window_end=values[index + 1][0] if index + 1 < len(values) else None) for index, (begin, value) in enumerate(values)]


def in_window(rule, key):
    day = day_of(key, rule.timezone)
    return (not rule.window_start or day >= rule.window_start) and (not rule.window_end or day < rule.window_end)


def resolve(db, plan, key):
    point = datetime.fromisoformat(key)
    if not point.tzinfo:
        point = point.replace(tzinfo=ZoneInfo(plan.timezone))
    for rule in variants(db, plan):
        index = index_near(rule, point)
        times = occurrence(rule, index)
        if times and times[0] == key and in_window(rule, key):
            return rule, times[1], index
    return None


def count_before_day(rule, day):
    """Count rule instances strictly before a local day, without expanding years."""
    unbounded = SimpleNamespace(**{name: getattr(rule, name) for name in FIELDS})
    unbounded.repeat_count = unbounded.repeat_until = None

    def count(boundary):
        point = datetime.fromisoformat(boundary).replace(tzinfo=ZoneInfo(rule.timezone))
        index = index_near(unbounded, point)
        times = occurrence(unbounded, index)
        return index + int(bool(times and day_of(times[0], rule.timezone) < boundary))

    result = count(day)
    if rule.repeat_count is not None:
        result = min(result, rule.repeat_count)
    if rule.repeat_until:
        end = (datetime.fromisoformat(rule.repeat_until) + timedelta(days=1)).date().isoformat()
        result = min(result, count(end))
    return result


def position(db, plan, rule, index):
    """Absolute ordinal across rule segments, used when rebasing a whole series."""
    total = 0
    for candidate in variants(db, plan):
        first = count_before_day(candidate, candidate.window_start) if candidate.window_start else 0
        if candidate.window_start == rule.window_start:
            return total + index - first
        if candidate.window_end:
            total += max(0, count_before_day(candidate, candidate.window_end) - first)
    raise ValueError("无法定位已有事项在系列中的位置")


def effective(db, rule, key, end):
    record = db.get(PlanOccurrence, (rule.id, key))
    values = {name: getattr(rule, name) for name in FIELDS}
    values.update(start=key, end=end)
    if record and record.override:
        values.update({name: value for name, value in record.override.items() if name not in RULE_FIELDS})
    return SimpleNamespace(**values, id=rule.id), record


def overlaps(value, start, end):
    begin_day = day_of(value.start, value.timezone)
    finish = datetime.fromisoformat(value.end)
    if not value.all_day:
        finish = finish.astimezone(ZoneInfo(value.timezone)) - timedelta(microseconds=1)
    last_day = finish.date().isoformat()
    return begin_day < end and (last_day > start if value.all_day else last_day >= start)


def instances(db, plan, start, end):
    seen = set()
    for rule in variants(db, plan):
        local = datetime.fromisoformat(start).replace(tzinfo=ZoneInfo(rule.timezone))
        duration = max(1, (datetime.fromisoformat(rule.end).date() - datetime.fromisoformat(rule.start).date()).days + 1)
        index = max(0, index_near(rule, local - timedelta(days=duration)) - 1)
        for _ in range(1000):
            times = occurrence(rule, index)
            if not times or day_of(times[0], rule.timezone) >= end or (rule.window_end and day_of(times[0], rule.timezone) >= rule.window_end):
                break
            key, finish = times
            if in_window(rule, key):
                value, record = effective(db, rule, key, finish)
                seen.add(key)
                if overlaps(value, start, end):
                    yield rule, value, key, record, index
            index += 1
    # A moved instance can lie outside the query range of its original date.
    for record in db.scalars(select(PlanOccurrence).where(PlanOccurrence.plan_id == plan.id, PlanOccurrence.override.is_not(None))):
        if record.start in seen:
            continue
        found = resolve(db, plan, record.start)
        if found:
            rule, finish, index = found
            value, _ = effective(db, rule, record.start, finish)
            if overlaps(value, start, end):
                yield rule, value, record.start, record, index


def next_due(db, plan, offset, after, allow_overdue=False):
    if plan.status != "planned":
        return None
    candidates = []

    def add(rule, key, finish):
        value, record = effective(db, rule, key, finish)
        if not value.reminder_enabled or offset not in value.reminder_offsets or (record and record.status == "completed"):
            return False
        due = due_for(value, value.start, offset)
        if datetime.fromisoformat(due) > after or (allow_overdue and rule.recurrence == "none"):
            candidates.append((key, due, value))
            return not bool(record and record.override)
        return False

    for rule in variants(db, plan):
        if not rule.reminder_enabled or offset not in rule.reminder_offsets:
            continue
        index = max(0, index_near(rule, after - timedelta(minutes=offset)) - 2)
        if rule.window_start:
            boundary = datetime.fromisoformat(rule.window_start).replace(tzinfo=ZoneInfo(rule.timezone))
            index = max(index, index_near(rule, boundary) - 1)
        for _ in range(10000):
            times = occurrence(rule, index)
            if not times or (rule.window_end and day_of(times[0], rule.timezone) >= rule.window_end):
                break
            if in_window(rule, times[0]) and add(rule, *times):
                break
            index += 1
    for record in db.scalars(select(PlanOccurrence).where(PlanOccurrence.plan_id == plan.id, PlanOccurrence.override.is_not(None))):
        found = resolve(db, plan, record.start)
        if found:
            add(found[0], record.start, found[1])
    return min(candidates, key=lambda value: value[1]) if candidates else None
