"""Durable summaries, local semantic indexes and visible reasoning."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade():
    op.add_column(
        "settings",
        sa.Column("embedding_config", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "messages", sa.Column("reasoning", sa.Text(), nullable=False, server_default="")
    )
    op.create_table(
        "conversation_summaries",
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("through_message_id", sa.String(36), nullable=False),
    )
    op.create_table(
        "memory_vectors",
        sa.Column(
            "memory_id",
            sa.String(36),
            sa.ForeignKey("memories.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("signature", sa.String(64), nullable=False),
        sa.Column("vector", sa.JSON(), nullable=False),
    )


def downgrade():
    op.drop_table("memory_vectors")
    op.drop_table("conversation_summaries")
    op.drop_column("messages", "reasoning")
    op.drop_column("settings", "embedding_config")
