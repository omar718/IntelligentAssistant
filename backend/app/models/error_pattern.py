from sqlalchemy import Column, Integer, String, Float, JSON, Text
from pgvector.sqlalchemy import Vector
from app.models.base import Base


class ErrorPattern(Base):
    __tablename__ = "error_patterns"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    signature    = Column(String, nullable=False)   # regex or substring
    category     = Column(String(50))               # dependency | config | permission | launch_recovery
    project_type = Column(String(50))               # nodejs | python | php ... | NULL = generic
    solutions    = Column(JSON)                     # List[Solution]
    occurrences  = Column(Integer, default=1)
    success_rate = Column(Float)

    # ── RAG: semantic embedding ───────────────────────────────────────────────
    # Stored as pgvector vector(384). SQLAlchemy sees it as Text;
    # pgvector handles the casting transparently at the DB level.
    # NULL means embedding not yet generated (backfill_missing_embeddings() fills these).
    embedding    = Column(Vector(384), nullable=True, comment="384-dim pgvector embedding")