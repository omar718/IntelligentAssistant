"""add_embedding_to_error_patterns

Revision ID: b8f2a0b4d5c1
Revises: add_audit_logs_001
Create Date: 2026-05-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8f2a0b4d5c1'
down_revision: Union[str, Sequence[str], None] = 'add_audit_logs_001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('error_patterns', sa.Column('embedding', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('error_patterns', 'embedding')