"""Independent speech configuration and a duration ledger; never stores recordings."""
from alembic import op
import sqlalchemy as sa

revision = "0029"
down_revision = "0028"


def upgrade():
    op.add_column("settings", sa.Column("speech_config", sa.JSON(), nullable=False, server_default="{}"))
    op.create_table("speech_calls",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("profile_id", sa.String(36), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
        sa.Column("provider", sa.String(30), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("audio_seconds", sa.Float(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("error", sa.Text(), nullable=False))
    op.create_index("ix_speech_calls_profile_id", "speech_calls", ["profile_id"])


def downgrade():
    op.drop_table("speech_calls")
    op.drop_column("settings", "speech_config")
