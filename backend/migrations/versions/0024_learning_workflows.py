"""Persist goal interviews and evidence-based reviews independently of original lessons."""
import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"


def records():
    return [sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.create_table("learning_intakes", *records(),
        sa.Column("messages", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("summary", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("draft", sa.Text(), nullable=False, server_default=""),
        sa.Column("draft_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("goals.id", ondelete="SET NULL")),
        sa.Column("active_run_id", sa.String(36)))
    op.create_index("ix_learning_intakes_profile_id", "learning_intakes", ["profile_id"])
    op.create_table("learning_reviews", *records(),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("goals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("learning_sessions.id", ondelete="SET NULL")),
        sa.Column("node_id", sa.String(36), sa.ForeignKey("knowledge_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("exercise", sa.Text(), nullable=False, server_default=""),
        sa.Column("criteria", sa.Text(), nullable=False, server_default=""),
        sa.Column("turns", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("draft", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("draft_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False, server_default="preparing"),
        sa.Column("active_run_id", sa.String(36)))
    for name in ("profile_id", "goal_id", "node_id", "session_id"):
        op.create_index(f"ix_learning_reviews_{name}", "learning_reviews", [name])


def downgrade():
    op.drop_table("learning_reviews")
    op.drop_table("learning_intakes")
