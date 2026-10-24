"""Keep observable model calls and immutable price snapshots."""

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"


def common():
    return [sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("profile_id", sa.String(36), nullable=False),
            sa.Column("created_at", sa.String(40), nullable=False),
            sa.Column("updated_at", sa.String(40), nullable=False)]


def upgrade():
    op.create_table("usage_prices", *common(),
        sa.Column("provider_id", sa.String(200), nullable=False),
        sa.Column("provider_label", sa.String(200), nullable=False),
        sa.Column("model_name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("image_size", sa.String(40), nullable=False),
        sa.Column("rates", sa.JSON(), nullable=False))
    op.create_index("ix_usage_prices_profile_id", "usage_prices", ["profile_id"])
    op.create_table("usage_calls", *common(),
        sa.Column("run_id", sa.String(36), nullable=True),
        sa.Column("provider_id", sa.String(200), nullable=False),
        sa.Column("provider_label", sa.String(200), nullable=False),
        sa.Column("model_name", sa.String(200), nullable=False),
        sa.Column("purpose", sa.String(40), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        *[sa.Column(key, sa.Integer(), nullable=True) for key in
          ("input_tokens", "output_tokens", "total_tokens", "cached_tokens", "cache_write_tokens", "image_count")],
        sa.Column("image_size", sa.String(40), nullable=False),
        sa.Column("price_snapshot", sa.JSON(), nullable=False),
        sa.Column("estimated_cost", sa.String(80), nullable=True),
        sa.Column("unknown_reason", sa.String(300), nullable=False),
        sa.Column("finished_at", sa.String(40), nullable=True))
    op.create_index("ix_usage_calls_profile_id", "usage_calls", ["profile_id"])
    op.create_index("ix_usage_calls_run_id", "usage_calls", ["run_id"])


def downgrade():
    op.drop_table("usage_calls")
    op.drop_table("usage_prices")
