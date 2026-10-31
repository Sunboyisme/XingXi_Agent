"""Ordered common text documents and lossless, editable image assets."""
import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"


def upgrade():
    op.add_column("common_texts", sa.Column("document", sa.JSON(), nullable=True))
    op.add_column("common_text_categories", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))
    connection = op.get_bind()
    rows = connection.execute(sa.text("SELECT id, profile_id FROM common_text_categories ORDER BY profile_id, name_key, id"))
    orders = {}
    for identifier, profile in rows.fetchall():
        order = orders.get(profile, 0)
        connection.execute(sa.text("UPDATE common_text_categories SET sort_order=:position WHERE id=:id"), {"position": order, "id": identifier})
        orders[profile] = order + 1
    op.create_table("common_text_assets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("profile_id", sa.String(36), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("media_type", sa.String(80), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("scene", sa.JSON(), nullable=True))
    op.create_index("ix_common_text_assets_profile_id", "common_text_assets", ["profile_id"])


def downgrade():
    op.drop_table("common_text_assets")
    op.drop_column("common_text_categories", "sort_order")
    op.drop_column("common_texts", "document")
