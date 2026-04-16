import asyncio
import logging
import os
import uuid
import subprocess
import re
import threading
import time
from queue import Queue, Empty
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional, Dict, Any
from app.core.analysis.project_analyzer import ProjectAnalyzer
from app.core.analysis.nlp_processor import NLPProcessor
from app.core.database import get_db                     # ← one import, always async
from app.api.dependencies import CurrentUser
from app.db.crud import project_crud
from app.models.project import Project, ProjectStatus
from app.core.redis import (
    set_task_state,
    get_task_state,
    is_task_cancelled,
    set_task_cancelled,
)

logger = logging.getLogger(__name__)

router = APIRouter()
analyzer = ProjectAnalyzer()
nlp = NLPProcessor()

CLONE_BASE_DIR = Path(os.getenv("CLONE_BASE_DIR", "/tmp/intelligent-assistant"))
HOST_CLONE_BASE_DIR = os.getenv("HOST_CLONE_BASE_DIR", "C:/tmp/intelligent-assistant")

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

# We still need this for subprocess management (process instance cannot be serialized to Redis)
TASK_PROCESSES: Dict[str, subprocess.Popen] = {}
TASK_PROCESSES_LOCK = threading.Lock()


class TaskCancelledError(Exception):
    pass


def _register_task_process(task_id: Optional[str], process: subprocess.Popen) -> None:
    if not task_id:
        return
    with TASK_PROCESSES_LOCK:
        TASK_PROCESSES[task_id] = process


def _unregister_task_process(task_id: Optional[str]) -> None:
    if not task_id:
        return
    with TASK_PROCESSES_LOCK:
        TASK_PROCESSES.pop(task_id, None)


async def _request_task_cancel(task_id: str) -> bool:
    # First mark as cancelled in Redis (persistent)
    await set_task_cancelled(task_id)
    
    # Then try to kill the local process if it exists on THIS worker
    with TASK_PROCESSES_LOCK:
        process = TASK_PROCESSES.get(task_id)

    if process and process.poll() is None:
        logger.info("Terminating local process for task %s", task_id)
        process.terminate()
        return True
        
    return True # Return true because we marked it in Redis


async def set_task_progress(
    task_id: str,
    *,
    stage: str,
    progress: float,
    message: Optional[str] = None,
    done: bool = False,
    error: Optional[str] = None,
    project_id: Optional[str] = None,
    host_path: Optional[str] = None,
):
    payload: Dict[str, Any] = {
        "task_id": task_id,
        "stage": stage,
        "progress": max(0.0, min(100.0, float(progress))),
        "message": message,
        "done": done,
        "error": error,
        "updated_at": time.time()
    }
    if project_id:
        payload["project_id"] = project_id
    if host_path:
        payload["host_path"] = host_path

    # Check for existing "done" state to avoid overwriting final results
    previous = await get_task_state(task_id)
    if previous and previous.get("done"):
        return

    await set_task_state(task_id, payload)

def host_path_to_container(host_path: str) -> Path:
    norm = host_path.replace("\\", "/").rstrip("/")
    for host_prefix, container_prefix in PATH_MAPPINGS:
        if norm.lower().startswith(host_prefix.lower()):
            relative = norm[len(host_prefix):].lstrip("/")
            return Path(container_prefix) / relative if relative else Path(container_prefix)
    raise ValueError(
        f"The selected folder '{host_path}' is not accessible to the backend container. "
        f"It must be under one of: {[m[0] for m in PATH_MAPPINGS]}. "
    )

def container_path_to_host(container_path: Path) -> str:
    norm = str(container_path).replace("\\", "/")
    for host_prefix, container_prefix in PATH_MAPPINGS:
        cp = container_prefix.rstrip("/")
        if norm.startswith(cp + "/") or norm == cp:
            relative = norm[len(cp):].lstrip("/")
            host = host_prefix + ("/" + relative if relative else "")
            return host.replace("/", "\\")
    return norm.replace("/", "\\")

class ProjectSource(BaseModel):
    type: str
    url: Optional[str] = None
    path: Optional[str] = None
    clone_dir: Optional[str] = None
    model_config = {"extra": "allow"}

class CreateProjectRequest(BaseModel):
    source: ProjectSource
    task_id: Optional[str] = None

class ValidateRepositoryRequest(BaseModel):
    url: str

class ValidateRepositoryResponse(BaseModel):
    valid: bool
    error: Optional[str] = None

