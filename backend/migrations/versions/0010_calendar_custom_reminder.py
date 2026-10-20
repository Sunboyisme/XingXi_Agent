"""Preserve existing start-time reminders and allow an independent timed-plan reminder."""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade():
    op.add_column(
        "calendar_events", sa.Column("reminder_at", sa.String(40), nullable=True)
    )


def downgrade():
    op.drop_column("calendar_events", "reminder_at")
