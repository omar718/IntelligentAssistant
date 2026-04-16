import asyncio
import json
import logging
from pathlib import Path

import redis

from app.core.config import settings
from app.tasks import celery

logger = logging.getLogger(__name__)


def _infer_project_type(project_type: str | None, metadata: dict, project_name: str | None = None) -> str | None:
    candidate = (project_type or metadata.get("detected_pm") or "").strip().lower()

    if candidate in {"nodejs", "node", "npm", "yarn", "pnpm"}:
                return "nodejs"

    if candidate in {"python", "pip", "pipenv", "poetry"}:
      return "python"

    constraints = metadata.get("version_constraints") or {}
    if "python" in constraints:
        return "python"
    if "node" in constraints:
        return "nodejs"

    if project_name:
        lower_name = project_name.lower()
        if lower_name.endswith((".py", ".ipynb")):
            return "python"
        if lower_name.endswith((".js", ".ts", ".jsx", ".tsx")):
            return "nodejs"

    return None


def _get_loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


def _emit(project_id: str, event: str, data: dict):
    """Emit a WS event via Redis pub/sub so API and worker processes can communicate."""
    try:
        payload = json.dumps({"event": event, "data": data})
        channel = f"project_events:{project_id}"
        redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
        redis_client.publish(channel, payload)
        redis_client.close()
    except Exception as e:
        logger.warning("WS emit failed (non-fatal): %s", e)


def _update_project_status(project_id: str, status: str):
    """Update project status in DB using a sync session."""
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
    Execution engine — Sprint 3.
    metadata is project.metadata_ from the DB:
    {
        "detected_pm": "npm" | "pip" | ...,
        "steps": [...],
        "env_vars": {...},
        "version_constraints": {...},
        "host_path": "C:\\Users\\...",   (added below)
    }
    """
    logger.info("install_project started for %s", project_id)

    # ── Read project path from DB ──────────────────────────────────
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
            project_name = project.name
    except Exception as e:
        logger.exception("Failed to load project from DB")
        _emit(project_id, "status_change", {
            "old_status": "installing",
            "new_status": "failed",
            "error": str(e),
        })
        raise

    version_constraints = metadata.get("version_constraints") or {}
    detected_pm = metadata.get("detected_pm", "")

    # ── Stage 1: Detect conflicts ──────────────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 10})
    _emit(project_id, "installation_progress", {
        "progress": 10,
        "step": "Detecting environment conflicts",
    })

    try:
        from app.core.execution.conflict_detector import ConflictDetector, ConflictResolver

        detector = ConflictDetector()

        # Build a simple namespace the detector can work with
        class _Info:
            pass
        info = _Info()
        info.version_constraints = version_constraints
        info.ports = [3000]   # default; will be updated after detection
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
        # ConflictDetector not yet implemented — skip, continue with local
        logger.warning("ConflictDetector not found, skipping conflict detection")
        plan = None
        report = None

    # ── Stage 2: Resolve + decide strategy ────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 25})
    _emit(project_id, "installation_progress", {
        "progress": 25,
        "step": "Resolving conflicts",
    })

    use_venv = False
    node_version = None
    use_docker = False

    if plan:
        use_docker = plan.use_docker
        for step in plan.steps:
            strategy = step.strategy.value if hasattr(step.strategy, "value") else str(step.strategy)
            if strategy == "venv":
                use_venv = True
            elif strategy == "nvm":
                node_version = version_constraints.get("node")

    # ── Stage 3: Install dependencies ─────────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 40})
    _emit(project_id, "installation_progress", {
        "progress": 40,
        "step": f"Installing dependencies ({detected_pm or project_type})",
    })

    def log_callback(line: str):
        _emit(project_id, "log", {"level": "info", "message": line})

    rollback_ops = []

    try:
        from app.core.execution.package_installer import NodeJsInstaller, PythonInstaller

        if project_type == "nodejs":
            installer = NodeJsInstaller(
                project_path=project_path,
                node_version=node_version,
                on_log=log_callback,
            )
        elif project_type == "python":
            installer = PythonInstaller(
                project_path=project_path,
                use_venv=use_venv,
                on_log=log_callback,
            )
            if use_venv:
                venv_path = project_path / ".venv"
                rollback_ops.append(
                    lambda: venv_path.exists() and venv_path.unlink()
                )
        else:
            logger.warning(
                "Project type is missing or unsupported for %s; defaulting to nodejs install path",
                project_id,
            )
            project_type = "nodejs"
            installer = NodeJsInstaller(
                project_path=project_path,
                node_version=node_version,
                on_log=log_callback,
            )

        self.update_state(state="PROGRESS", meta={"progress": 60})
        result = _get_loop().run_until_complete(installer.install())

        if not result.success:
            raise RuntimeError(result.error_output or "Installation failed")

    except ImportError:
        # Installers not yet implemented — simulate success for testing
        logger.warning("PackageInstaller not found — running in stub mode")
        result = None

    # ── Stage 4: Done ──────────────────────────────────────────────
    self.update_state(state="PROGRESS", meta={"progress": 100})
    _update_project_status(project_id, "running")

    _emit(project_id, "installation_progress", {
        "progress": 100,
        "step": "Installation complete",
    })
    _emit(project_id, "status_change", {
        "old_status": "installing",
        "new_status": "running",
        "port": 3000,
    })

    logger.info("install_project completed for %s", project_id)
    return {"status": "success", "project_id": project_id}