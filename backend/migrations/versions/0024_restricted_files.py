"""Explicit, revocable local file sessions and one-shot save requests."""
import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"


def base():
    return [sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.add_column("conversations", sa.Column("restricted_files", sa.Boolean(), nullable=False, server_default="0"))
    op.create_table("file_sessions", *base(),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), unique=True, nullable=False),
        sa.Column("status", sa.String(20), nullable=False), sa.Column("grants", sa.JSON(), nullable=False),
        sa.Column("model_binding", sa.JSON(), nullable=False), sa.Column("expires_at", sa.String(40), nullable=False),
        sa.Column("reads", sa.JSON(), nullable=False))
    op.create_table("file_save_requests", *base(),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("file_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_id", sa.String(36), nullable=False), sa.Column("name", sa.String(180), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False), sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("target", sa.Text(), nullable=False), sa.Column("status", sa.String(20), nullable=False),
        sa.Column("expires_at", sa.String(40), nullable=False), sa.Column("error", sa.Text(), nullable=False))
    op.create_table("file_audits", *base(),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("file_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(30), nullable=False), sa.Column("detail", sa.JSON(), nullable=False))
    for table in ("file_sessions", "file_save_requests", "file_audits"):
        op.create_index(f"ix_{table}_profile_id", table, ["profile_id"])
    for table in ("file_save_requests", "file_audits"):
        op.create_index(f"ix_{table}_session_id", table, ["session_id"])


def downgrade():
    for table in ("file_audits", "file_save_requests", "file_sessions"):
        op.drop_table(table)
    op.drop_column("conversations", "restricted_files")
