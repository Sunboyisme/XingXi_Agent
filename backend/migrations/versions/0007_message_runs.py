"""Associate answer actions with the run that actually produced each message."""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade():
    op.add_column("messages", sa.Column("run_id", sa.String(36), nullable=True))
    op.create_index("ix_messages_run_id", "messages", ["run_id"])


def downgrade():
    op.drop_index("ix_messages_run_id", table_name="messages")
    op.drop_column("messages", "run_id")
