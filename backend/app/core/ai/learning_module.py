"""
Derives optmized workflows entirely from installation_history.
Reads what install_project already writes.

Public API:
    record(project_id, project_type, steps, success, resolution_used)
        → call at end of every install run (wraps installation_writer)

    suggest_optimized_workflow(project_type) -> OptimizedWorkflow | None
        → call before installing to get the best known step sequence

    get_stats(project_type) -> ProjectTypeStats
        → summary metrics for a project type
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from collections import Counter
from datetime import datetime, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)


# ── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class OptimizedWorkflow:
    project_type: str
    steps: List[str]               # ordered list of action names
    success_rate: float            # fraction of runs that used this workflow and succeeded
    sample_size: int               # how many past runs this is based on
    suggested_resolution: str      # "local" | "venv" | "nvm" | "container"


@dataclass
class ProjectTypeStats:
    project_type: str
    total_runs: int
    successful_runs: int
    success_rate: float
    most_common_resolution: str
    most_common_error: Optional[str]   # top error message seen across failed runs


# ── Main class ────────────────────────────────────────────────────────────────

class LearningModule:
    """
    Derives installation intelligence from installation_history rows.

    All DB access is synchronous (called from Celery worker context).
    """

    # ── Public: record ────────────────────────────────────────────────────────

    def record(
        self,
        project_id: str,
        project_type: str,
        steps: list,
        errors: list,
        success: bool,
        resolution_used: str,
    ) -> None:
        # Write InstallationHistory directly — no installation_writer dependency
        try:
            from app.db.session import get_sync_session
            from app.models.installation_history import InstallationHistory
            from datetime import datetime, timezone

            with get_sync_session() as db:
                row = InstallationHistory(
                    project_id=project_id,
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                    success=success,
                    steps=steps,
                    errors=errors,
                    resolution_used=resolution_used,
                )
                db.add(row)
                db.commit()
        except Exception as exc:
            logger.warning("InstallationHistory write failed: %s", exc)

        # Seed error pattern with embedding if install failed
        if not success and errors:
            self._maybe_seed_error_pattern(project_type, errors)

        logger.info(
            "LearningModule.record: project_type=%s success=%s", project_type, success
        )
    # ── Public: suggest_optimized_workflow ────────────────────────────────────

    def suggest_optimized_workflow(
        self,
        project_type: str,
        min_sample_size: int = 3,
    ) -> Optional[OptimizedWorkflow]:
        """
        Query installation_history for successful runs of this project_type.
        Find the most frequently occurring step sequence among them.
        Return None if there is insufficient history (< min_sample_size runs).

        Called by install.py before the retry loop so it can log/emit the
        suggestion — the actual installer does not change based on it yet,
        but the workflow is emitted over WebSocket so the frontend can show it.
        """
        try:
            rows = self._load_successful_rows(project_type)
        except Exception as exc:
            logger.warning("LearningModule DB query failed: %s", exc)
            return None

        if len(rows) < min_sample_size:
            logger.info(
                "LearningModule: not enough history for %s (%d runs, need %d)",
                project_type, len(rows), min_sample_size,
            )
            return None

        # ── Find most common step sequence ────────────────────────────────────
        workflow_counter: Counter = Counter()
        resolution_counter: Counter = Counter()

        for row in rows:
            steps_json = row.get("steps") or []
            key = tuple(s["action"] for s in steps_json if isinstance(s, dict))
            workflow_counter[key] += 1
            resolution_counter[row.get("resolution_used", "local")] += 1

        if not workflow_counter:
            return None

        best_sequence, count = workflow_counter.most_common(1)[0]
        success_rate = count / len(rows)
        most_common_resolution = resolution_counter.most_common(1)[0][0]

        return OptimizedWorkflow(
            project_type=project_type,
            steps=list(best_sequence),
            success_rate=round(success_rate, 3),
            sample_size=len(rows),
            suggested_resolution=most_common_resolution,
        )

    # ── Public: get_stats ─────────────────────────────────────────────────────

    def get_stats(self, project_type: str) -> ProjectTypeStats:
        """
        Return aggregate metrics for a project type.
        Used by the analytics dashboard endpoint.
        """
        try:
            all_rows = self._load_all_rows(project_type)
        except Exception as exc:
            logger.warning("LearningModule.get_stats DB query failed: %s", exc)
            return ProjectTypeStats(
                project_type=project_type,
                total_runs=0,
                successful_runs=0,
                success_rate=0.0,
                most_common_resolution="local",
                most_common_error=None,
            )

        total = len(all_rows)
        successful = sum(1 for r in all_rows if r.get("success"))
        success_rate = round(successful / total, 3) if total else 0.0

        resolution_counter: Counter = Counter(
            r.get("resolution_used", "local") for r in all_rows
        )
        most_common_resolution = (
            resolution_counter.most_common(1)[0][0] if resolution_counter else "local"
        )

        # Collect first error message from each failed run
        error_counter: Counter = Counter()
        for row in all_rows:
            if not row.get("success"):
                errors = row.get("errors") or []
                if errors and isinstance(errors[0], dict):
                    msg = errors[0].get("message", "")
                    if msg:
                        # Truncate to first 80 chars so similar errors group together
                        error_counter[msg[:80]] += 1

        most_common_error = (
            error_counter.most_common(1)[0][0] if error_counter else None
        )

        return ProjectTypeStats(
            project_type=project_type,
            total_runs=total,
            successful_runs=successful,
            success_rate=success_rate,
            most_common_resolution=most_common_resolution,
            most_common_error=most_common_error,
        )

    # ── Private: DB helpers ───────────────────────────────────────────────────

    def _load_successful_rows(self, project_type: str) -> list[dict]:
        """Return all successful installation_history rows for this project_type."""
        return self._query_rows(project_type, success_only=True)

    def _load_all_rows(self, project_type: str) -> list[dict]:
        return self._query_rows(project_type, success_only=False)

    def _query_rows(self, project_type: str, success_only: bool) -> list[dict]:
        from app.db.session import get_sync_session
        from app.models.installation_history import InstallationHistory
        from app.models.project import Project

        with get_sync_session() as db:
            query = (
                db.query(
                    InstallationHistory.steps,
                    InstallationHistory.errors,
                    InstallationHistory.success,
                    InstallationHistory.resolution_used,
                )
                .join(Project, Project.id == InstallationHistory.project_id)
                .filter(Project.type == project_type)
            )
            if success_only:
                query = query.filter(InstallationHistory.success.is_(True))

            rows = query.all()

        return [
            {
                "steps": r.steps,
                "errors": r.errors,
                "success": r.success,
                "resolution_used": r.resolution_used,
            }
            for r in rows
        ]
    def _maybe_seed_error_pattern(self, project_type: str, errors: list) -> None:
        print(f"[DEBUG] _maybe_seed_error_pattern called: project_type={project_type}, errors={errors[:1]}")
        print(f"[DEBUG] record called: success={success}, errors_count={len(errors) if errors else 0}, errors={errors[:1] if errors else []}")
        try:
            import re, json
            from app.db.session import get_sync_session
            from sqlalchemy import text

            for error in errors[:1]:
                msg = error.get("message", "").strip()
                if not msg or len(msg) < 10:
                    continue

                signature = re.escape(msg.splitlines()[0][:240])

                # Generate embedding before insert
                try:
                    from app.core.ai.embedding_service import EmbeddingService
                    embedding = EmbeddingService().embed(msg.splitlines()[0][:240])
                    vector_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
                except Exception:
                    vector_str = None

                with get_sync_session() as db:
                    exists = db.execute(
                        text("SELECT id FROM error_patterns WHERE signature = :sig"),
                        {"sig": signature}
                    ).fetchone()
                    if exists:
                        continue

                    if vector_str:
                        db.execute(
                            text(f"""
                                INSERT INTO error_patterns
                                    (signature, category, project_type, solutions,
                                    occurrences, success_rate, embedding)
                                VALUES
                                    (:sig, 'install_failure', :pt, '[]',
                                    1, 0.0, '{vector_str}'::vector)
                            """),
                            {"sig": signature, "pt": project_type}
                        )
                    else:
                        db.execute(
                            text("""
                                INSERT INTO error_patterns
                                    (signature, category, project_type, solutions,
                                    occurrences, success_rate)
                                VALUES
                                    (:sig, 'install_failure', :pt, '[]', 1, 0.0)
                            """),
                            {"sig": signature, "pt": project_type}
                        )
                        db.commit()

        except Exception as exc:
            logger.warning("_maybe_seed_error_pattern failed (non-fatal): %s", exc)