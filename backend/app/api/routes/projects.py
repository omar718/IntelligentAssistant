import asyncio
import json
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
from app.core.config import settings
from app.core.database import get_db                     
from app.api.dependencies import CurrentUser, OptionalCurrentUser
from app.websocket.router import manager
from app.db.crud import project_crud
from app.models.project import Project, ProjectStatus
from app.models.error_pattern import ErrorPattern
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

def normalize_local_source_path(source_path: str) -> Path:
    raw_path = Path(source_path)
    if raw_path.exists():
        return raw_path

    try:
        return host_path_to_container(source_path)
    except ValueError:
        return raw_path

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
    current_user: OptionalCurrentUser,              # allow anonymous
    db: AsyncSession = Depends(get_db),
):
    project_id = f"proj_{uuid.uuid4().hex[:8]}"
    task_id = req.task_id or f"task_{uuid.uuid4().hex[:8]}"
    project_path = None
    logger.info("current_user: %s", current_user)
    logger.info("current_user.id: %s", getattr(current_user, 'id', None))

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
            project_path = normalize_local_source_path(req.source.path)
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
            logger.info("Project analysis: language=%s, services=%s", info.primary_language, 
                        [{"name": s.get("name"), "path": s.get("path"), "type": s.get("project_type")} for s in info.services])
        except Exception as e:
            logger.exception("detect_project_type failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Project analysis failed: {e}")

        # Initialize primary_language from analysis (fallback to None if NLP fails)
        primary_language = info.primary_language

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
                "user_id": getattr(current_user, 'id', None),
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
                    "install_guide_url": info.install_guide_url,
                    "services": info.services,
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
            "install_guide_url": info.install_guide_url,
            "services": info.services,
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
    current_user: OptionalCurrentUser,
):
    with TASK_PROGRESS_LOCK:
        task = TASK_PROGRESS.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task


