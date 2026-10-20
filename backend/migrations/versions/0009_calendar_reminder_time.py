"""Allow a local reminder time for all-day plans, preserving existing 09:00 reminders."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade():
    op.add_column(
        "calendar_events",
        sa.Column(
            "reminder_time", sa.String(5), nullable=False, server_default="09:00"
        ),
    )


def downgrade():
    op.drop_column("calendar_events", "reminder_time")
