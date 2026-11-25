"""Minute precision for mixes; move the former 05:00 schedule to 07:30."""
import sqlalchemy as sa
from alembic import op

revision = "e5b9a3c7d201"
down_revision = "d4e8f2a6b901"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("mix_settings", sa.Column("mix_minute", sa.Integer(), nullable=False, server_default="0"))
    op.execute("UPDATE mix_settings SET mix_hour = 7, mix_minute = 30 WHERE mix_hour = 5")


def downgrade():
    op.execute("UPDATE mix_settings SET mix_hour = 5 WHERE mix_hour = 7 AND mix_minute = 30")
    op.drop_column("mix_settings", "mix_minute")
