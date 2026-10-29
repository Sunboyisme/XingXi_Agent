"""Allow multiple read-only folders per project."""

import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"


def upgrade():
    op.add_column("projects", sa.Column("workspace_paths", sa.JSON(), nullable=False, server_default="[]"))
    projects = sa.table("projects", sa.column("id", sa.String()),
                        sa.column("workspace_path", sa.String()), sa.column("workspace_paths", sa.JSON()))
    connection = op.get_bind()
    for key, path in connection.execute(sa.select(projects.c.id, projects.c.workspace_path)).all():
        if path:
            connection.execute(projects.update().where(projects.c.id == key).values(workspace_paths=[path]))


def downgrade():
    op.drop_column("projects", "workspace_paths")
