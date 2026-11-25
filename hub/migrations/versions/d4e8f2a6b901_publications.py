"""Revocable sharing links and radio stations."""
import sqlalchemy as sa
from alembic import op

revision = "d4e8f2a6b901"
down_revision = "b7d2e4f91a63"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "publications",
        sa.Column("id", sa.String(48), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("source_kind", sa.String(16), nullable=False),
        sa.Column("source_id", sa.String(256), nullable=False),
        sa.Column("title", sa.String(512), nullable=False),
        sa.Column("tracks_json", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("wave_id", sa.String(32)),
    )
    op.create_index("ix_publications_user_id", "publications", ["user_id"])


def downgrade():
    op.drop_table("publications")
