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
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('audit_logs'):
        op.create_table(
            'audit_logs',
            sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
            sa.Column('actor_id', sa.String(length=50), nullable=False),
            sa.Column('target_type', sa.String(length=50), nullable=False),
            sa.Column('target_id', sa.String(length=50), nullable=True),
            sa.Column('action', sa.String(length=100), nullable=False),
            sa.Column('metadata', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ondelete='RESTRICT'),
            sa.PrimaryKeyConstraint('id'),
        )

    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_id ON audit_logs (actor_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_target_type ON audit_logs (target_type)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs (action)")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('audit_logs')
