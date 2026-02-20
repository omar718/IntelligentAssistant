import uuid
import subprocess
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.analysis.project_analyzer import ProjectAnalyzer
from app.core.analysis.nlp_processor import NLPProcessor

router = APIRouter()
analyzer = ProjectAnalyzer()
nlp = NLPProcessor()

CLONE_BASE_DIR = Path("C:/tmp/intelligent-assistant")

class ProjectSource(BaseModel):
    type: str            # "git" or "local"
    url: Optional[str]=None   # if git
    path: Optional[str] = None  # if local (from VS Code extension)

    model_config = {"extra":"allow"}
class CreateProjectRequest(BaseModel):
    source: ProjectSource

@router.post("/api/projects")
async def create_project(req: CreateProjectRequest):
    project_id = f"proj_{uuid.uuid4().hex[:8]}"
    task_id = f"task_{uuid.uuid4().hex[:8]}"

    # Determine project path
    if req.source.type == "git":
        if not req.source.url:
            raise HTTPException(status_code=400, detail="url is required for git source")
        project_path = _clone_repo(req.source.url)

    elif req.source.type == "local":
        if not req.source.path:
            raise HTTPException(status_code=400, detail="path is required for local source")
        project_path = Path(req.source.path)
        if not project_path.exists():
            raise HTTPException(status_code=400, detail="path does not exist")

    # Analyze
    info = analyzer.detect_project_type(project_path)
    nlp_result = nlp.parse_readme(project_path)
    info = nlp.merge_with_project_info(info, nlp_result)

    # Open VS Code on the project folder
    code_path = "D:\\software installs\\Microsoft VS Code\\bin\\code.cmd"
    subprocess.Popen([code_path, str(project_path)], shell=True)

    # TODO: persist to DB, queue Celery task
    return {
        "project_id": project_id,
        "status": "queued",
        "task_id": task_id,
        "detected_type": info.primary_language,
        "detected_pm": info.primary_pm,
        "path": str(project_path),
        "steps": info.steps,
        "env_vars": info.env_vars,
        "version_constraints": info.version_constraints,
    }

@router.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    # TODO: query DB
    return {"id": project_id, "status": "analyzing"}

def _clone_repo(git_url: str) -> Path:
    CLONE_BASE_DIR.mkdir(parents=True, exist_ok=True)
    repo_name = git_url.rstrip('/').split('/')[-1].removesuffix('.git')
    target = CLONE_BASE_DIR / repo_name

    if target.exists():
        # Already cloned, just pull latest
        subprocess.run(['git', '-C', str(target), 'pull'], check=True)
    else:
        subprocess.run(['git', 'clone', git_url, str(target)], check=True)

    return target