"""Persistent broadcast pause and optimistic concurrency for radio management."""
import sqlalchemy as sa
from alembic import op

revision = "f6c0b4d8e302"
down_revision = "e5b9a3c7d201"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("publications", sa.Column("paused_at", sa.DateTime(), nullable=True))
    op.add_column("publications", sa.Column("revision", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("publications", "revision")
    op.drop_column("publications", "paused_at")
