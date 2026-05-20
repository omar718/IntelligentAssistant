"""
Sprint 5 changes (── S5 ──):
  • ErrorAnalyzer called on InstallResult.success == False
  • Retry loop (max 3 attempts)
  • InstallationHistory written on every final outcome

Sprint 6 changes (── S6 ──):
  • LearningModule.suggest_optimized_workflow() called before install loop
  • LearningModule.record() replaces direct installation_writer call
"""
import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import redis

from app.core.config import settings
from app.tasks import celery

logger = logging.getLogger(__name__)

MAX_RETRY = 3


def _infer_project_type(project_type: str | None, metadata: dict, project_name: str | None = None) -> str | None:
    candidate = (project_type or metadata.get("detected_pm") or "").strip().lower()

    if candidate in {"nodejs", "node", "npm", "yarn", "pnpm"}:
        return "nodejs"
    if candidate in {"python", "pip", "pipenv", "poetry"}:
        return "python"
    if candidate in {"php", "composer"}:
        return "php"
    if candidate in {"java", "maven", "mvn", "gradle"}:
        return "java"
    if candidate in {"ruby", "bundler", "gem"}:
        return "ruby"
    if candidate in {"go", "golang"}:
        return "go"
    if candidate in {"dotnet", ".net", "csharp", "nuget"}:
        return "dotnet"

    constraints = metadata.get("version_constraints") or {}
    if "python" in constraints:
        return "python"
    if "node" in constraints:
        return "nodejs"
    if "php" in constraints:
        return "php"
    if "java" in constraints:
        return "java"
    if "ruby" in constraints:
        return "ruby"
    if "go" in constraints:
        return "go"

    if project_name:
        lower_name = project_name.lower()
        if lower_name.endswith((".py", ".ipynb")):
            return "python"
        if lower_name.endswith((".js", ".ts", ".jsx", ".tsx")):
            return "nodejs"
        if lower_name.endswith(".php"):
            return "php"
        if lower_name.endswith((".java", ".kt")):
            return "java"
        if lower_name.endswith(".rb"):
            return "ruby"
        if lower_name.endswith(".go"):
            return "go"
        if lower_name.endswith((".cs", ".sln")):
            return "dotnet"

    return None


def _get_loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


def _emit(project_id: str, event: str, data: dict):
    try:
        payload = json.dumps({"event": event, "data": data})
        channel = f"project_events:{project_id}"
        redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
        redis_client.publish(channel, payload)
        redis_client.close()
    except Exception as e:
        logger.warning("WS emit failed (non-fatal): %s", e)


def _update_project_status(project_id: str, status: str):
    try:
        from app.db.session import get_sync_session
        from app.models.project import Project, ProjectStatus
        with get_sync_session() as db:
            project = db.get(Project, project_id)
            if project:
                project.status = ProjectStatus(status)
                db.commit()
    except Exception as e:
        logger.warning("Status update failed (non-fatal): %s", e)


