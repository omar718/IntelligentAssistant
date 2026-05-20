"""add reports table

Revision ID: 90566226b2c0
Revises: e9cf3d693dc5
Create Date: 2026-05-15 01:40:50.851930

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import pgvector

# revision identifiers, used by Alembic.
revision: str = '90566226b2c0'
down_revision: Union[str, Sequence[str], None] = 'e9cf3d693dc5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the reports table matching your StackReport model
    op.create_table(
        'stack_reports',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.String(length=50), nullable=False),
        sa.Column('installation_history_id', sa.Integer(), nullable=True),
        sa.Column('r2_key', sa.String(length=500), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['installation_history_id'], ['installation_history.id'], ),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    
    # Add index for project_id as specified in your model (index=True)
    op.create_index(op.f('ix_stack_reports_project_id'), 'stack_reports', ['project_id'], unique=False)

def downgrade() -> None:
    op.drop_index(op.f('ix_stack_reports_project_id'), table_name='stack_reports')
    op.drop_table('stack_reports')