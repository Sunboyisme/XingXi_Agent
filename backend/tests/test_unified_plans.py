import asyncio
import sqlite3
from datetime import datetime
from types import SimpleNamespace

from alembic import command
from alembic.config import Config
from app import main, plans, reminders, tools
from app.plan_schedule import occurrence

from .test_app import API, wait_run


def plan(**changes):
    return {
        "title": "统一事项",
        "start": "2026-10-20T09:00:00+08:00",
        "end": "2026-10-20T10:00:00+08:00",
        **changes,
    }


def clock(monkeypatch, value):
    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            instant = datetime.fromisoformat(value)
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)

    monkeypatch.setattr(reminders, "datetime", Fixed)
    monkeypatch.setattr(main, "datetime", Fixed)
    monkeypatch.setattr(plans, "datetime", Fixed)


def test_one_item_multiple_reminders_and_completion_are_shared(client, monkeypatch):
    row = client.post(
        API + "/plans", json=plan(reminder_enabled=True, reminder_offsets=[-30, 0])
    ).json()
    assert len(client.get(API + "/plans").json()) == 1
    assert (
        client.post(
            API + "/plans", json=plan(reminder_enabled=True, reminder_offsets=[-30, 0])
        ).json()["id"]
        == row["id"]
    )
    clock(monkeypatch, "2026-10-20T00:31:00+00:00")
    asyncio.run(reminders.tick())
    notes = client.get(API + "/notifications").json()
    assert len(notes) == 1 and notes[0]["plan_id"] == row["id"]
    client.post(f"{API}/notifications/{notes[0]['id']}/ack?read=true")
    assert client.get(API + "/plans").json()[0]["status"] == "planned"
    clock(monkeypatch, "2026-10-20T01:01:00+00:00")
    asyncio.run(reminders.tick())
    assert len(client.get(API + "/notifications").json()) == 2
    client.post(f"{API}/plans/{row['id']}/action", json={"action": "complete"})
    assert client.get(API + "/plans").json()[0]["status"] == "completed"
    assert (
        client.get(API + "/plans?start=2026-10-20&end=2026-10-21").json()[0]["status"]
        == "completed"
    )


