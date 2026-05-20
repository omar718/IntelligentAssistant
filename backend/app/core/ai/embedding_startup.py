"""
Call this once at application startup to backfill embeddings for any
ErrorPattern rows that were seeded before pgvector was added.
"""
from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)


def backfill_embeddings_on_startup() -> None:
    """
    Run embedding backfill in a background thread so it doesn't block
    FastAPI startup. Safe to call multiple times — skips rows that
    already have embeddings.
    """
    def _run():
        try:
            from app.core.ai.embedding_service import EmbeddingService
            updated = EmbeddingService().backfill_missing_embeddings()
            if updated:
                logger.info("Startup embedding backfill: updated %d patterns", updated)
            else:
                logger.debug("Startup embedding backfill: all patterns already embedded")
        except Exception as exc:
            logger.warning("Startup embedding backfill failed (non-fatal): %s", exc)

    thread = threading.Thread(target=_run, daemon=True, name="embedding-backfill")
    thread.start()
