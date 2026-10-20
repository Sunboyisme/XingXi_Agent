"""Managed, conversation-scoped office uploads (original bytes stay immutable)."""

from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"


def upgrade():
    op.create_table(
        "office_files",
        sa.Column(
            "id",
            sa.String(36),
            sa.ForeignKey("attachments.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("chunks", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("warnings", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.create_index(
        "ix_office_files_conversation_id", "office_files", ["conversation_id"]
    )


def downgrade():
    op.drop_table("office_files")
