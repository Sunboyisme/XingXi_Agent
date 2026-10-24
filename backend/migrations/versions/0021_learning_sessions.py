"""Persist resumable learning sessions without inventing past activity."""

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"


def upgrade():
    op.add_column("goals", sa.Column("outcome", sa.Text(), nullable=False, server_default=""))
    op.add_column("goals", sa.Column("weekly_minutes", sa.Integer(), nullable=True))
    op.add_column("goals", sa.Column("target_date", sa.String(10), nullable=True))
    op.create_table(
        "learning_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("profile_id", sa.String(36), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("goals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("node_id", sa.String(36), nullable=True),
        sa.Column("lesson_id", sa.String(36), nullable=True),
        sa.Column("target_minutes", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("gaps", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("next_step", sa.Text(), nullable=False, server_default=""),
        sa.Column("started_at", sa.String(40), nullable=False),
        sa.Column("paused_at", sa.String(40), nullable=True),
        sa.Column("ended_at", sa.String(40), nullable=True),
        sa.Column("last_studied_at", sa.String(40), nullable=True),
        sa.Column("visited_node_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("drafts", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("draft_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_learning_sessions_profile_id", "learning_sessions", ["profile_id"])
    op.create_index("ix_learning_sessions_goal_id", "learning_sessions", ["goal_id"])
    op.create_index("uq_learning_session_open_goal", "learning_sessions", ["goal_id"], unique=True,
                    sqlite_where=sa.text("status <> 'ended'"), postgresql_where=sa.text("status <> 'ended'"))
    with op.batch_alter_table("lessons") as batch:
        batch.add_column(sa.Column("session_id", sa.String(36), nullable=True))
        batch.create_foreign_key("fk_lessons_session", "learning_sessions", ["session_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_lessons_session_id", ["session_id"])
    with op.batch_alter_table("attempts") as batch:
        batch.add_column(sa.Column("session_id", sa.String(36), nullable=True))
        batch.create_foreign_key("fk_attempts_session", "learning_sessions", ["session_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_attempts_session_id", ["session_id"])


def downgrade():
    with op.batch_alter_table("attempts") as batch:
        batch.drop_index("ix_attempts_session_id")
        batch.drop_constraint("fk_attempts_session", type_="foreignkey")
        batch.drop_column("session_id")
    with op.batch_alter_table("lessons") as batch:
        batch.drop_index("ix_lessons_session_id")
        batch.drop_constraint("fk_lessons_session", type_="foreignkey")
        batch.drop_column("session_id")
    op.drop_table("learning_sessions")
    op.drop_column("goals", "target_date")
    op.drop_column("goals", "weekly_minutes")
    op.drop_column("goals", "outcome")
