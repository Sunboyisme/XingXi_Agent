"""Persist explicitly submitted read-only folder references."""
import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"


def upgrade():
    op.add_column("messages", sa.Column("local_references", sa.JSON(), nullable=False, server_default="[]"))


def downgrade():
    op.drop_column("messages", "local_references")
