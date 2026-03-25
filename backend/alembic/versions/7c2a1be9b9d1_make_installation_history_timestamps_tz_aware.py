"""make_installation_history_timestamps_tz_aware

Revision ID: 7c2a1be9b9d1
Revises: 9e31ba76c8ee
Create Date: 2026-03-21 02:35:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c2a1be9b9d1'
down_revision: Union[str, Sequence[str], None] = '9e31ba76c8ee'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        'installation_history',
        'started_at',
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(),
        postgresql_using="started_at AT TIME ZONE 'UTC'",
        existing_nullable=True,
    )
    op.alter_column(
        'installation_history',
        'completed_at',
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(),
        postgresql_using="completed_at AT TIME ZONE 'UTC'",
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        'installation_history',
        'completed_at',
        type_=sa.DateTime(),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="completed_at AT TIME ZONE 'UTC'",
        existing_nullable=True,
    )
    op.alter_column(
        'installation_history',
        'started_at',
        type_=sa.DateTime(),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="started_at AT TIME ZONE 'UTC'",
        existing_nullable=True,
    )
