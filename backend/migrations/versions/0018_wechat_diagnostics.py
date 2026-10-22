"""Keep sanitized delivery diagnostics without changing historical outcomes."""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"


def upgrade():
    op.add_column("wechat_deliveries", sa.Column("diagnostics", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("wechat_deliveries", "diagnostics")