def test_repeating_completion_only_finishes_this_occurrence_and_end_finishes_series(
    client, monkeypatch
):
    row = client.post(
        API + "/plans",
        json=plan(recurrence="daily", reminder_enabled=True, reminder_offsets=[0, 15]),
    ).json()
    assert (
        client.post(
            f"{API}/plans/{row['id']}/action", json={"action": "complete"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{API}/plans/{row['id']}/action",
            json={"action": "complete", "occurrence_start": row["start"]},
        ).status_code
        == 200
    )
    events = client.get(API + "/plans?start=2026-10-20&end=2026-10-22").json()
    assert [e["status"] for e in events] == ["completed", "planned"]
    clock(monkeypatch, "2026-10-20T01:30:00+00:00")
    asyncio.run(reminders.tick())
    assert not client.get(API + "/notifications").json()
    clock(monkeypatch, "2026-10-21T01:30:00+00:00")
    asyncio.run(reminders.tick())
    assert len(client.get(API + "/notifications").json()) == 2
    client.post(f"{API}/plans/{row['id']}/action", json={"action": "end_series"})
    assert client.get(API + "/plans").json()[0]["status"] == "ended"
    assert client.get(API + "/plans?start=2026-10-22&end=2026-10-23").json() == []
    clock(monkeypatch, "2026-10-23T01:30:00+00:00")
    asyncio.run(reminders.tick())
    assert not client.get(API + "/notifications?pending_only=true").json()


def test_end_series_removes_unfinished_first_day_and_keeps_completed_history(client):
    row = client.post(API + "/plans", json=plan(recurrence="daily")).json()
    # End a series whose first occurrence is still unfinished (the reported bug).
    completed = "2026-10-21T01:00:00+00:00"
    response = client.post(
        f"{API}/plans/{row['id']}/action",
        json={"action": "complete", "occurrence_start": completed},
    )
    assert response.status_code == 200
    response = client.post(f"{API}/plans/{row['id']}/action", json={"action": "end_series"})
    assert response.status_code == 200
    assert client.get(API + "/plans?start=2026-10-20&end=2026-10-21").json() == []
    events = client.get(API + "/plans?start=2026-10-20&end=2026-10-24").json()
    assert len(events) == 1
    assert events[0]["status"] == "completed"
    assert datetime.fromisoformat(events[0]["occurrence_start"]) == datetime.fromisoformat(completed)


def test_snooze_only_moves_one_notification_and_disable_keeps_plan(client, monkeypatch):
    clock(monkeypatch, "2026-10-20T00:00:00+00:00")
    row = client.post(
        API + "/plans",
        json=plan(recurrence="daily", reminder_enabled=True, reminder_offsets=[0, 15]),
    ).json()
    clock(monkeypatch, "2026-10-20T01:01:00+00:00")
    asyncio.run(reminders.tick())
    note = client.get(API + "/notifications").json()[0]
    before = client.get(API + "/reminders").json()
    response = client.post(
        f"{API}/notifications/{note['id']}/snooze", json={"minutes": 10}
    )
    assert response.status_code == 200 and response.json()["status"] == "snoozed"
    assert client.get(API + "/reminders").json() == before
    clock(monkeypatch, "2026-10-20T01:12:00+00:00")
    asyncio.run(reminders.tick())
    awake = client.get(API + "/notifications?pending_only=true").json()
    assert (
        len(awake) == 1 and awake[0]["id"] == note["id"] and awake[0]["generation"] == 1
    )
    client.post(f"{API}/plans/{row['id']}/action", json={"action": "disable_reminders"})
    plan_row = client.get(API + "/plans").json()[0]
    assert plan_row["status"] == "planned" and not plan_row["reminder_enabled"]


def test_rescheduling_cancels_old_pending_notification(client, monkeypatch):
    row = client.post(API + "/plans", json=plan(reminder_enabled=True)).json()
    clock(monkeypatch, "2026-10-20T01:01:00+00:00")
    asyncio.run(reminders.tick())
    assert len(client.get(API + "/notifications?pending_only=true").json()) == 1
    client.put(
        f"{API}/plans/{row['id']}",
        json=plan(
            start="2026-10-22T09:00:00+08:00",
            end="2026-10-22T10:00:00+08:00",
            reminder_enabled=True,
        ),
    )
    assert client.get(API + "/notifications?pending_only=true").json() == []
    assert len(client.get(API + "/plans").json()) == 1


def test_monthly_recurrence_keeps_anchor_and_daily_keeps_civil_time():
    base = SimpleNamespace(
        start="2027-01-31T01:00:00+00:00",
        end="2027-01-31T02:00:00+00:00",
        timezone="Asia/Shanghai",
        recurrence="monthly",
        repeat_interval=1,
        all_day=False,
    )
    assert occurrence(base, 1)[0].startswith("2027-02-28")
    assert occurrence(base, 2)[0].startswith("2027-03-31")
    base = SimpleNamespace(
        start="2026-03-07T14:00:00+00:00",
        end="2026-03-07T15:00:00+00:00",
        timezone="America/New_York",
        recurrence="daily",
        repeat_interval=1,
        all_day=False,
    )
    assert occurrence(base, 1)[0] == "2026-03-08T13:00:00.000000+00:00"


def test_chat_exposes_one_plan_tool_family(client):
    names = {row["id"] for row in tools.builtin_catalog()}
    assert {
        "list_plans",
        "create_plans",
        "update_plan",
        "action_plan",
        "delete_plan",
    } <= names
    assert not names & {
        "create_reminder",
        "list_reminders",
        "cancel_reminder",
        "create_calendar_events",
    }


def test_chat_plan_flow_saves_once_and_uses_only_unified_tools(configured):
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "本地013日序：请保存明天的读书计划并提醒我"},
        ),
    )
    assert run["status"] == "completed", run
    assert len(configured.get(API + "/plans").json()) == 1
    assert len(configured.get(API + "/reminders").json()) == 1
    text = str(configured.get(f"{API}/runs/{run['id']}/tools").json())
    assert "list_plans" in text and "create_plans" in text
    assert "create_reminder" not in text


