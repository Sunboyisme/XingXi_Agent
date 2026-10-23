"""Local read-only project workspace."""

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"


def upgrade():
    op.add_column("projects", sa.Column("workspace_path", sa.String(4096), nullable=False, server_default=""))


def downgrade():
    op.drop_column("projects", "workspace_path")
