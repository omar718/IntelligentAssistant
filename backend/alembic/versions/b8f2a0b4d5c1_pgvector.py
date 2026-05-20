"""enable_pgvector_and_cast_embedding

Revision ID: b8f2a0b4d5c1_pgvector
Revises: b8f2a0b4d5c1
Create Date: 2026-05-04 00:00:01.000000

Builds on b8f2a0b4d5c1 which added the raw Text column.
This migration:
  1. Enables the pgvector extension
  2. Casts the existing Text column to vector(384)
  3. Creates an IVFFlat index for fast similarity search
"""
from typing import Sequence, Union
from alembic import op

revision: str = 'b8f2a0b4d5c1_pgvector'
down_revision: Union[str, Sequence[str], None] = 'b8f2a0b4d5c1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Enable pgvector extension
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # 2. Cast existing Text column to vector(384)
    # Existing rows have NULL so the USING NULL cast is safe
    op.execute(
        "ALTER TABLE error_patterns "
        "ALTER COLUMN embedding TYPE vector(384) "
        "USING NULL"
    )

    # 3. IVFFlat index for cosine similarity search
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_error_patterns_embedding "
        "ON error_patterns "
        "USING ivfflat (embedding vector_cosine_ops) "
        "WITH (lists = 100)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_error_patterns_embedding")
    op.execute(
        "ALTER TABLE error_patterns "
        "ALTER COLUMN embedding TYPE text "
        "USING embedding::text"
    )