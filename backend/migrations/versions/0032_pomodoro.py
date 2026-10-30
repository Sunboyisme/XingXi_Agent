"""Persistent, manually advanced focus and break sessions."""
from alembic import op
import sqlalchemy as sa

revision = "0032"
down_revision = "0031"


def upgrade():
    op.create_table("pomodoro_state",
        sa.Column("profile_id", sa.String(36), primary_key=True),
        sa.Column("preferences", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=True),
        sa.Column("phase", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("remaining_seconds", sa.Float(), nullable=False),
        sa.Column("checkpoint_at", sa.Float(), nullable=True),
        sa.Column("deadline_at", sa.Float(), nullable=True),
        sa.Column("segment_id", sa.String(36), nullable=True),
        sa.Column("notification_seq", sa.Integer(), nullable=False),
        sa.Column("notification_kind", sa.String(24), nullable=True))
    for name in ("pomodoro_sessions", "pomodoro_segments"):
        fields = [sa.Column("id", sa.String(36), primary_key=True),
                  sa.Column("profile_id", sa.String(36), nullable=False),
                  sa.Column("created_at", sa.String(40), nullable=False),
                  sa.Column("updated_at", sa.String(40), nullable=False)]
        if name == "pomodoro_sessions":
            fields += [sa.Column("title", sa.String(80), nullable=False),
                       sa.Column("focus_minutes", sa.Integer(), nullable=False),
                       sa.Column("break_minutes", sa.Integer(), nullable=False),
                       sa.Column("completed_at", sa.Float(), nullable=True),
                       sa.Column("ended_at", sa.Float(), nullable=True)]
        else:
            fields += [sa.Column("session_id", sa.String(36), sa.ForeignKey("pomodoro_sessions.id", ondelete="CASCADE"), nullable=False),
                       sa.Column("started_at", sa.Float(), nullable=False),
                       sa.Column("ended_at", sa.Float(), nullable=False)]
        op.create_table(name, *fields)
        op.create_index(f"ix_{name}_profile_id", name, ["profile_id"])
    op.create_index("ix_pomodoro_segments_session_id", "pomodoro_segments", ["session_id"])


def downgrade():
    op.drop_table("pomodoro_segments")
    op.drop_table("pomodoro_sessions")
    op.drop_table("pomodoro_state")
