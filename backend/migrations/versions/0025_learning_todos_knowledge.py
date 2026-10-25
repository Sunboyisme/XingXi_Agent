"""Independent learning drafts, unscheduled todos and a local knowledge library."""
import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"


def records():
    return [sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.add_column("lessons", sa.Column("knowledge_sources", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("settings", sa.Column("knowledge_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("learning_intakes", sa.Column("creation_id", sa.String(100), nullable=True))
    op.create_index("ix_learning_intakes_creation_id", "learning_intakes", ["creation_id"], unique=True)
    op.create_table("todos", *records(), sa.Column("title", sa.String(300), nullable=False),
                    sa.Column("notes", sa.Text(), nullable=False), sa.Column("status", sa.String(20), nullable=False),
                    sa.Column("reminder_at", sa.String(40)), sa.Column("timezone", sa.String(100), nullable=False))
    op.create_index("ix_todos_profile_id", "todos", ["profile_id"])
    op.create_index("ix_todos_status", "todos", ["status"])
    for table in ("reminders", "notifications"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("todo_id", sa.String(36), nullable=True))
            batch.create_foreign_key(f"fk_{table}_todo", "todos", ["todo_id"], ["id"], ondelete="CASCADE")
            batch.create_index(f"ix_{table}_todo_id", ["todo_id"])
    op.create_table("knowledge_documents", *records(),
                    sa.Column("batch_id", sa.String(36), nullable=False), sa.Column("relative_path", sa.Text(), nullable=False),
                    sa.Column("storage_name", sa.String(100), nullable=False), sa.Column("size", sa.Integer(), nullable=False),
                    sa.Column("content_hash", sa.String(64), nullable=False), sa.Column("status", sa.String(20), nullable=False),
                    sa.Column("error", sa.Text(), nullable=False), sa.Column("warnings", sa.JSON(), nullable=False))
    op.create_index("ix_knowledge_documents_profile_id", "knowledge_documents", ["profile_id"])
    op.create_index("ix_knowledge_documents_batch_id", "knowledge_documents", ["batch_id"])
    op.create_table("knowledge_chunks", sa.Column("id", sa.String(36), primary_key=True),
                    sa.Column("document_id", sa.String(36), sa.ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False),
                    sa.Column("ordinal", sa.Integer(), nullable=False), sa.Column("locator", sa.Text(), nullable=False),
                    sa.Column("content", sa.Text(), nullable=False), sa.Column("content_hash", sa.String(64), nullable=False))
    op.create_index("ix_knowledge_chunks_document_id", "knowledge_chunks", ["document_id"])
    op.create_table("knowledge_vectors", sa.Column("chunk_id", sa.String(36), sa.ForeignKey("knowledge_chunks.id", ondelete="CASCADE"), primary_key=True),
                    sa.Column("content_hash", sa.String(64), nullable=False), sa.Column("signature", sa.String(64), nullable=False),
                    sa.Column("vector", sa.JSON(), nullable=False))


def downgrade():
    op.drop_table("knowledge_vectors")
    op.drop_table("knowledge_chunks")
    op.drop_table("knowledge_documents")
    for table in ("notifications", "reminders"):
        with op.batch_alter_table(table) as batch:
            batch.drop_index(f"ix_{table}_todo_id")
            batch.drop_constraint(f"fk_{table}_todo", type_="foreignkey")
            batch.drop_column("todo_id")
    op.drop_table("todos")
    op.drop_index("ix_learning_intakes_creation_id", table_name="learning_intakes")
    op.drop_column("learning_intakes", "creation_id")
    op.drop_column("settings", "knowledge_enabled")
    op.drop_column("lessons", "knowledge_sources")
