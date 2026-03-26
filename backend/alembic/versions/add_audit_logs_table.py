"""add audit_logs table

Revision ID: add_audit_logs_001
Revises: 7c2a1be9b9d1
Create Date: 2026-03-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_audit_logs_001'
down_revision: Union[str, Sequence[str], None] = '7c2a1be9b9d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('audit_logs',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('actor_id', sa.String(length=50), nullable=False),
    sa.Column('target_type', sa.String(length=50), nullable=False),
    sa.Column('target_id', sa.String(length=50), nullable=True),
    sa.Column('action', sa.String(length=100), nullable=False),
    sa.Column('metadata', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.Index('ix_audit_logs_actor_id', 'actor_id'),
    sa.Index('ix_audit_logs_target_type', 'target_type'),
    sa.Index('ix_audit_logs_action', 'action'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('audit_logs')
