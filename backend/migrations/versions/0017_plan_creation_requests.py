"""Deduplicate each creation request without dropping later task steps."""

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"


def upgrade():
    op.create_table(
        "plan_creations",
        sa.Column("source_message_id", sa.String(36), primary_key=True),
        sa.Column("fingerprint", sa.String(64), primary_key=True),
        sa.Column("event_ids", sa.JSON(), nullable=False),
    )


def downgrade():
    op.drop_table("plan_creations")