@celery.task(bind=True, name="install_project")
def install_project(self, project_id: str, metadata: dict):
    """
    metadata keys expected:
      detected_pm, steps, env_vars, version_constraints, host_path
    """
    logger.info("install_project started for %s", project_id)
    started_at = datetime.now(timezone.utc)

    # ── Read project from DB ───────────────────────────────────────
    try:
        from app.db.session import get_sync_session
        from app.models.project import Project
        with get_sync_session() as db:
            project = db.get(Project, project_id)
            if not project:
                raise RuntimeError(f"Project {project_id} not found")
            project_path = Path(project.path)
            project_type = _infer_project_type(project.type, metadata, project.name)
            if project_type and not project.type:
                project.type = project_type
                db.commit()
    except Exception as e:
        logger.exception("Failed to load project from DB")
        _emit(project_id, "status_change", {
            "old_status": "installing",
            "new_status": "failed",
            "error": str(e),
        })
        from app.core.ai.learning_module import LearningModule  # ── S6 ──
        LearningModule().record(
            project_id=project_id,
            project_type="unknown",
            steps=[],
            errors=[{"step": "db_load", "message": str(e)}],
            success=False,
            resolution_used="none",
        )
        raise

    version_constraints = metadata.get("version_constraints") or {}
    detected_pm = metadata.get("detected_pm", "")

    # ── Stage 1: Conflict detection ────────────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 10})
    _emit(project_id, "installation_progress", {
        "progress": 10,
        "step": "Detecting environment conflicts",
    })

    try:
        from app.core.execution.conflict_detector import ConflictDetector, ConflictResolver

        detector = ConflictDetector()

        class _Info:
            pass
        info = _Info()
        info.version_constraints = version_constraints
        info.ports = [3000]
        info.project_type = project_type

        report = _get_loop().run_until_complete(detector.check(info))
        _emit(project_id, "conflict_detected", {
            "has_conflicts": report.has_conflicts,
            "conflicts": [
                {
                    "type": c.type,
                    "component": c.component,
                    "required": c.required,
                    "actual": c.actual,
                    "severity": c.severity,
                    "install_hint": c.install_hint,
                    "ask_user": c.ask_user,
                    "prompt": c.prompt,
                }
                for c in report.conflicts
            ],
        })
        resolver = ConflictResolver()
        plan = resolver.resolve(report)

    except ImportError:
        logger.warning("ConflictDetector not found, skipping")
        plan = None
        report = None

    # ── Stage 2: Decide strategy ───────────────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 25})
    _emit(project_id, "installation_progress", {
        "progress": 25,
        "step": "Resolving conflicts",
    })

    use_venv = False
    node_version = None

    if plan:
        for step in plan.steps:
            strategy = step.strategy.value if hasattr(step.strategy, "value") else str(step.strategy)
            if strategy == "venv":
                use_venv = True
            elif strategy == "nvm":
                node_version = version_constraints.get("node")

    resolution_used = "venv" if use_venv else ("nvm" if node_version else "local")

    # ── S6: Query LearningModule for optimized workflow ────────────
    try:
        from app.core.ai.learning_module import LearningModule
        learning = LearningModule()
        workflow = learning.suggest_optimized_workflow(project_type)
        if workflow:
            logger.info(
                "LearningModule: suggested workflow for %s (sample=%d, success_rate=%.0f%%): %s",
                project_type, workflow.sample_size,
                workflow.success_rate * 100,
                workflow.steps,
            )
            _emit(project_id, "workflow_suggestion", {
                "steps": workflow.steps,
                "success_rate": workflow.success_rate,
                "sample_size": workflow.sample_size,
                "suggested_resolution": workflow.suggested_resolution,
            })
            # Override resolution strategy if learning suggests a better one
            if workflow.suggested_resolution == "venv" and not use_venv:
                logger.info("LearningModule: overriding resolution to venv")
                use_venv = True
                resolution_used = "venv"
        else:
            logger.info("LearningModule: no workflow suggestion yet for %s", project_type)
    except Exception as exc:
        logger.warning("LearningModule suggestion failed (non-fatal): %s", exc)

    # ── Stage 3: Install (with retry on failure) ───────────────────
    self.update_state(state="PROGRESS", meta={"progress": 40})
    _emit(project_id, "installation_progress", {
        "progress": 40,
        "step": f"Installing dependencies ({detected_pm or project_type})",
    })

    def log_callback(line: str):
        _emit(project_id, "log", {"level": "info", "message": line})

    result = None
    last_error: str = ""

    for attempt in range(1, MAX_RETRY + 1):
        try:
            from app.core.execution.package_installer import get_installer

            extra: dict = {}
            if project_type in ("nodejs", "node"):
                extra["node_version"] = node_version
            elif project_type == "python":
                extra["use_venv"] = use_venv

            try:
                installer = get_installer(
                    project_type=project_type,
                    project_path=project_path,
                    on_log=log_callback,
                    **extra,
                )
            except ValueError:
                logger.warning(
                    "Unsupported project type '%s' — defaulting to nodejs", project_type
                )
                project_type = "nodejs"
                installer = get_installer(
                    project_type="nodejs",
                    project_path=project_path,
                    on_log=log_callback,
                    node_version=node_version,
                )

            self.update_state(state="PROGRESS", meta={"progress": 40 + attempt * 10})
            result = _get_loop().run_until_complete(installer.install())

        except ImportError:
            logger.warning("PackageInstaller not found — running in stub mode")
            result = None
            break

        if result is None or result.success:
            break

        last_error = result.error_output or "Installation failed"
        logger.warning("Attempt %d/%d failed: %s", attempt, MAX_RETRY, last_error[:200])

        if attempt == MAX_RETRY:
            break

        _emit(project_id, "installation_progress", {
            "progress": 40 + attempt * 10,
            "step": f"Analyzing error (attempt {attempt}/{MAX_RETRY})",
        })

        try:
            from app.core.execution.error_analyzer import ErrorAnalyzer

            analyzer = ErrorAnalyzer(
                project_path=project_path,
                project_type=project_type,
                on_log=log_callback,
            )
            analysis = analyzer.analyze(last_error)
            apply_result = _get_loop().run_until_complete(
                analyzer.apply_top_fix(analysis, project_path)
            )
            _emit(project_id, "log", {
                "level": "info" if apply_result.success else "warning",
                "message": (
                    f"[S5] Fix applied: {apply_result.solution_used.description}"
                    if apply_result.success
                    else "[S5] No applicable fix found — retrying anyway"
                ),
            })
        except Exception as exc:
            logger.warning("ErrorAnalyzer raised an exception: %s", exc)

    # ── Stage 4: Finalise ──────────────────────────────────────────
    final_success = result is None or result.success

    if not final_success:
        _update_project_status(project_id, "failed")
        _emit(project_id, "status_change", {
            "old_status": "installing",
            "new_status": "failed",
            "error": last_error,
        })
    else:
        self.update_state(state="PROGRESS", meta={"progress": 100})
        _update_project_status(project_id, "running")
        _emit(project_id, "installation_progress", {"progress": 100, "step": "Installation complete"})
        _emit(project_id, "status_change", {
            "old_status": "installing",
            "new_status": "running",
            "port": 3000,
        })

    # ── S6: LearningModule.record() replaces direct installation_writer call ──
    try:
        from app.core.ai.learning_module import LearningModule
        from app.core.execution.installation_writer import (
            steps_from_result,
            errors_from_result,
        )
        LearningModule().record(
            project_id=project_id,
            project_type=project_type or "unknown",
            steps=steps_from_result(result),
            errors=errors_from_result(result, [last_error] if last_error else []),
            success=final_success,
            resolution_used=resolution_used,
        )
    except Exception as exc:
        logger.warning("LearningModule.record failed (non-fatal): %s", exc)

    if not final_success:
        raise RuntimeError(f"Installation failed after {MAX_RETRY} attempts: {last_error}")

    logger.info("install_project completed for %s", project_id)
 
    # ── NEW: Generate PDF stack report on success (auth-gated) ───────────────
    if health.ok and config.get("user_authenticated", False):
        import asyncio
        from app.services.generate_and_save_report import generate_and_save_report
 
        report_data = {
            "project_name":        config["project_name"],
            "project_id":          project_id,
            "user_email":          config.get("user_email", "unknown"),
            "stack":               result.stack_info,          # dict from execution result
            "environment":         result.env_vars,
            "dependencies":        result.dependencies,
            "installation_steps":  result.steps_log,
            "health_checks":       health.checks_as_dicts(),
            "conflicts_resolved":  resolution.conflicts_log,
            "notes":               health.ai_notes or "",
        }
 
        try:
            r2_key = asyncio.get_event_loop().run_until_complete(
                generate_and_save_report(project_id, result.history_id, report_data)
            )
            self.update_state(state="DONE", meta={"progress": 100, "report_key": r2_key})
        except Exception as exc:
            logger.warning("Stack report generation failed (non-fatal): %s", exc)
 
    return {
        "status":     "success" if health.ok else "failed",
        "progress":   100,
        "details":    health.details,
    }