def test_invalid_occurrence_and_restoring_future_repeat(client, monkeypatch):
    clock(monkeypatch, "2026-10-20T00:00:00+00:00")
    row = client.post(
        API + "/plans", json=plan(recurrence="daily", reminder_enabled=True)
    ).json()
    path = f"{API}/plans/{row['id']}/action"
    assert (
        client.post(
            path, json={"action": "complete", "occurrence_start": "bad"}
        ).status_code
        == 422
    )
    client.post(path, json={"action": "complete", "occurrence_start": row["start"]})
    # Editing a completed future instance skips its reminder, restoring reinstates it.
    client.put(
        f"{API}/plans/{row['id']}",
        json=plan(recurrence="daily", reminder_enabled=True, reminder_offsets=[-10]),
    )
    client.post(path, json={"action": "restore", "occurrence_start": row["start"]})
    clock(monkeypatch, "2026-10-20T00:51:00+00:00")
    asyncio.run(reminders.tick())
    assert len(client.get(API + "/notifications").json()) == 1


def test_migration_preserves_legacy_rules_status_and_deduplicates_links(tmp_path):
    path = tmp_path / "legacy.sqlite"
    cfg = Config("backend/alembic.ini")
    cfg.set_main_option("script_location", "backend/migrations")
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{path.as_posix()}")
    command.upgrade(cfg, "0010")
    with sqlite3.connect(path) as connection:
        for key, recurrence, state in [
            ("linked", "none", "active"),
            ("weekly", "weekly", "active"),
            ("done", "none", "completed"),
        ]:
            connection.execute(
                "INSERT INTO reminders (id,profile_id,created_at,updated_at,title,body,due_at,timezone,recurrence,status) VALUES (?,'local','2026-01-01','2026-01-01',?,'原备注','2026-10-20T01:00:00.000000+00:00','Asia/Shanghai',?,?)",
                (key, key, recurrence, state),
            )
        connection.execute(
            "INSERT INTO calendar_events (id,profile_id,created_at,updated_at,title,notes,start,end,all_day,timezone,status,reminder_enabled,reminder_time,reminder_id) VALUES ('plan-linked','local','2026-01-01','2026-01-01','关联事项','原备注','2026-10-20T01:00:00.000000+00:00','2026-10-20T02:00:00.000000+00:00',0,'Asia/Shanghai','planned',1,'09:00','linked')"
        )
        connection.execute(
            "INSERT INTO notifications (id,profile_id,created_at,updated_at,reminder_id,occurrence_at,title,body,status,overdue) VALUES ('notice','local','2026-01-01','2026-01-01','linked','2026-10-20T01:00:00.000000+00:00','关联事项','原备注','read',0)"
        )
        connection.execute(
            "INSERT INTO notifications (id,profile_id,created_at,updated_at,reminder_id,occurrence_at,title,body,status,overdue) VALUES ('before-edit','local','2026-01-01','2026-01-01','weekly','2026-10-13T00:00:00.000000+00:00','旧时刻','原备注','read',0)"
        )
        connection.execute(
            "INSERT INTO builtin_tool_states(id,enabled) VALUES ('create_reminder',0)"
        )
    marker = tmp_path / "credential-marker"
    marker.write_text("preserve", encoding="utf-8")
    command.upgrade(cfg, "head")
    with sqlite3.connect(path) as connection:
        assert (
            connection.execute("SELECT count(*) FROM calendar_events").fetchone()[0]
            == 3
        )
        assert (
            connection.execute(
                "SELECT plan_id FROM reminders WHERE id='linked'"
            ).fetchone()[0]
            == "plan-linked"
        )
        assert (
            connection.execute(
                "SELECT recurrence FROM calendar_events WHERE title='weekly'"
            ).fetchone()[0]
            == "weekly"
        )
        assert (
            connection.execute(
                "SELECT start FROM calendar_events WHERE title='weekly'"
            ).fetchone()[0]
            == "2026-10-20T01:00:00.000000+00:00"
        )
        assert (
            connection.execute(
                "SELECT status FROM calendar_events WHERE title='done'"
            ).fetchone()[0]
            == "completed"
        )
        assert connection.execute(
            "SELECT id,status,plan_id FROM notifications WHERE id='notice'"
        ).fetchone() == ("notice", "read", "plan-linked")
        assert connection.execute(
            "SELECT enabled FROM builtin_tool_states WHERE id='create_plans'"
        ).fetchone() == (0,)
    assert marker.read_text(encoding="utf-8") == "preserve"
