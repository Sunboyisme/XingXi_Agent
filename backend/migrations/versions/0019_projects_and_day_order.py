"""Explicit project context, independent shared materials and per-day display order."""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"


def record_columns():
    return [sa.Column("id", sa.String(36), primary_key=True), sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False), sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.create_table("projects", *record_columns(), sa.Column("name", sa.String(200), nullable=False), sa.Column("instructions", sa.Text(), nullable=False))
    op.create_index("ix_projects_profile_id", "projects", ["profile_id"])
    op.add_column("conversations", sa.Column("project_id", sa.String(36), nullable=True))
    op.add_column("conversations", sa.Column("pinned_at", sa.String(40), nullable=True))
    op.create_index("ix_conversations_project_id", "conversations", ["project_id"])
    op.add_column("memories", sa.Column("project_id", sa.String(36), nullable=True))
    op.create_index("ix_memories_project_id", "memories", ["project_id"])
    op.create_table("project_materials", *record_columns(),
                    sa.Column("project_id", sa.String(36), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
                    sa.Column("file_id", sa.String(36), sa.ForeignKey("attachments.id", ondelete="CASCADE"), nullable=False, unique=True),
                    sa.Column("source_file_id", sa.String(36), nullable=True))
    op.create_index("ix_project_materials_profile_id", "project_materials", ["profile_id"])
    op.create_index("ix_project_materials_project_id", "project_materials", ["project_id"])
    op.create_table("plan_day_orders", *record_columns(), sa.Column("timezone", sa.String(100), nullable=False),
                    sa.Column("day", sa.String(10), nullable=False), sa.Column("keys", sa.JSON(), nullable=False),
                    sa.UniqueConstraint("profile_id", "timezone", "day"))
    op.create_index("ix_plan_day_orders_profile_id", "plan_day_orders", ["profile_id"])


def downgrade():
    op.drop_table("plan_day_orders")
    op.drop_table("project_materials")
    op.drop_index("ix_memories_project_id", table_name="memories")
    op.drop_column("memories", "project_id")
    op.drop_index("ix_conversations_project_id", table_name="conversations")
    op.drop_column("conversations", "pinned_at")
    op.drop_column("conversations", "project_id")
    op.drop_table("projects")
