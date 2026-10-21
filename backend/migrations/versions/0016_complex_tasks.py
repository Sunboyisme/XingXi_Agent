"""Durable task steps and operation identities across chat runs."""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"


def record():
    return [sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.add_column("runs", sa.Column("task_id", sa.String(36), nullable=True))
    op.add_column("runs", sa.Column("source_message_id", sa.String(36), nullable=True))
    op.create_index("ix_runs_task_id", "runs", ["task_id"])
    op.create_table("complex_tasks", *record(),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_message_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("requirements", sa.JSON(), nullable=False),
        sa.Column("model_config", sa.JSON(), nullable=False),
        sa.Column("message_ids", sa.JSON(), nullable=False),
        sa.Column("pending_message_ids", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False))
    op.create_table("task_steps", *record(),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("complex_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("source_message_id", sa.String(36), nullable=False),
        sa.Column("repeat_operation_ids", sa.JSON(), nullable=False),
        sa.Column("dependencies", sa.JSON(), nullable=False),
        sa.Column("tools", sa.JSON(), nullable=False),
        sa.Column("formats", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("output", sa.JSON(), nullable=False))
    op.create_table("task_operations", *record(),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("complex_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("step_id", sa.String(36), sa.ForeignKey("task_steps.id", ondelete="CASCADE"), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("tool_id", sa.String(100), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("policy", sa.String(30), nullable=False),
        sa.Column("arguments", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False))
    for table in ("complex_tasks", "task_steps", "task_operations"):
        op.create_index(f"ix_{table}_profile_id", table, ["profile_id"])
    op.create_index("ix_complex_tasks_conversation_id", "complex_tasks", ["conversation_id"])
    op.create_index("ix_task_steps_task_id", "task_steps", ["task_id"])
    for field in ("task_id", "step_id"):
        op.create_index(f"ix_task_operations_{field}", "task_operations", [field])


def downgrade():
    for table in ("task_operations", "task_steps", "complex_tasks"):
        op.drop_table(table)
    op.drop_index("ix_runs_task_id", table_name="runs")
    op.drop_column("runs", "source_message_id")
    op.drop_column("runs", "task_id")
