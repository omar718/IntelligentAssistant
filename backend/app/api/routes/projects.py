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
from app.websocket.router import manager
from app.db.crud import project_crud
from app.models.project import Project, ProjectStatus
from app.tasks.install import install_project

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

TASK_PROGRESS: Dict[str, Dict[str, Any]] = {}
TASK_PROGRESS_LOCK = threading.Lock()
TASK_CANCELLED: set[str] = set()
TASK_PROCESSES: Dict[str, subprocess.Popen] = {}


class TaskCancelledError(Exception):
    pass


def _is_task_cancelled(task_id: Optional[str]) -> bool:
    if not task_id:
        return False
    with TASK_PROGRESS_LOCK:
        return task_id in TASK_CANCELLED


def _register_task_process(task_id: Optional[str], process: subprocess.Popen) -> None:
    if not task_id:
        return
    with TASK_PROGRESS_LOCK:
        TASK_PROCESSES[task_id] = process


def _unregister_task_process(task_id: Optional[str]) -> None:
    if not task_id:
        return
    with TASK_PROGRESS_LOCK:
        TASK_PROCESSES.pop(task_id, None)


def _request_task_cancel(task_id: str) -> bool:
    with TASK_PROGRESS_LOCK:
        if task_id not in TASK_PROGRESS:
            return False
        TASK_CANCELLED.add(task_id)
        process = TASK_PROCESSES.get(task_id)

    if process and process.poll() is None:
        process.terminate()

    return True


def set_task_progress(
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
    }
    if project_id:
        payload["project_id"] = project_id
    if host_path:
        payload["host_path"] = host_path

    with TASK_PROGRESS_LOCK:
        previous = TASK_PROGRESS.get(task_id, {})
        if previous.get("done"):
            return
        TASK_PROGRESS[task_id] = payload

