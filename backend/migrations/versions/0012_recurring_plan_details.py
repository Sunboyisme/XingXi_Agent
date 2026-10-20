"""Bounded recurrence and scoped edits under the original plan identity."""
import json

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade():
    op.add_column("calendar_events", sa.Column("repeat_until", sa.String(10), nullable=True))
    op.add_column("calendar_events", sa.Column("repeat_count", sa.Integer(), nullable=True))
    op.add_column("calendar_events", sa.Column("calendar_display", sa.String(20), nullable=False, server_default="summary"))
    op.add_column("calendar_events", sa.Column("reminder_offsets", sa.JSON(), nullable=False, server_default="[0]"))
    op.add_column("plan_occurrences", sa.Column("override", sa.JSON(), nullable=True))
    op.create_table(
        "plan_segments",
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("calendar_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("from_day", sa.String(10), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
    )
    connection = op.get_bind()
    for row in connection.execute(sa.text("SELECT id,all_day,reminder_time FROM calendar_events")).mappings():
        offsets = list(connection.execute(sa.text("SELECT offset_minutes FROM reminders WHERE plan_id=:id AND status!='removed' ORDER BY position,created_at,id"), {"id": row["id"]}).scalars())
        if not offsets:
            h, m = map(int, row["reminder_time"].split(":"))
            offsets = [h * 60 + m if row["all_day"] else 0]
        connection.execute(sa.text("UPDATE calendar_events SET reminder_offsets=:offsets WHERE id=:id"), {"id": row["id"], "offsets": json.dumps(offsets)})


def downgrade():
    raise RuntimeError("Restore a backup to return to the earlier recurrence schema.")
