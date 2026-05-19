"""add_profile_image_url_to_users

Revision ID: b4f9d2a0c1e3
Revises: add_audit_logs_001
Create Date: 2026-04-19 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4f9d2a0c1e3'
down_revision: Union[str, Sequence[str], None] = 'add_audit_logs_001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('profile_image_url', sa.String(length=512), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'profile_image_url')