def host_path_to_container(host_path: str) -> Path:
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

    set_task_progress(
        task_id,
        stage="queued",
        progress=1,
        message="Queued",
    )


    try:
        if _is_task_cancelled(task_id):
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
            set_task_progress(
                task_id,
                stage="cloning",
                progress=5,
                message="Cloning repository...",
            )
            loop = asyncio.get_event_loop()
            project_path = await loop.run_in_executor(None, _clone_repo, req.source.url, target_base, task_id)

        elif req.source.type == "local":
            if not req.source.path:
                raise HTTPException(status_code=400, detail="path is required for local source")
            project_path = Path(req.source.path)
            if not project_path.exists():
                raise HTTPException(status_code=400, detail="path does not exist")
            set_task_progress(
                task_id,
                stage="cloning",
                progress=70,
                message="Using local source...",
            )
        else:
            raise HTTPException(status_code=400, detail="invalid source type")

        if _is_task_cancelled(task_id):
            raise TaskCancelledError("task_cancelled")

        set_task_progress(
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
            set_task_progress(
                task_id,
                stage="analyzing",
                progress=86,
                message="Parsing README instructions...",
            )
            nlp_result = await loop.run_in_executor(None, nlp.parse_readme, project_path)
            info = nlp.merge_with_project_info(info, nlp_result)
            primary_language = info.primary_language

            # If analyzer missed it, derive from version_constraints
            if not primary_language and info.version_constraints:
                vc = info.version_constraints
                if 'php' in vc:    primary_language = 'php'
                elif 'python' in vc: primary_language = 'python'
                elif 'node' in vc:   primary_language = 'nodejs'
                elif 'java' in vc:   primary_language = 'java'
                elif 'ruby' in vc:   primary_language = 'ruby'
                elif 'go' in vc:     primary_language = 'go'

        except Exception as e:
            logger.warning("NLP analysis failed (non-fatal): %s", e)

        if _is_task_cancelled(task_id):
            raise TaskCancelledError("task_cancelled")

        project_name = Path(str(project_path)).name
        logger.info("Saving project '%s' to database", project_name)
        try:
            set_task_progress(
                task_id,
                stage="analyzing",
                progress=93,
                message="Saving project metadata...",
            )
            await project_crud.create(db, {       # ← await added
                "id": project_id,
                "name": project_name,
                "user_id": current_user.id,      # <-- added user_id
                "type": primary_language,
                "path": str(project_path),
                "port": info.launch_port,
                "status": ProjectStatus.queued,
                "metadata_": {
                    "host_path": container_path_to_host(project_path),
                    "detected_pm": info.primary_pm,
                    "entry_point": info.entry_point,
                    "run_command": info.run_command,
                    "launch_port": info.launch_port,
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
        set_task_progress(
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
            "entry_point": info.entry_point,
            "run_command": info.run_command,
            "launch_port": info.launch_port,
            "path": str(project_path),
            "host_path": host_path,
            "steps": info.steps,
            "env_vars": info.env_vars,
            "version_constraints": info.version_constraints,
            "host_path": host_path,
        }

    except TaskCancelledError:
        set_task_progress(
            task_id,
            stage="failed",
            progress=100,
            message="Task cancelled by user.",
            done=True,
            error="task_cancelled",
        )
        raise HTTPException(status_code=409, detail="Task cancelled")

    except HTTPException:
        set_task_progress(
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
        set_task_progress(
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
    with TASK_PROGRESS_LOCK:
        task = TASK_PROGRESS.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task


@router.post("/api/projects/tasks/{task_id}/cancel")
async def cancel_project_task(
    task_id: str,
    current_user: CurrentUser,
):
    cancelled = _request_task_cancel(task_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Task not found")

    set_task_progress(
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


@router.get("/api/projects/{project_id}/status")
async def get_project_status(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Public lightweight status endpoint used by VS Code install polling."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return {
        "id": project.id,
        "type": project.type,
        "path": project.path,
        "status": project.status,
        "port": project.port,
        "metadata": project.metadata_,
    }


@router.post("/api/projects/{project_id}/install")
async def trigger_install(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    project.status = ProjectStatus.installing
    await db.commit()

    # Tell the extension to start installing
    # The extension is subscribed to this project's WS channel
    await manager.broadcast(project_id, {
        "event": "start_installation",
        "data": {
            "project_id": project_id,
            "host_path": project.metadata_.get("host_path"),
            "project_type": project.type,
            "detected_pm": project.metadata_.get("detected_pm"),
            "steps": project.metadata_.get("steps", []),
            "env_vars": project.metadata_.get("env_vars", {}),
            "version_constraints": project.metadata_.get("version_constraints", {}),
            "run_command": project.metadata_.get("run_command"),
            "launch_port": project.metadata_.get("launch_port", 3000),
        },
    })

    return {"status": "installing", "project_id": project_id}

# GET api/user/me/projects is defined in auth.py
#------------------------------------------------

def _update_git_phase_progress(task_id: Optional[str], base: int, span: int, line: str) -> Optional[float]:
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
    set_task_progress(
        task_id,
        stage="cloning",
        progress=progress_value,
        message=cleaned,
    )
    return progress_value


def _run_git_with_progress(cmd: list[str], task_id: Optional[str], base: int, span: int, start_message: str):
    if task_id:
        set_task_progress(task_id, stage="cloning", progress=base, message=start_message)
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
        if _is_task_cancelled(task_id):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
            _unregister_task_process(task_id)
            raise TaskCancelledError("task_cancelled")

        now = time.monotonic()
        if task_id and process.poll() is None and now - last_heartbeat >= 1.0:
            max_fallback = float(base + span - 2)
            if current_progress < max_fallback:
                current_progress = min(max_fallback, current_progress + 1)
                set_task_progress(
                    task_id,
                    stage="cloning",
                    progress=current_progress,
                    message="Cloning repository...",
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

        parsed_progress = _update_git_phase_progress(task_id, base, span, chunk)
        if parsed_progress is not None:
            current_progress = max(current_progress, parsed_progress)
            last_heartbeat = time.monotonic()

    stderr_thread.join(timeout=1)
    stdout_thread.join(timeout=1)

    try:
        return_code = process.wait()
        if return_code != 0:
            if _is_task_cancelled(task_id):
                raise TaskCancelledError("task_cancelled")
            raise subprocess.CalledProcessError(return_code, cmd)
    finally:
        _unregister_task_process(task_id)

    if task_id:
        set_task_progress(
            task_id,
            stage="cloning",
            progress=base + span,
            message="Repository fetched.",
        )


def _clone_repo(git_url: str, base_dir: Path = None, task_id: Optional[str] = None) -> Path:
    clone_base = base_dir if base_dir is not None else CLONE_BASE_DIR
    clone_base.mkdir(parents=True, exist_ok=True)
    repo_name = git_url.rstrip('/').split('/')[-1].removesuffix('.git')
    target = clone_base / repo_name
    if target.exists():
        _run_git_with_progress(['git', '-C', str(target), 'pull', '--progress'], task_id, 10, 60, 'Updating existing repository...')
    else:
        _run_git_with_progress(['git', 'clone', '--progress', git_url, str(target)], task_id, 10, 60, 'Cloning repository...')
    return target

class InstallLogRequest(BaseModel):
    message: str
    level: str = "info"

class InstallCompleteRequest(BaseModel):
    success: bool
    error: Optional[str] = None
    port: Optional[int] = None


@router.post("/api/projects/{project_id}/install-log")
async def install_log(
    project_id: str,
    body: InstallLogRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Extension streams install output lines here — we relay to dashboard WS."""
    await manager.broadcast(project_id, {
        "event": "log",
        "data": {"level": body.level, "message": body.message},
    })
    return {"ok": True}


@router.post("/api/projects/{project_id}/install-progress")
async def install_progress(
    project_id: str,
    body: dict,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Extension reports progress percentage here — we relay to dashboard WS."""
    await manager.broadcast(project_id, {
        "event": "installation_progress",
        "data": body,
    })
    return {"ok": True}


@router.post("/api/projects/{project_id}/install-complete")
async def install_complete(
    project_id: str,
    body: InstallCompleteRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Extension calls this when installation finishes (success or failure)."""
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404)

    if body.success:
        project.status = ProjectStatus.running
        if body.port:
            project.port = body.port
        await db.commit()
        await manager.broadcast(project_id, {
            "event": "status_change",
            "data": {
                "old_status": "installing",
                "new_status": "running",
                "port": body.port or 3000,
            },
        })
    else:
        project.status = ProjectStatus.failed
        await db.commit()
        await manager.broadcast(project_id, {
            "event": "status_change",
            "data": {
                "old_status": "installing",
                "new_status": "failed",
                "error": body.error or "Installation failed",
            },
        })

    return {"ok": True}