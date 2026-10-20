"""Keep original-file metadata when a conversation is removed."""

from alembic import op

revision = "0014"
down_revision = "0013"


def upgrade():
    with op.batch_alter_table(
        "office_files",
        naming_convention={
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"
        },
    ) as batch:
        batch.drop_constraint(
            "fk_office_files_conversation_id_conversations", type_="foreignkey"
        )
        batch.create_foreign_key(
            "fk_office_files_conversation_id_conversations",
            "conversations",
            ["conversation_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade():
    raise RuntimeError("Restore a backup to return to the earlier office-file schema.")
