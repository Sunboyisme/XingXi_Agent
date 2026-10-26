"""Persist manual todo ordering."""
import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"


def upgrade():
    op.add_column("todos", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("todos", "sort_order")
