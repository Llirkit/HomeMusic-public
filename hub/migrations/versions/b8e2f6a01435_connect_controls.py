"""Shared account controls, command acknowledgement and per-device volume."""
import sqlalchemy as sa
from alembic import op

revision = "b8e2f6a01435"
down_revision = "a7d1e5f90324"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("playback_states", sa.Column("applied_revision", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("playback_states", sa.Column("commands_json", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("playback_devices", sa.Column("volume", sa.Float(), nullable=False, server_default="1"))


def downgrade():
    op.drop_column("playback_devices", "volume")
    op.drop_column("playback_states", "commands_json")
    op.drop_column("playback_states", "applied_revision")
