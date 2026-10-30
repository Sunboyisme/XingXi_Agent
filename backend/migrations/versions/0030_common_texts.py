"""Saved text and profile-scoped categories."""
from alembic import op
import sqlalchemy as sa

revision = "0030"
down_revision = "0029"


def upgrade():
    for name in ("common_text_categories", "common_texts"):
        fields = [
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False),
        ]
        if name == "common_text_categories":
            fields += [sa.Column("name", sa.String(80), nullable=False),
                       sa.Column("name_key", sa.String(160), nullable=False),
                       sa.UniqueConstraint("profile_id", "name_key")]
        else:
            fields += [sa.Column("content", sa.Text(), nullable=False),
                       sa.Column("category_id", sa.String(36),
                                 sa.ForeignKey("common_text_categories.id", ondelete="SET NULL"), nullable=True)]
        op.create_table(name, *fields)
        op.create_index("ix_" + name + "_profile_id", name, ["profile_id"])
    op.create_index("ix_common_texts_category_id", "common_texts", ["category_id"])


def downgrade():
    op.drop_table("common_texts")
    op.drop_table("common_text_categories")
