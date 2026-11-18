"""assistant mood mixes

Revision ID: b7d2e4f91a63
Revises: a3c8e5f17b92
"""

import sqlalchemy as sa
from alembic import op

revision = "b7d2e4f91a63"
down_revision = "a3c8e5f17b92"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mood_mixes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("download_batches.id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("nd_playlist_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("query", sa.String(length=500), nullable=False),
        sa.Column("library_count", sa.Integer(), nullable=False),
        sa.Column("new_count", sa.Integer(), nullable=False),
        sa.Column("reserve_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_mood_mixes_user_id", "mood_mixes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_mood_mixes_user_id", table_name="mood_mixes")
    op.drop_table("mood_mixes")
