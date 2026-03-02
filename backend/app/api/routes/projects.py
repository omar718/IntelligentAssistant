import asyncio
import logging
import os
import uuid
import subprocess
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from app.core.analysis.project_analyzer import ProjectAnalyzer
from app.core.analysis.nlp_processor import NLPProcessor
from app.db.session import get_db
from app.db.crud import project_crud
from app.models.project import ProjectStatus

logger = logging.getLogger(__name__)

router = APIRouter()
analyzer = ProjectAnalyzer()
nlp = NLPProcessor()

# Container path where repos are cloned (must be a bind-mounted host directory)
CLONE_BASE_DIR = Path(os.getenv("CLONE_BASE_DIR", "/tmp/intelligent-assistant"))
# Matching path on the Windows host (used so the browser can open VS Code)
HOST_CLONE_BASE_DIR = os.getenv("HOST_CLONE_BASE_DIR", "C:/tmp/intelligent-assistant")

# Additional path mappings: (host_prefix, container_prefix)
# Each entry allows users to pick any folder within that host directory.
PATH_MAPPINGS = [
    (
        os.getenv("HOST_USERS_DIR", "C:/Users").replace("\\", "/").rstrip("/"),
        os.getenv("CONTAINER_USERS_DIR", "/hostusers").rstrip("/"),
    ),
    (
        HOST_CLONE_BASE_DIR.replace("\\", "/").rstrip("/"),
        str(CLONE_BASE_DIR).rstrip("/"),
    ),
]

def host_path_to_container(host_path: str) -> Path:
    """Translate a Windows host path to its bind-mounted container equivalent."""
    norm = host_path.replace("\\", "/").rstrip("/")
    for host_prefix, container_prefix in PATH_MAPPINGS:
        if norm.lower().startswith(host_prefix.lower()):
            relative = norm[len(host_prefix):].lstrip("/")
            return Path(container_prefix) / relative if relative else Path(container_prefix)
    raise ValueError(
        f"The selected folder '{host_path}' is not accessible to the backend container. "
        f"It must be under one of: {[m[0] for m in PATH_MAPPINGS]}. "
        f"To add more paths, mount the folder in docker-compose.yaml."
    )

def container_path_to_host(container_path: Path) -> str:
    """Translate a container path back to its Windows host equivalent."""
    norm = str(container_path).replace("\\", "/")
    for host_prefix, container_prefix in PATH_MAPPINGS:
        cp = container_prefix.rstrip("/")
        if norm.startswith(cp + "/") or norm == cp:
            relative = norm[len(cp):].lstrip("/")
            host = host_prefix + ("/" + relative if relative else "")
            return host.replace("/", "\\")
    # fallback
    return norm.replace("/", "\\")

class ProjectSource(BaseModel):
    type: str            # "git" or "local"
    url: Optional[str]=None   # if git
    path: Optional[str] = None  # if local (from VS Code extension)
    clone_dir: Optional[str] = None  # desired clone destination (Windows host path)

    model_config = {"extra":"allow"}
class CreateProjectRequest(BaseModel):
    source: ProjectSource

@router.post("/api/projects")
async def create_project(req: CreateProjectRequest, db: Session = Depends(get_db)):
    project_id = f"proj_{uuid.uuid4().hex[:8]}"
    task_id = f"task_{uuid.uuid4().hex[:8]}"
    project_path = None

    try:
        # Determine project path
        if req.source.type == "git":
            if not req.source.url:
                raise HTTPException(status_code=400, detail="url is required for git source")
            # Resolve the container-side base directory from the optional host clone_dir
            if req.source.clone_dir:
                try:
                    target_base = host_path_to_container(req.source.clone_dir)
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e))
            else:
                target_base = CLONE_BASE_DIR
            # Run blocking git clone in a thread so the server stays responsive
            loop = asyncio.get_event_loop()
            project_path = await loop.run_in_executor(None, _clone_repo, req.source.url, target_base)

        elif req.source.type == "local":
            if not req.source.path:
                raise HTTPException(status_code=400, detail="path is required for local source")
            project_path = Path(req.source.path)
            if not project_path.exists():
                raise HTTPException(status_code=400, detail="path does not exist")
        else:
            raise HTTPException(status_code=400, detail="invalid source type")

        # Analyze (NLP call is blocking — run in executor too)
        loop = asyncio.get_event_loop()
        logger.info("Analyzing project at %s", project_path)
        try:
            info = analyzer.detect_project_type(project_path)
        except Exception as e:
            logger.exception("detect_project_type failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Project analysis failed: {e}")

        try:
            nlp_result = await loop.run_in_executor(None, nlp.parse_readme, project_path)
            info = nlp.merge_with_project_info(info, nlp_result)
        except Exception as e:
            logger.warning("NLP analysis failed (non-fatal): %s", e)
            # NLP failure is non-fatal — continue with what we have

        # Persist to DB
        project_name = Path(str(project_path)).name
        logger.info("Saving project '%s' to database", project_name)
        try:
            project_crud.create(db, {
                "id": project_id,
                "name": project_name,
                "type": info.primary_language,
                "path": str(project_path),
                "status": ProjectStatus.queued,
                "metadata_": {
                    "detected_pm": info.primary_pm,
                    "steps": info.steps,
                    "env_vars": info.env_vars,
                    "version_constraints": info.version_constraints,
                },
            })
            logger.info("Project '%s' saved with id '%s'", project_name, project_id)
        except Exception as e:
            logger.exception("Database insert failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Database error: {e}")

        # Convert the container path to its Windows host equivalent
        host_path = container_path_to_host(project_path)

        return {
            "project_id": project_id,
            "status": "queued",
            "task_id": task_id,
            "detected_type": info.primary_language,
            "detected_pm": info.primary_pm,
            "path": str(project_path),
            "host_path": host_path,
            "steps": info.steps,
            "env_vars": info.env_vars,
            "version_constraints": info.version_constraints,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unexpected error in create_project: %s", e)
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")

@router.get("/api/projects/{project_id}")
async def get_project(project_id: str, db: Session = Depends(get_db)):
    project = project_crud.get(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "id": project.id,
        "name": project.name,
        "type": project.type,
        "path": project.path,
        "status": project.status,
        "metadata": project.metadata_,
    }

def _clone_repo(git_url: str, base_dir: Path = None) -> Path:
    clone_base = base_dir if base_dir is not None else CLONE_BASE_DIR
    clone_base.mkdir(parents=True, exist_ok=True)
    repo_name = git_url.rstrip('/').split('/')[-1].removesuffix('.git')
    target = clone_base / repo_name

    if target.exists():
        # Already cloned, just pull latest
        subprocess.run(['git', '-C', str(target), 'pull'], check=True)
    else:
        subprocess.run(['git', 'clone', git_url, str(target)], check=True)

    return target