@router.post("/api/projects/tasks/{task_id}/cancel")
async def cancel_project_task(
    task_id: str,
    current_user: OptionalCurrentUser,
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
            "services": project.metadata_.get("services", []),
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


class LaunchRecoveryRequest(BaseModel):
    error_output: str
    project_type: Optional[str] = None
    command: Optional[str] = None
    launch_output: Optional[str] = None


class LaunchRecoveryFeedbackRequest(BaseModel):
    pattern_id: int
    success: bool


def _signature_matches(signature: str, error_output: str) -> bool:
    try:
        return bool(re.search(signature, error_output, re.IGNORECASE))
    except re.error:
        return signature.lower() in error_output.lower()


def _build_error_signature(error_output: str) -> str:
    normalized = str(error_output or "").strip()
    if not normalized:
        return "unknown_launch_error"

    module_match = re.search(
        r"ModuleNotFoundError:\s+No module named ['\"]([^'\"]+)['\"]",
        normalized,
        re.IGNORECASE,
    )
    if module_match:
        module_name = module_match.group(1).strip().lower()
        if module_name:
            return re.escape(f"ModuleNotFoundError: No module named '{module_name}'")

    file_match = re.search(r"can't open file[^\n\r]+", normalized, re.IGNORECASE)
    if file_match:
        return re.escape(file_match.group(0).strip()[:240])

    first_line = normalized.splitlines()[0].strip()
    if not first_line:
        return "unknown_launch_error"
    return re.escape(first_line[:240])


async def _upsert_error_pattern(
    db: AsyncSession,
    *,
    signature: str,
    project_type: Optional[str],
    category: str,
    solutions: Optional[list[dict]] = None,
    default_success_rate: float = 0.5,
) -> Optional[ErrorPattern]:
    normalized_signature = str(signature or "").strip() or "unknown_launch_error"
    normalized_project_type = str(project_type or "").strip().lower() or None

    filters = [ErrorPattern.signature == normalized_signature]
    if normalized_project_type is None:
        filters.append(ErrorPattern.project_type.is_(None))
    else:
        filters.append(ErrorPattern.project_type == normalized_project_type)

    existing_result = await db.execute(select(ErrorPattern).where(*filters))
    existing = existing_result.scalar_one_or_none()

    if existing:
        existing.occurrences = int(existing.occurrences or 0) + 1
        if existing.success_rate is None:
            existing.success_rate = default_success_rate
        if solutions is not None:
            existing.solutions = solutions
        if category and not existing.category:
            existing.category = category
        db.add(existing)
        await db.commit()
        await db.refresh(existing)
        return existing

    created = ErrorPattern(
        signature=normalized_signature,
        category=category,
        project_type=normalized_project_type,
        solutions=solutions if solutions is not None else [],
        occurrences=1,
        success_rate=default_success_rate,
    )
    db.add(created)
    await db.commit()
    await db.refresh(created)
    return created


def _coerce_solution_list(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        return []

    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        commands = item.get("commands")
        if not isinstance(commands, list):
            continue

        argv_commands: list[list[str]] = []
        for command in commands:
            if not isinstance(command, list):
                continue
            argv = [str(part) for part in command if str(part).strip()]
            if argv:
                joined = " ".join(argv).lower()
                if (
                    "npm init" in joined
                    or "npm pkg" in joined
                    or "npm set" in joined
                    or "package.json" in joined
                    or "> package.json" in joined
                ):
                    continue
                argv_commands.append(argv)

        if not argv_commands:
            continue

        out.append(
            {
                "description": str(item.get("description") or "Suggested fix"),
                "commands": argv_commands,
                "success_rate": float(item.get("success_rate", 0.5)),
            }
        )

    out.sort(key=lambda s: s.get("success_rate", 0.5), reverse=True)
    return out


def _ai_suggest_launch_fixes(
    project_type: str,
    error_output: str,
    launch_output: str,
    command: str,
) -> list[dict]:
    if not settings.GROQ_API_KEY:
        return []

    try:
        from groq import Groq

        client = Groq(api_key=settings.GROQ_API_KEY)

        prompt = f"""
You are an installer recovery assistant. A local project launch failed.

Project type: {project_type}
Attempted command: {command}

Error output:
{error_output[:2500]}

Recent launch logs:
{launch_output[:2500]}

Return ONLY JSON array (no markdown), max 3 items.
Each item must be:
{{
  "description": "short fix title",
  "commands": [["cmd", "arg1"], ["cmd2", "arg"]],
  "success_rate": 0.0
}}

Rules:
- argv arrays only (no shell strings)
- prioritize non-destructive local fixes
- do not suggest deleting source code
- do not suggest editing package.json or running npm init/pkg/set commands
"""

        message = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )

        raw_text = message.choices[0].message.content or "[]"
        raw_text = re.sub(r"^```[a-zA-Z]*\n?|```$", "", raw_text, flags=re.MULTILINE).strip()
        parsed = json.loads(raw_text)
        return _coerce_solution_list(parsed)
    except Exception as exc:
        logger.warning("Launch recovery Groq fallback failed: %s", exc)
        return []


@router.post("/api/projects/{project_id}/launch-recovery")
async def launch_recovery(
    project_id: str,
    body: LaunchRecoveryRequest,
    db: AsyncSession = Depends(get_db),
):
    
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_type = body.project_type or project.type or "unknown"
    error_output = body.error_output or ""
    launch_output = body.launch_output or ""
    command = body.command or ""
    metadata = project.metadata_ if isinstance(project.metadata_, dict) else {}
    install_guide_url = metadata.get("install_guide_url") if metadata else None
    normalized_error = error_output.lower()

    from app.core.ai.embedding_service import EmbeddingService
    rag_matches = EmbeddingService().find_similar(error_output, project_type, limit=3)
    if rag_matches:
        best = rag_matches[0]
        solutions = _coerce_solution_list(best["solutions"])
        if solutions:
            return {
                "project_id": project_id,
                "pattern_id": best["id"],
                "source": "rag",
                "solutions": solutions[:3],
                "guidance": None,
                "install_guide_url": install_guide_url,
            }

    if "scram-server-first-message" in normalized_error and "password must be a string" in normalized_error:
        guidance = (
            "Database credentials are missing or invalid. Configure EverShop database env vars "
            "(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) and ensure DB_PASSWORD is a non-empty string, "
            "then retry launch."
        )
        if isinstance(install_guide_url, str) and install_guide_url.strip():
            guidance = f"{guidance} See the project install guide: {install_guide_url.strip()}"

        return {
            "project_id": project_id,
            "source": "rule",
            "solutions": [],
            "guidance": guidance,
            "install_guide_url": install_guide_url,
        }

    rows_result = await db.execute(
        select(ErrorPattern).where(
            (ErrorPattern.project_type == project_type)
            | (ErrorPattern.project_type.is_(None))
        )
    )
    rows = rows_result.scalars().all()

    for row in rows:
        if not row.signature:
            continue
        if _signature_matches(row.signature, error_output):
            try:
                row.occurrences = int(row.occurrences or 0) + 1
                if row.success_rate is None:
                    row.success_rate = 0.5
                db.add(row)
                await db.commit()
                await db.refresh(row)
            except Exception as exc:
                await db.rollback()
                logger.warning("Failed to update matched launch recovery pattern usage: %s", exc)

            solutions = _coerce_solution_list(row.solutions)
            if solutions:
                return {
                    "project_id": project_id,
                    "pattern_id": row.id,
                    "source": "db",
                    "solutions": solutions[:3],
                    "guidance": None,
                    "install_guide_url": install_guide_url,
                }

    ai_solutions = _ai_suggest_launch_fixes(project_type, error_output, launch_output, command)
    persisted_pattern_id = None
    try:
        signature = _build_error_signature(error_output)
        persisted = await _upsert_error_pattern(
            db,
            signature=signature,
            project_type=project_type,
            category="launch_recovery",
            solutions=ai_solutions,
            default_success_rate=0.5 if ai_solutions else 0.0,
        )

        persisted_pattern_id = persisted.id if persisted else None
        if persisted_pattern_id:
            import threading
            from app.core.ai.embedding_service import EmbeddingService
            threading.Thread(
                target=EmbeddingService().store_embedding,
                args=(persisted_pattern_id, error_output),
                daemon=True,
            ).start()

    except Exception as exc:
        await db.rollback()
        logger.warning("Failed to persist launch recovery pattern: %s", exc)

    return {
        "project_id": project_id,
        "pattern_id": persisted_pattern_id,
        "source": "groq" if ai_solutions else "none",
        "solutions": ai_solutions[:3],
        "guidance": None,
        "install_guide_url": install_guide_url,
    }


@router.post("/api/projects/{project_id}/launch-recovery-feedback")
async def launch_recovery_feedback(
    project_id: str,
    body: LaunchRecoveryFeedbackRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    _ = project_id
    result = await db.execute(select(ErrorPattern).where(ErrorPattern.id == body.pattern_id))
    pattern = result.scalar_one_or_none()
    if not pattern:
        raise HTTPException(status_code=404, detail="Error pattern not found")

    previous_occurrences = int(pattern.occurrences or 0)
    previous_rate = float(pattern.success_rate if pattern.success_rate is not None else 0.5)
    updated_occurrences = previous_occurrences + 1
    success_value = 1.0 if body.success else 0.0
    updated_rate = ((previous_rate * previous_occurrences) + success_value) / max(updated_occurrences, 1)

    pattern.occurrences = updated_occurrences
    pattern.success_rate = round(updated_rate, 4)
    db.add(pattern)
    await db.commit()

    return {
        "ok": True,
        "pattern_id": pattern.id,
        "occurrences": pattern.occurrences,
        "success_rate": pattern.success_rate,
    }


@router.post("/api/projects/{project_id}/install-log")
async def install_log(
    project_id: str,
    body: InstallLogRequest,
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

# ── Generate PDF stack report ─────────────────────────────
        try:
            from app.services.generate_and_save_report import generate_and_save_report
            from app.models.user import User
            import json
            from pathlib import Path

            metadata     = project.metadata_ or {}
            project_path = Path(project.path)
            project_type = project.type or "unknown"
            port         = body.port or metadata.get("launch_port", 3000)

            # ── Dependencies from package.json / requirements.txt ──
            dependencies = []
            if project_type == "nodejs":
                pkg_file = project_path / "package.json"
                if pkg_file.exists():
                    try:
                        pkg  = json.loads(pkg_file.read_text())
                        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                        dependencies = [
                            {"name": k, "version": v.lstrip("^~>=<"), "status": "installed"}
                            for k, v in list(deps.items())[:25]
                        ]
                    except Exception:
                        pass
            elif project_type == "python":
                req_file = project_path / "requirements.txt"
                if req_file.exists():
                    try:
                        for line in req_file.read_text().splitlines():
                            line = line.strip()
                            if line and not line.startswith("#"):
                                parts = line.replace("==", " ").replace(">=", " ").split()
                                dependencies.append({
                                    "name":    parts[0],
                                    "version": parts[1] if len(parts) > 1 else "latest",
                                    "status":  "installed",
                                })
                        dependencies = dependencies[:25]
                    except Exception:
                        pass

            # ── Env vars from .env file ──
            env_vars = metadata.get("env_vars") or {}
            env_file = project_path / ".env"
            if env_file.exists() and not env_vars:
                try:
                    for line in env_file.read_text().splitlines():
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            env_vars[k.strip()] = v.strip()
                except Exception:
                    pass

            # ── Framework detection ──
            framework = "unknown"
            if project_type == "nodejs":
                pkg_file = project_path / "package.json"
                if pkg_file.exists():
                    try:
                        pkg_deps = json.loads(pkg_file.read_text()).get("dependencies", {})
                        for fw in ["express", "fastify", "koa", "next", "nuxt", "nest", "vite"]:
                            if fw in pkg_deps:
                                framework = fw.capitalize()
                                break
                    except Exception:
                        pass
            elif project_type == "python":
                req_file = project_path / "requirements.txt"
                if req_file.exists():
                    content = req_file.read_text().lower()
                    for fw in ["django", "flask", "fastapi"]:
                        if fw in content:
                            framework = fw.capitalize()
                            break

            # ── Runtime version ──
            version_constraints = metadata.get("version_constraints") or {}
            runtime_version = "latest"
            nvmrc = project_path / ".nvmrc"
            if nvmrc.exists():
                runtime_version = nvmrc.read_text().strip()
            elif "node" in version_constraints:
                runtime_version = version_constraints["node"]
            elif "python" in version_constraints:
                runtime_version = version_constraints["python"]

            # ── User email ──
            user_email = ""
            try:
                user_result = await db.execute(select(User).where(User.id == project.user_id))
                user = user_result.scalar_one_or_none()
                if user:
                    user_email = user.email
            except Exception:
                pass

            # ── History ID ──
            history_id = None
            try:
                from app.models.installation_history import InstallationHistory
                from sqlalchemy import desc
                hist_result = await db.execute(
                    select(InstallationHistory)
                    .where(InstallationHistory.project_id == project_id)
                    .order_by(desc(InstallationHistory.id))
                    .limit(1)
                )
                history     = hist_result.scalar_one_or_none()
                history_id  = history.id if history else None
            except Exception:
                pass

            report_data = {
                "project_name": project.name,
                "project_id":   project_id,
                "user_email":   user_email,
                "stack": {
                    "type":            project_type,
                    "framework":       framework,
                    "language":        project_type,
                    "package_manager": metadata.get("detected_pm", "unknown"),
                    "node_version":    runtime_version,
                    "entry_point":     metadata.get("entry_point") or metadata.get("run_command", "unknown"),
                    "port":            port,
                    "resolution":      "local",
                },
                "environment":  env_vars,
                "dependencies": dependencies,
                "installation_steps": [
                    {"order": 1, "action": "install_packages", "status": "success", "duration_s": None},
                    {"order": 2, "action": "env_setup",        "status": "success", "duration_s": None},
                    {"order": 3, "action": "launch",           "status": "success", "duration_s": None},
                ],
                "health_checks": [
                    {"name": "installation", "detail": "Completed successfully", "passed": True},
                    {"name": "port",         "detail": f"Port {port} in use",    "passed": True},
                ],
                "conflicts_resolved": [],
                "notes": f"Project installed via VS Code extension. Port: {port}",
            }

            await generate_and_save_report(project_id, history_id, report_data)
            logger.info("Stack report generated for project %s", project_id)

        except Exception as exc:
            logger.warning("Stack report generation failed (non-fatal): %s", exc)
    else:
        project.status = ProjectStatus.failed
        await db.commit()

        try:
            install_error = str(body.error or "Installation failed")
            signature = _build_error_signature(install_error)
            await _upsert_error_pattern(
                db,
                signature=signature,
                project_type=project.type,
                category="install_failure",
                solutions=[],
                default_success_rate=0.0,
            )
        except Exception as exc:
            await db.rollback()
            logger.warning("Failed to persist install failure pattern: %s", exc)

        await manager.broadcast(project_id, {
            "event": "status_change",
            "data": {
                "old_status": "installing",
                "new_status": "failed",
                "error": body.error or "Installation failed",
            },
        })
    # ── LearningModule.record() ────────────────────────────────────────

    try:
        from app.core.ai.learning_module import LearningModule
        import asyncio

        errors = [{"step": "launch", "message": body.error}] if body.error else []

        _success = body.success
        _errors = [{"step": "launch", "message": body.error}] if body.error else []
        _project_type = project.type or "unknown"

        await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: LearningModule().record(
                project_id=project_id,
                project_type=_project_type,
                steps=[],
                errors=_errors,
                success=_success,
                resolution_used="local",
            )
        )
    except Exception as exc:
        logger.warning("LearningModule.record from install-complete failed: %s", exc)

    return {"ok": True}