def _validate_git_repo(git_url: str) -> tuple[bool, str]:
    """
    Validate if a git repository is accessible using git ls-remote.
    Returns (is_valid, error_message)
    """
    if not git_url or not git_url.strip():
        return False, "Repository URL cannot be empty"
    
    git_url = git_url.strip()
    
    # Ensure HTTPS URL has proper format
    if git_url.startswith('git@'):
        # SSH URLs: git@github.com:user/repo.git
        pass
    elif not git_url.startswith('http://') and not git_url.startswith('https://'):
        # If URL doesn't end with http:// or https://, assume https://
        git_url = f"https://{git_url}"
    
    # Ensure .git suffix for proper git ls-remote validation
    if not git_url.endswith('.git'):
        git_url_with_git = f"{git_url}.git"
    else:
        git_url_with_git = git_url
    
    env = os.environ.copy()
    # Disable SSL verification for self-signed certificates (can add config option later)
    env['GIT_SSL_NO_VERIFY'] = '1'
    
    try:
        # Try with .git suffix first
        logger.debug(f"[Validate] Attempting git ls-remote with .git suffix: {git_url_with_git}")
        result = subprocess.run(
            ['git', 'ls-remote', '--heads', git_url_with_git],
            capture_output=True,
            text=True,
            timeout=10,
            env=env
        )
        
        if result.returncode == 0:
            logger.info(f"[Validate] Repository valid: {git_url}")
            return True, ""
        
        # If .git suffix failed and URL doesn't already have it, try without .git
        if git_url_with_git.endswith('.git') and not git_url.endswith('.git'):
            logger.debug(f"[Validate] Retrying without .git suffix: {git_url}")
            result = subprocess.run(
                ['git', 'ls-remote', '--heads', git_url],
                capture_output=True,
                text=True,
                timeout=10,
                env=env
            )
            if result.returncode == 0:
                logger.info(f"[Validate] Repository valid (without .git): {git_url}")
                return True, ""
        
        # Provide more detailed error messages
        error_output = result.stderr.strip() if result.stderr else result.stdout.strip()
        
        if result.returncode == 128:
            return False, f"Repository not found or not accessible: {git_url}"
        elif result.returncode == 1:
            # Often means authentication required or repo doesn't exist
            if 'not found' in error_output.lower() or 'does not exist' in error_output.lower():
                return False, f"Repository not found: {git_url}"
            return False, f"Failed to access repository. Please verify the URL is correct and the repo is public or you have access."
        elif result.returncode in [2, 127]:
            return False, "Git command not available or malformed URL"
        else:
            return False, f"Repository validation failed: {error_output if error_output else f'exit code {result.returncode}'}"
    
    except subprocess.TimeoutExpired:
        return False, "Repository validation timed out (>10s). The repository might be unavailable."
    except FileNotFoundError:
        return False, "Git is not installed on the server. Contact administrator."
    except Exception as e:
        logger.error(f"[Validate] Unexpected error validating {git_url}: {str(e)}")
        return False, f"Validation error: {str(e)}"

@router.post("/api/projects/validate", response_model=ValidateRepositoryResponse)
async def validate_repository(req: ValidateRepositoryRequest, current_user: CurrentUser):
    """Quick validation that a git repo exists without cloning it."""
    if not req.url:
        return ValidateRepositoryResponse(valid=False, error="Repository URL is required")
    
    logger.info("[Validate] Checking repository: %s", req.url)
    loop = asyncio.get_event_loop()
    is_valid, error_msg = await loop.run_in_executor(None, _validate_git_repo, req.url)
    
    if is_valid:
        logger.info("[Validate] Repository is valid: %s", req.url)
        return ValidateRepositoryResponse(valid=True)
    else:
        logger.warning("[Validate] Repository validation failed: %s - %s", req.url, error_msg)
        return ValidateRepositoryResponse(valid=False, error=error_msg)

