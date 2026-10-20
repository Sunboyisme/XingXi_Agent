"""One authoritative plan, reminder rules, and per-occurrence completion history."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade():
    op.add_column(
        "calendar_events",
        sa.Column("recurrence", sa.String(20), nullable=False, server_default="none"),
    )
    op.add_column(
        "calendar_events",
        sa.Column("repeat_interval", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("reminders", sa.Column("plan_id", sa.String(36), nullable=True))
    op.add_column(
        "reminders",
        sa.Column("offset_minutes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "reminders",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "reminders", sa.Column("plan_occurrence_start", sa.String(40), nullable=True)
    )
    op.create_index("ix_reminders_plan_id", "reminders", ["plan_id"])
    for name in ("plan_id", "plan_occurrence_start", "snoozed_until"):
        op.add_column(
            "notifications",
            sa.Column(name, sa.String(36 if name == "plan_id" else 40), nullable=True),
        )
    op.add_column(
        "notifications",
        sa.Column("generation", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "plan_occurrences",
        sa.Column(
            "plan_id",
            sa.String(36),
            sa.ForeignKey("calendar_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("start", sa.String(40), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("completed_at", sa.String(40), nullable=False),
    )
    connection = op.get_bind()
    plans = {
        r["reminder_id"]: dict(r)
        for r in connection.execute(
            sa.text("SELECT * FROM calendar_events WHERE reminder_id IS NOT NULL")
        ).mappings()
    }

    def utc(value):
        return value.astimezone(UTC).isoformat(timespec="microseconds")

    for reminder in list(
        connection.execute(sa.text("SELECT * FROM reminders")).mappings()
    ):
        plan = plans.get(reminder["id"])
        was_linked = plan is not None
        if not plan:
            due = datetime.fromisoformat(reminder["due_at"])
            anchor_due = due
            previous = connection.execute(
                sa.text(
                    "SELECT min(occurrence_at) FROM notifications WHERE reminder_id=:id"
                ),
                {"id": reminder["id"]},
            ).scalar()
            if reminder["recurrence"] != "none" and previous:
                past = datetime.fromisoformat(previous)
                zone = ZoneInfo(reminder["timezone"])
                old_local, current_local = past.astimezone(zone), due.astimezone(zone)
                same_clock = old_local.time() == current_local.time()
                same_weekday = (
                    reminder["recurrence"] != "weekly"
                    or old_local.weekday() == current_local.weekday()
                )
                # Old edits and old snoozes could move the entire repeating schedule.
                # Historical notifications must not overwrite its current clock.
                if past < anchor_due and same_clock and same_weekday:
                    anchor_due = past
            state = {"completed": "completed", "cancelled": "ended"}.get(
                reminder["status"], "planned"
            )
            if state == "completed" and reminder["recurrence"] != "none":
                state = "ended"
            key = str(uuid4())
            values = {
                **dict(reminder),
                "id": key,
                "notes": reminder["body"],
                "start": utc(anchor_due),
                "end": utc(anchor_due + timedelta(minutes=1)),
                "status": state,
                "reminder_id": reminder["id"],
                "enabled": int(reminder["status"] in ("active", "fired")),
            }
            connection.execute(
                sa.text(
                    "INSERT INTO calendar_events (id, profile_id, created_at, updated_at, title, notes, start, end, all_day, timezone, status, reminder_enabled, reminder_time, reminder_at, reminder_id, source_message_id, recurrence, repeat_interval) VALUES (:id,:profile_id,:created_at,:updated_at,:title,:notes,:start,:end,0,:timezone,:status,:enabled,'09:00',NULL,:reminder_id,NULL,:recurrence,1)"
                ),
                values,
            )
            plan = {**values, "all_day": False}
        elif reminder["recurrence"] != "none":
            connection.execute(
                sa.text(
                    "UPDATE calendar_events SET recurrence=:recurrence WHERE id=:id"
                ),
                {"recurrence": reminder["recurrence"], "id": plan["id"]},
            )
        if was_linked and reminder["status"] == "cancelled":
            connection.execute(
                sa.text("UPDATE calendar_events SET reminder_enabled=0 WHERE id=:id"),
                {"id": plan["id"]},
            )
        if (
            was_linked
            and reminder["status"] == "completed"
            and reminder["recurrence"] == "none"
        ):
            connection.execute(
                sa.text("UPDATE calendar_events SET status='completed' WHERE id=:id"),
                {"id": plan["id"]},
            )
        zone = ZoneInfo(plan["timezone"])
        anchor = (
            datetime.fromisoformat(plan["start"]).replace(tzinfo=zone)
            if plan["all_day"]
            else datetime.fromisoformat(plan["start"]).astimezone(zone)
        )
        due = datetime.fromisoformat(reminder["due_at"]).astimezone(zone)
        offset = round(
            (due.replace(tzinfo=None) - anchor.replace(tzinfo=None)).total_seconds()
            / 60
        )
        current_start = plan["start"]
        if not was_linked:
            offset = 0
            current_start = utc(due)
        elif reminder["recurrence"] != "none":
            if plan["all_day"]:
                h, m = map(int, plan["reminder_time"].split(":"))
                offset = h * 60 + m
            elif plan.get("reminder_at"):
                offset = round(
                    (
                        datetime.fromisoformat(plan["reminder_at"])
                        .astimezone(zone)
                        .replace(tzinfo=None)
                        - anchor.replace(tzinfo=None)
                    ).total_seconds()
                    / 60
                )
            else:
                offset = 0
            instance = due - timedelta(minutes=offset)
            current_start = (
                instance.date().isoformat() if plan["all_day"] else utc(instance)
            )
        if reminder["status"] == "completed" and reminder["recurrence"] != "none":
            connection.execute(
                sa.text("UPDATE calendar_events SET status='ended' WHERE id=:id"),
                {"id": plan["id"]},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO plan_occurrences (plan_id,start,status,completed_at) VALUES (:id,:start,'completed',:at)"
                ),
                {
                    "id": plan["id"],
                    "start": current_start,
                    "at": reminder["updated_at"],
                },
            )
        connection.execute(
            sa.text(
                "UPDATE reminders SET plan_id=:plan, offset_minutes=:offset, plan_occurrence_start=:start WHERE id=:id"
            ),
            {
                "plan": plan["id"],
                "offset": offset,
                "start": current_start,
                "id": reminder["id"],
            },
        )
        for note in list(
            connection.execute(
                sa.text(
                    "SELECT id, occurrence_at FROM notifications WHERE reminder_id=:id"
                ),
                {"id": reminder["id"]},
            ).mappings()
        ):
            start = datetime.fromisoformat(note["occurrence_at"]).astimezone(
                zone
            ) - timedelta(minutes=offset)
            start_key = start.date().isoformat() if plan["all_day"] else utc(start)
            connection.execute(
                sa.text(
                    "UPDATE notifications SET plan_id=:plan, plan_occurrence_start=:start WHERE id=:id"
                ),
                {"plan": plan["id"], "start": start_key, "id": note["id"]},
            )

    # Preserve explicit tool switches when consolidating the two tool families.
    # An explicitly disabled predecessor keeps the corresponding new action off.
    aliases = {
        "list_plans": ("list_reminders", "list_calendar_events"),
        "create_plans": ("create_reminder", "create_calendar_events"),
        "update_plan": ("update_calendar_event",),
        "delete_plan": ("delete_calendar_event",),
        "action_plan": ("cancel_reminder",),
    }
    switches = dict(
        connection.execute(sa.text("SELECT id,enabled FROM builtin_tool_states")).all()
    )
    for key, old_names in aliases.items():
        old_values = [switches[name] for name in old_names if name in switches]
        if key not in switches and old_values:
            connection.execute(
                sa.text(
                    "INSERT INTO builtin_tool_states(id,enabled) VALUES (:id,:enabled)"
                ),
                {"id": key, "enabled": int(all(old_values))},
            )


def downgrade():
    raise RuntimeError(
        "Unified plans preserve migrated data; restore a backup to return to the older schema."
    )
