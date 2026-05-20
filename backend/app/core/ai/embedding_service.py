"""
Generates and stores sentence embeddings for ErrorPattern rows.
Uses sentence-transformers (all-MiniLM-L6-v2) — 80MB, runs on CPU, no API key.

Usage:
    service = EmbeddingService()
    embedding = service.embed("Cannot find module 'express'")
    similar  = service.find_similar("module express not found", "nodejs", limit=3)
"""
from __future__ import annotations
import re
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

# Dimension produced by all-MiniLM-L6-v2
EMBEDDING_DIM = 384

# Minimum cosine similarity to consider a match (0-1 scale)
SIMILARITY_THRESHOLD = 0.55

def _clean_signature(raw: str) -> str:
    """Strip regex syntax to get clean embeddable text."""
    text = re.sub(r"[\[\]\\'\"\(\)\.\*\+\?\^${}|]", " ", raw)
    return re.sub(r"\s+", " ", text).strip()


class EmbeddingService:
    """
    Singleton-friendly service — model is loaded once and reused.
    Lazy-loaded so importing this file never blocks startup.
    """

    _model = None  # shared across instances

    def __init__(self):
        pass  # model loaded lazily on first use

    # ── Model loading ─────────────────────────────────────────────────────────

    def _get_model(self):
        if EmbeddingService._model is None:
            try:
                from sentence_transformers import SentenceTransformer
                logger.info("Loading sentence-transformers model (first use)...")
                EmbeddingService._model = SentenceTransformer("all-MiniLM-L6-v2")
                logger.info("Embedding model loaded successfully")
            except ImportError:
                raise RuntimeError(
                    "sentence-transformers is not installed. "
                    "Run: pip install sentence-transformers"
                )
        return EmbeddingService._model

    # ── Public: embed text ────────────────────────────────────────────────────

    def embed(self, text: str) -> List[float]:
        """
        Convert text to a 384-dimensional embedding vector.
        Returns a plain Python list (JSON-serialisable).
        """
        model = self._get_model()
        vector = model.encode(text, normalize_embeddings=True)
        return vector.tolist()

    # ── Public: find similar patterns ─────────────────────────────────────────

    def find_similar(
        self,
        error_output: str,
        project_type: str,
        limit: int = 3,
    ) -> List[dict]:
        """
        Find the most semantically similar ErrorPattern rows using pgvector.

        Returns a list of dicts:
        [
            {
                "id": int,
                "signature": str,
                "solutions": list,
                "success_rate": float,
                "similarity": float,   # 0.0 – 1.0
            },
            ...
        ]
        Only returns rows with similarity >= SIMILARITY_THRESHOLD.
        """
        try:
            query_embedding = self.embed(error_output)
            return self._query_similar(query_embedding, project_type, limit)
        except Exception as exc:
            logger.warning("Embedding similarity search failed (non-fatal): %s", exc)
            return []

    # ── Public: store embedding for a pattern ─────────────────────────────────

    def store_embedding(self, pattern_id: int, text: str) -> bool:
        """
        Generate and persist an embedding for an ErrorPattern row.
        Called after inserting a new pattern or seeding existing ones.
        Returns True on success.
        """
        try:
            from app.db.session import get_sync_session
            from app.models.error_pattern import ErrorPattern

            embedding = self.embed(text)
            with get_sync_session() as db:
                row = db.get(ErrorPattern, pattern_id)
                if row is None:
                    return False
                row.embedding = embedding
                db.commit()
            logger.info("Stored embedding for pattern id=%s", pattern_id)
            return True
        except Exception as exc:
            logger.warning("store_embedding failed for id=%s: %s", pattern_id, exc)
            return False

    # ── Public: backfill all patterns without embeddings ─────────────────────

    def backfill_missing_embeddings(self) -> int:
        """
        Generate embeddings for any ErrorPattern rows that have embedding=NULL.
        Called once at startup or after seeding.
        Returns number of rows updated.
        """
        try:
            from app.db.session import get_sync_session
            from app.models.error_pattern import ErrorPattern

            with get_sync_session() as db:
                rows = (
                    db.query(ErrorPattern)
                    .filter(ErrorPattern.embedding.is_(None))
                    .all()
                )
                row_data = [(row.id, row.signature or "") for row in rows]

            updated = 0
            for row_id, signature in row_data:
                text = _clean_signature(signature)
                if not text:
                    continue
                if self.store_embedding(row_id, text):
                    updated += 1

            if updated:
                logger.info("Backfilled embeddings for %d error patterns", updated)
            return updated

        except Exception as exc:
            logger.warning("backfill_missing_embeddings failed: %s", exc)
            return 0

    # ── Private: pgvector similarity query ───────────────────────────────────

    def _query_similar(
        self,
        query_embedding: List[float],
        project_type: str,
        limit: int,
    ) -> List[dict]:
        from app.db.session import get_sync_session

        # Format vector for pgvector: '[0.1, 0.2, ...]'
        vector_str = "[" + ",".join(f"{v:.6f}" for v in query_embedding) + "]"

        sql = f"""
            SELECT
                id,
                signature,
                solutions,
                success_rate,
                1 - (embedding <=> '{vector_str}'::vector) AS similarity
            FROM error_patterns
            WHERE
                embedding IS NOT NULL
                AND (project_type = :project_type OR project_type IS NULL)
                AND (1 - (embedding <=> '{vector_str}'::vector)) >= :threshold
            ORDER BY embedding <=> '{vector_str}'::vector
            LIMIT :limit
        """

        with get_sync_session() as db:
            from sqlalchemy import text
            rows = db.execute(
                text(sql),
                {
                    "project_type": project_type,
                    "threshold": SIMILARITY_THRESHOLD,
                    "limit": limit,
                },
            ).fetchall()

        return [
            {
                "id": row.id,
                "signature": row.signature,
                "solutions": row.solutions or [],
                "success_rate": float(row.success_rate or 0.5),
                "similarity": float(row.similarity),
            }
            for row in rows
        ]