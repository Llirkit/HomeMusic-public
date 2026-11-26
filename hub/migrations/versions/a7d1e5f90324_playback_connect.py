"""Account playback checkpoints and authenticated device presence."""
import sqlalchemy as sa
from alembic import op

revision = "a7d1e5f90324"
down_revision = "f6c0b4d8e302"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("playback_states",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("device_id", sa.String(64)), sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("snapshot_json", sa.JSON()), sa.Column("updated_at", sa.DateTime(), nullable=False))
    op.create_table("playback_devices",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("session_id", sa.String(64), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False), sa.Column("seen_at", sa.DateTime(), nullable=False))


def downgrade():
    op.drop_table("playback_devices")
    op.drop_table("playback_states")
