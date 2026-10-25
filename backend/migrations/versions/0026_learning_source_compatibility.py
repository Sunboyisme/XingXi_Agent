"""Repair preview databases which applied 0025 before lesson sources were added."""
import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("lessons")}
    if "knowledge_sources" not in columns:
        op.add_column("lessons", sa.Column("knowledge_sources", sa.JSON(), nullable=False, server_default="[]"))


def downgrade():
    # The finalized 0025 schema also owns this column; keep it when returning there.
    pass
