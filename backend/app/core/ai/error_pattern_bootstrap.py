"""
Seed default error patterns and backfill embeddings on application startup.

This keeps a fresh database from starting with an empty error_patterns table
while still allowing the learning pipeline to add more rows over time.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)


DEFAULT_ERROR_PATTERNS: list[dict[str, Any]] = [
    {
        "signature": r"ModuleNotFoundError: No module named ['\"]django['\"]",
        "category": "dependency",
        "project_type": "python",
        "solutions": [
            {
                "description": "Install Django in the active environment",
                "commands": [["python", "-m", "pip", "install", "django"]],
                "success_rate": 0.95,
            }
        ],
        "success_rate": 0.9,
    },
    {
        "signature": r"ModuleNotFoundError: No module named ['\"]flask['\"]",
        "category": "dependency",
        "project_type": "python",
        "solutions": [
            {
                "description": "Install Flask in the active environment",
                "commands": [["python", "-m", "pip", "install", "flask"]],
                "success_rate": 0.95,
            }
        ],
        "success_rate": 0.9,
    },
    {
        "signature": r"npm ERR! code ERESOLVE",
        "category": "dependency",
        "project_type": "nodejs",
        "solutions": [
            {
                "description": "Retry npm install with legacy peer dependency resolution",
                "commands": [["npm", "install", "--legacy-peer-deps"]],
                "success_rate": 0.85,
            }
        ],
        "success_rate": 0.8,
    },
    {
        "signature": r"could not translate host name ['\"]db['\"] to address",
        "category": "config",
        "project_type": None,
        "solutions": [
            {
                "description": "Use the local database hostname or start the Docker database",
                "commands": [["docker", "compose", "up", "-d", "db"]],
                "success_rate": 0.8,
            }
        ],
        "success_rate": 0.75,
    },
    {
        "signature": r"FATAL: database ['\"]intelligent_assistant['\"] does not exist",
        "category": "config",
        "project_type": "python",
        "solutions": [
            {
                "description": "Create the PostgreSQL database",
                "commands": [["psql", "-U", "postgres", "-h", "localhost", "-c", "CREATE DATABASE intelligent_assistant;"]],
                "success_rate": 0.8,
            }
        ],
        "success_rate": 0.75,
    },
    {
        "signature": r"vendor/autoload\.php",
        "category": "dependency",
        "project_type": "php",
        "solutions": [
            {
                "description": "Install Composer dependencies",
                "commands": [["composer", "install"]],
                "success_rate": 0.92,
            }
        ],
        "success_rate": 0.88,
    },
    {
        "signature": r"APP_KEY.*not set|No application encryption key has been specified",
        "category": "config",
        "project_type": "php",
        "solutions": [
            {
                "description": "Generate the Laravel application key",
                "commands": [["php", "artisan", "key:generate", "--force"]],
                "success_rate": 0.95,
            }
        ],
        "success_rate": 0.9,
    },
]


def seed_default_error_patterns() -> int:
    """Insert default error patterns if the table is empty."""
    try:
        from sqlalchemy import func

        from app.db.session import get_sync_session
        from app.models.error_pattern import ErrorPattern

        with get_sync_session() as db:
            existing_count = db.query(func.count(ErrorPattern.id)).scalar() or 0
            if existing_count:
                return 0

            for item in DEFAULT_ERROR_PATTERNS:
                db.add(
                    ErrorPattern(
                        signature=item["signature"],
                        category=item["category"],
                        project_type=item["project_type"],
                        solutions=item["solutions"],
                        occurrences=1,
                        success_rate=item["success_rate"],
                    )
                )

            db.commit()
            logger.info("Seeded %d default error patterns", len(DEFAULT_ERROR_PATTERNS))
            return len(DEFAULT_ERROR_PATTERNS)

    except Exception as exc:
        logger.warning("Default error-pattern seeding failed (non-fatal): %s", exc)
        return 0


def bootstrap_error_patterns_on_startup() -> None:
    """Seed default patterns, then backfill embeddings in a background thread."""

    def _run() -> None:
        try:
            seeded = seed_default_error_patterns()
            if seeded:
                logger.info("Startup error-pattern seed inserted %d rows", seeded)

            from app.core.ai.embedding_service import EmbeddingService

            updated = EmbeddingService().backfill_missing_embeddings()
            if updated:
                logger.info("Startup embedding backfill updated %d patterns", updated)
            else:
                logger.debug("Startup embedding backfill found no missing embeddings")
        except Exception as exc:
            logger.warning("Startup error-pattern bootstrap failed (non-fatal): %s", exc)

    thread = threading.Thread(target=_run, daemon=True, name="error-pattern-bootstrap")
    thread.start()