"""Independent online text-to-speech configuration. Audio stays in memory."""
from alembic import op
import sqlalchemy as sa

revision = "0031"
down_revision = "0030"


def upgrade():
    op.add_column("settings", sa.Column("tts_config", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("settings", "tts_config")