@router.post("/api/projects")
async def create_project(
    req: CreateProjectRequest,
    current_user: CurrentUser,              # use auth dependency
    db: AsyncSession = Depends(get_db),
):
    project_id = f"proj_{uuid.uuid4().hex[:8]}"
    task_id = req.task_id or f"task_{uuid.uuid4().hex[:8]}"
    project_path = None
    logger.info("current_user: %s", current_user)  # ← add this
    logger.info("current_user.id: %s", current_user.id)  # ← and this

    await set_task_progress(
        task_id,
        stage="queued",
        progress=1,
        message="Queued",
    )


    try:
        if await is_task_cancelled(task_id):
            raise TaskCancelledError("task_cancelled")

        if req.source.type == "git":
            if not req.source.url:
                raise HTTPException(status_code=400, detail="url is required for git source")
            if req.source.clone_dir:
                try:
                    target_base = host_path_to_container(req.source.clone_dir)
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e))
            else:
                target_base = CLONE_BASE_DIR
            await set_task_progress(
                task_id,
                stage="cloning",
                progress=5,
                message="Cloning repository...",
            )
            loop = asyncio.get_event_loop()
            try:
                project_path = await loop.run_in_executor(None, _clone_repo, req.source.url, target_base, task_id, loop)
            except subprocess.CalledProcessError as e:
                if e.returncode == 128:
                    raise HTTPException(status_code=400, detail=f"The following repo {req.source.url} is not found! Make sure that is existing.")
                raise HTTPException(status_code=500, detail=f"Git clone failed: {str(e)}")

        elif req.source.type == "local":
            if not req.source.path:
                raise HTTPException(status_code=400, detail="path is required for local source")
            project_path = Path(req.source.path)
            if not project_path.exists():
                raise HTTPException(status_code=400, detail="path does not exist")
            await set_task_progress(
                task_id,
                stage="cloning",
                progress=70,
                message="Using local source...",
            )
        else:
            raise HTTPException(status_code=400, detail="invalid source type")

        if await is_task_cancelled(task_id):
            raise TaskCancelledError("task_cancelled")

        await set_task_progress(
            task_id,
            stage="analyzing",
            progress=78,
            message="Analyzing project...",
        )

        loop = asyncio.get_event_loop()
        logger.info("Analyzing project at %s", project_path)
        try:
            info = analyzer.detect_project_type(project_path)
        except Exception as e:
            logger.exception("detect_project_type failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Project analysis failed: {e}")

        try:
            await set_task_progress(
                task_id,
                stage="analyzing",
                progress=86,
                message="Parsing README instructions...",
            )
            nlp_result = await loop.run_in_executor(None, nlp.parse_readme, project_path)
            info = nlp.merge_with_project_info(info, nlp_result)
        except Exception as e:
            logger.warning("NLP analysis failed (non-fatal): %s", e)

        if await is_task_cancelled(task_id):
            raise TaskCancelledError("task_cancelled")

        project_name = Path(str(project_path)).name
        logger.info("Saving project '%s' to database", project_name)
        try:
            await set_task_progress(
                task_id,
                stage="analyzing",
                progress=93,
                message="Saving project metadata...",
            )
            await project_crud.create(db, {       # ← await added
                "id": project_id,
                "name": project_name,
                "user_id": current_user.id,      # <-- added user_id
                "type": info.primary_language,
                "path": str(project_path),
                "status": ProjectStatus.queued,
                "metadata_": {
                    "source_type": req.source.type,
                    "source_url": req.source.url,
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

        host_path = container_path_to_host(project_path)
        await set_task_progress(
            task_id,
            stage="launching",
            progress=100,
            message="Clone and analysis complete.",
            done=True,
            project_id=project_id,
            host_path=host_path,
        )

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

    except TaskCancelledError:
        await set_task_progress(
            task_id,
            stage="failed",
            progress=100,
            message="Task cancelled by user.",
            done=True,
            error="task_cancelled",
        )
        raise HTTPException(status_code=409, detail="Task cancelled")

    except HTTPException:
        await set_task_progress(
            task_id,
            stage="failed",
            progress=100,
            message="Project creation failed.",
            done=True,
            error="request_failed",
        )
        raise
    except Exception as e:
        logger.exception("Unexpected error in create_project: %s", e)
        await set_task_progress(
            task_id,
            stage="failed",
            progress=100,
            message="Project creation failed.",
            done=True,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")


@router.get("/api/projects/tasks/{task_id}")
async def get_project_task_status(
    task_id: str,
    current_user: CurrentUser,
):
    task = await get_task_state(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task


@router.post("/api/projects/tasks/{task_id}/cancel")
async def cancel_project_task(
    task_id: str,
    current_user: CurrentUser,
):
    success = await _request_task_cancel(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="Task not found")

    await set_task_progress(
        task_id,
        stage="cloning",
        progress=50,
        message="Cancellation requested...",
    )

    return {"task_id": task_id, "status": "cancellation_requested"}


@router.get("/api/projects/{project_id}")
async def get_project(
    project_id: str,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),    # ← same get_db, no alias needed
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    return {
        "id": project.id,
        "name": project.name,
        "type": project.type,
        "path": project.path,
        "status": project.status,
        "metadata": project.metadata_,
    }

#------------------------------------------------
# GET api/user/me/projects is defined in auth.py
#------------------------------------------------

def _update_git_phase_progress(task_id: Optional[str], base: int, span: int, line: str, loop: asyncio.AbstractEventLoop) -> Optional[float]:
    if not task_id:
        return None

    cleaned = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line).strip()
    if not cleaned:
        return None

    match = re.search(r"(\d{1,3})%", cleaned)
    if not match:
        return None

    raw_percent = max(0, min(100, int(match.group(1))))
    progress_value = base + (span * raw_percent / 100.0)
    
    # Schedule Redis update on the main event loop
    asyncio.run_coroutine_threadsafe(
        set_task_progress(task_id, stage="cloning", progress=progress_value, message=cleaned),
        loop
    )
    return progress_value


def _run_git_with_progress(cmd: list[str], task_id: Optional[str], base: int, span: int, start_message: str, loop: asyncio.AbstractEventLoop):
    if task_id:
        asyncio.run_coroutine_threadsafe(
            set_task_progress(task_id, stage="cloning", progress=base, message=start_message),
            loop
        )
    current_progress = float(base)
    last_heartbeat = time.monotonic()

    output_queue: Queue[tuple[str, str]] = Queue()

    def _reader(stream, stream_name: str):
        if stream is None:
            output_queue.put((stream_name, "__EOF__"))
            return

        buffer = ""
        try:
            while True:
                char = stream.read(1)
                if not char:
                    if buffer:
                        output_queue.put((stream_name, buffer))
                    break
                if char in ("\r", "\n"):
                    if buffer:
                        output_queue.put((stream_name, buffer))
                        buffer = ""
                else:
                    buffer += char
        finally:
            output_queue.put((stream_name, "__EOF__"))

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        universal_newlines=True,
        bufsize=1,
    )
    _register_task_process(task_id, process)

    stderr_thread = threading.Thread(target=_reader, args=(process.stderr, "stderr"), daemon=True)
    stdout_thread = threading.Thread(target=_reader, args=(process.stdout, "stdout"), daemon=True)
    stderr_thread.start()
    stdout_thread.start()

    eof_count = 0
    while eof_count < 2:
        # Check cancellation state in Redis (via loop)
        future = asyncio.run_coroutine_threadsafe(is_task_cancelled(task_id), loop)
        if future.result():
            if process.poll() is None:
                process.terminate()
            _unregister_task_process(task_id)
            raise TaskCancelledError("task_cancelled")

        now = time.monotonic()
        if task_id and process.poll() is None and now - last_heartbeat >= 1.0:
            max_fallback = float(base + span - 2)
            if current_progress < max_fallback:
                current_progress = min(max_fallback, current_progress + 1)
                asyncio.run_coroutine_threadsafe(
                    set_task_progress(task_id, stage="cloning", progress=current_progress, message="Cloning repository..."),
                    loop
                )
            last_heartbeat = now

        try:
            _, chunk = output_queue.get(timeout=0.2)
        except Empty:
            if process.poll() is not None and not (stderr_thread.is_alive() or stdout_thread.is_alive()):
                break
            continue

        if chunk == "__EOF__":
            eof_count += 1
            continue

        parsed_progress = _update_git_phase_progress(task_id, base, span, chunk, loop)
        if parsed_progress is not None:
            current_progress = max(current_progress, parsed_progress)
            last_heartbeat = time.monotonic()

    stderr_thread.join(timeout=1)
    stdout_thread.join(timeout=1)

    try:
        return_code = process.wait()
        if return_code != 0:
            future = asyncio.run_coroutine_threadsafe(is_task_cancelled(task_id), loop)
            if future.result():
                raise TaskCancelledError("task_cancelled")
            raise subprocess.CalledProcessError(return_code, cmd)
    finally:
        _unregister_task_process(task_id)

    if task_id:
        asyncio.run_coroutine_threadsafe(
            set_task_progress(task_id, stage="cloning", progress=base + span, message="Repository fetched."),
            loop
        )


def _clone_repo(git_url: str, base_dir: Path, task_id: Optional[str], loop: asyncio.AbstractEventLoop) -> Path:
    clone_base = base_dir if base_dir is not None else CLONE_BASE_DIR
    clone_base.mkdir(parents=True, exist_ok=True)
    repo_name = git_url.rstrip('/').split('/')[-1].removesuffix('.git')
    target = clone_base / repo_name
    if target.exists():
        _run_git_with_progress(['git', '-C', str(target), 'pull', '--progress'], task_id, 10, 60, 'Updating repository...', loop)
    else:
        _run_git_with_progress(['git', 'clone', '--progress', git_url, str(target)], task_id, 10, 60, 'Cloning repository...', loop)
    return target