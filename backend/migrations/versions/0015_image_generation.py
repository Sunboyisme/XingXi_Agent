"""Independent image generation connection; credentials remain in the vault."""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade():
    op.add_column("settings", sa.Column("image_generation_config", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("settings", "image_generation_config")
