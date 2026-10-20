import asyncio
from datetime import datetime

import pytest

from app import plans, reminders
from app.db import PlanOccurrence, PlanSegment, Session
from sqlalchemy import select

from .test_app import API


def value(**changes):
    return {"title": "早间安排", "start": "2026-11-01T09:00:00+08:00", "end": "2026-11-01T10:00:00+08:00", "recurrence": "daily", **changes}


def create(client, **changes):
    response = client.post(API + "/plans", json=value(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def rows(client, start="2026-11-01", end="2026-11-10"):
    response = client.get(API + f"/plans?start={start}&end={end}")
    assert response.status_code == 200, response.text
    return response.json()


def clock(monkeypatch, instant):
    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            point = datetime.fromisoformat(instant)
            return point.astimezone(tz) if tz else point.replace(tzinfo=None)
    monkeypatch.setattr(plans, "datetime", Fixed)
    monkeypatch.setattr(reminders, "datetime", Fixed)


@pytest.mark.parametrize("limit,expected", [({"repeat_count": 3}, 3), ({"repeat_until": "2026-11-02"}, 2)])
def test_repeat_limits_bound_calendar_and_scheduler(client, monkeypatch, limit, expected):
    clock(monkeypatch, "2026-10-30T00:00:00+00:00")
    plan = create(client, reminder_enabled=True, reminder_offsets=[0], **limit)
    assert len(rows(client)) == expected
    for day in range(1, 6):
        clock(monkeypatch, f"2026-11-0{day}T01:01:00+00:00")
        asyncio.run(reminders.tick())
    notes = client.get(API + "/notifications").json()
    assert len(notes) == expected
    assert all(note["plan_id"] == plan["id"] for note in notes)
    assert all(rule["status"] != "active" for rule in client.get(API + "/reminders").json())


def test_month_end_count_stays_anchored_and_until_is_local_inclusive(client):
    create(client, start="2027-01-31T00:30:00+08:00", end="2027-01-31T01:00:00+08:00", recurrence="monthly", repeat_until="2027-03-31")
    expanded = rows(client, "2027-01-01", "2027-05-01")
    assert [row["start"][:10] for row in expanded] == ["2027-01-30", "2027-02-27", "2027-03-30"]
    assert len(expanded) == 3
    response = client.post(API + "/plans", json=value(repeat_until="2026-11-04", repeat_count=2))
    assert response.status_code == 422


def test_single_edit_moves_one_instance_without_copying_plan_or_losing_completion(client, monkeypatch):
    clock(monkeypatch, "2026-10-30T00:00:00+00:00")
    plan = create(client, repeat_count=4, reminder_enabled=True)
    original = rows(client)[1]
    response = client.put(f"{API}/plans/{plan['id']}", json=value(title="只调整这次", start="2026-11-07T12:00:00+08:00", end="2026-11-07T13:00:00+08:00", recurrence="none", reminder_enabled=True, scope="this", occurrence_start=original["occurrence_start"]))
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "只调整这次"
    expanded = rows(client)
    assert len(expanded) == 4 and len(client.get(API + "/plans").json()) == 1
    moved = next(row for row in expanded if row["title"] == "只调整这次")
    assert moved["start"].startswith("2026-11-07T04:00")
    assert moved["occurrence_start"] == original["occurrence_start"]
    assert all(row["id"] == plan["id"] for row in expanded)
    for action in ["complete", "restore"]:
        assert client.post(f"{API}/plans/{plan['id']}/action", json={"action": action, "occurrence_start": moved["occurrence_start"]}).status_code == 200
    moved_again = next(row for row in rows(client) if row["is_exception"])
    assert moved_again["title"] == moved["title"] and moved_again["status"] == "planned"
    clock(monkeypatch, "2026-11-06T00:00:00+00:00")
    # Rescheduling must retain an exception moved beyond the series' last date.
    with Session() as db:
        candidate = plans.recurrence.next_due(db, db.get(plans.CalendarEvent, plan["id"]), 0, datetime.fromisoformat("2026-11-06T00:00:00+00:00"))
        assert candidate[0] == original["occurrence_start"]


def test_moved_later_reminder_does_not_hide_earlier_normal_instances(client, monkeypatch):
    clock(monkeypatch, "2026-10-30T00:00:00+00:00")
    plan = create(client, repeat_count=4, reminder_enabled=True)
    original = rows(client)[0]
    response = client.put(f"{API}/plans/{plan['id']}", json=value(title="晚些执行", start="2026-11-08T09:00:00+08:00", end="2026-11-08T10:00:00+08:00", recurrence="none", reminder_enabled=True, scope="this", occurrence_start=original["occurrence_start"]))
    assert response.status_code == 200
    rule = client.get(API + "/reminders").json()[0]
    assert rule["due_at"].startswith("2026-11-02")


def test_future_edit_keeps_id_prefix_history_and_previous_completion(client):
    plan = create(client, repeat_count=6, reminder_enabled=True)
    previous = rows(client)
    client.post(f"{API}/plans/{plan['id']}/action", json={"action": "complete", "occurrence_start": previous[0]["occurrence_start"]})
    response = client.put(f"{API}/plans/{plan['id']}", json=value(title="之后改到下午", start="2026-11-03T15:00:00+08:00", end="2026-11-03T16:00:00+08:00", repeat_count=2, reminder_enabled=True, reminder_offsets=[-30, 0], scope="future", occurrence_start=previous[2]["occurrence_start"]))
    assert response.status_code == 200, response.text
    assert response.json()["title"] == "之后改到下午"
    expanded = rows(client)
    assert len(expanded) == 4
    assert [row["title"] for row in expanded] == ["早间安排", "早间安排", "之后改到下午", "之后改到下午"]
    assert expanded[0]["status"] == "completed"
    assert expanded[2]["start"].startswith("2026-11-03T07:00")
    assert len(client.get(API + "/plans").json()) == 1
    with Session() as db:
        assert len(list(db.scalars(select(PlanSegment)))) == 1
        assert len(list(db.scalars(select(PlanOccurrence)))) == 1
    assert client.post(f"{API}/plans/{plan['id']}/action", json={"action": "disable_reminders"}).status_code == 200
    assert len(rows(client)) == 4
    assert all(not row["reminder_enabled"] for row in rows(client))


def test_scoped_reminder_and_title_fire_at_the_new_clock(client, monkeypatch):
    clock(monkeypatch, "2026-10-30T00:00:00+00:00")
    plan = create(client, repeat_count=2, reminder_enabled=True)
    selected = rows(client)[0]
    response = client.put(f"{API}/plans/{plan['id']}", json=value(title="上午十一点", start="2026-11-01T11:00:00+08:00", end="2026-11-01T12:00:00+08:00", recurrence="none", reminder_enabled=True, reminder_offsets=[-30, 0], scope="this", occurrence_start=selected["occurrence_start"]))
    assert response.status_code == 200
    clock(monkeypatch, "2026-11-01T01:01:00+00:00")
    asyncio.run(reminders.tick())
    assert client.get(API + "/notifications").json() == []
    clock(monkeypatch, "2026-11-01T02:31:00+00:00")
    asyncio.run(reminders.tick())
    notes = client.get(API + "/notifications").json()
    assert len(notes) == 1 and notes[0]["title"] == "上午十一点"
    assert notes[0]["plan_occurrence_start"] == selected["occurrence_start"]
    clock(monkeypatch, "2026-11-01T03:01:00+00:00")
    asyncio.run(reminders.tick())
    assert len(client.get(API + "/notifications").json()) == 2


def test_invalid_scope_and_future_boundary_cannot_silently_modify_series(client):
    plan = create(client)
    selected = rows(client)[2]
    bad = client.put(f"{API}/plans/{plan['id']}", json=value(scope="future", occurrence_start=selected["occurrence_start"]))
    assert bad.status_code == 422
    missing = client.put(f"{API}/plans/{plan['id']}", json=value(scope="this"))
    assert missing.status_code == 422
    assert rows(client)[0]["title"] == "早间安排"


def test_completing_future_instance_updates_next_reminder_immediately(client, monkeypatch):
    clock(monkeypatch, "2026-10-30T00:00:00+00:00")
    plan = create(client, repeat_count=2, reminder_enabled=True)
    first = rows(client)[0]
    response = client.post(f"{API}/plans/{plan['id']}/action", json={"action": "complete", "occurrence_start": first["occurrence_start"]})
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["next_reminder_at"].startswith("2026-11-02")


def test_single_move_cannot_collide_with_another_instance_and_drop_its_notification(client):
    plan = create(client, repeat_count=3, reminder_enabled=True)
    first = rows(client)[0]
    response = client.put(f"{API}/plans/{plan['id']}", json=value(start="2026-11-02T09:00:00+08:00", end="2026-11-02T10:00:00+08:00", recurrence="none", scope="this", occurrence_start=first["occurrence_start"]))
    assert response.status_code == 422
    assert len(rows(client)) == 3


def test_series_title_and_reminder_switch_preserve_later_clock_changes(client):
    plan = create(client, repeat_count=6, reminder_enabled=True)
    third = rows(client)[2]
    result = client.put(f"{API}/plans/{plan['id']}", json=value(start="2026-11-03T15:00:00+08:00", end="2026-11-03T16:00:00+08:00", repeat_count=2, reminder_enabled=True, scope="future", occurrence_start=third["occurrence_start"]))
    assert result.status_code == 200
    master = client.get(f"{API}/plans/{plan['id']}").json()
    result = client.put(f"{API}/plans/{plan['id']}", json={**master, "title": "统一改名并关闭提醒", "reminder_enabled": False, "scope": "series"})
    assert result.status_code == 200
    expanded = rows(client)
    assert len(expanded) == 4
    assert all(row["title"] == "统一改名并关闭提醒" and not row["reminder_enabled"] for row in expanded)
    assert expanded[2]["start"].startswith("2026-11-03T07:00")
