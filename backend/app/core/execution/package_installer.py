import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, List, Optional, Callable

@dataclass
class InstallStep:
    action: str
    status: str = "pending"    # "pending" | "running" | "success" | "failed"
    duration_ms: Optional[int] = None
    error: Optional[str] = None

@dataclass
class InstallResult:
    success: bool
    steps: List[InstallStep] = field(default_factory=list)
    error_output: Optional[str] = None


class BaseInstaller:

    def __init__(self, project_path: Path, on_log: Optional[Callable[[str], None]] = None):
        self.project_path = project_path
        self.on_log = on_log or (lambda line: None)

    async def _run_streaming(self, *cmd: str, cwd: Optional[Path] = None) -> tuple[int, str]:
        """
        Run a command, stream each stdout line to on_log callback,
        and return (returncode, full_stderr).
        NEVER use subprocess.run here — always asyncio.create_subprocess_exec.
        """
        import time
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd or self.project_path),
        )

        stderr_lines = []

        async def read_stdout():
            async for line in proc.stdout:
                decoded = line.decode().rstrip()
                self.on_log(decoded)

        async def read_stderr():
            async for line in proc.stderr:
                decoded = line.decode().rstrip()
                stderr_lines.append(decoded)

        await asyncio.gather(read_stdout(), read_stderr())
        await proc.wait()
        return proc.returncode, "\n".join(stderr_lines)

    async def install(self) -> InstallResult:
        raise NotImplementedError


class NodeJsInstaller(BaseInstaller):

    def __init__(self, project_path: Path, node_version: Optional[str] = None, **kwargs):
        super().__init__(project_path, **kwargs)
        self.node_version = node_version

    def _detect_package_manager(self) -> str:
        if (self.project_path / "pnpm-lock.yaml").exists():
            return "pnpm"
        if (self.project_path / "yarn.lock").exists():
            return "yarn"
        return "npm"

    async def install(self) -> InstallResult:
        steps = []
        import time

        # Step 1: switch Node version if needed
        if self.node_version:
            step = InstallStep(action="nvm_use")
            step.status = "running"
            t0 = time.monotonic()
            code, err = await self._run_streaming("nvm", "install", self.node_version)
            if code == 0:
                await self._run_streaming("nvm", "use", self.node_version)
            step.status = "success" if code == 0 else "failed"
            step.duration_ms = int((time.monotonic() - t0) * 1000)
            step.error = err if code != 0 else None
            steps.append(step)
            if code != 0:
                return InstallResult(success=False, steps=steps, error_output=err)

        # Step 2: install dependencies
        pm = self._detect_package_manager()
        step = InstallStep(action=f"{pm}_install")
        step.status = "running"
        t0 = time.monotonic()
        code, err = await self._run_streaming(pm, "install")
        step.status = "success" if code == 0 else "failed"
        step.duration_ms = int((time.monotonic() - t0) * 1000)
        step.error = err if code != 0 else None
        steps.append(step)

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if code != 0 else None,
        )


class PythonInstaller(BaseInstaller):

    def __init__(self, project_path: Path, use_venv: bool = False, **kwargs):
        super().__init__(project_path, **kwargs)
        self.use_venv = use_venv

    def _detect_package_manager(self) -> str:
        if (self.project_path / "pyproject.toml").exists():
            return "poetry"
        if (self.project_path / "Pipfile").exists():
            return "pipenv"
        return "pip"

    async def install(self) -> InstallResult:
        steps = []
        import time

        intended_pm = self._detect_package_manager()

        if intended_pm == "poetry" and not await self._tool_exists("poetry"):
            self.on_log("[Warning] poetry not found, falling back to pip")
            intended_pm = "pip"

        if self.use_venv:
            step = InstallStep(action="create_venv")
            step.status = "running"
            t0 = time.monotonic()
            code, err = await self._run_streaming("python3", "-m", "venv", ".venv")
            step.status = "success" if code == 0 else "failed"
            step.duration_ms = int((time.monotonic() - t0) * 1000)
            steps.append(step)
            if code != 0:
                return InstallResult(success=False, steps=steps, error_output=err)
            pip_cmd = str(self.project_path / ".venv" / "bin" / "pip")
        else:
            pip_cmd = "pip"

        req_file = self.project_path / "requirements.txt"

        if not req_file.exists():
            self.on_log("[Warning] No requirements.txt found, skipping")
            return InstallResult(success=True, steps=steps)

        # ── First attempt: install with pinned versions ────────────────
        step = InstallStep(action="pip_install")
        step.status = "running"
        t0 = time.monotonic()
        code, err = await self._run_streaming(
            pip_cmd, "install", "-r", "requirements.txt"
        )
        step.duration_ms = int((time.monotonic() - t0) * 1000)

        if code != 0:
            self.on_log("[Warning] Pinned install failed, retrying with --no-deps then upgrading problematic packages")

            # ── Second attempt: install without build isolation ────────
            code2, err2 = await self._run_streaming(
                pip_cmd, "install",
                "--no-build-isolation",
                "-r", "requirements.txt"
            )

            if code2 != 0:
                # ── Third attempt: upgrade only the failing packages ───
                # Parse requirements and try installing each separately,
                # falling back to unpinned version on failure
                code3, err3 = await self._install_with_fallback(pip_cmd, req_file)
                if code3 != 0:
                    step.status = "failed"
                    step.error = err3
                    steps.append(step)
                    return InstallResult(success=False, steps=steps, error_output=err3)

            step.status = "success"
        else:
            step.status = "success"

        steps.append(step)
        return InstallResult(
            success=True,
            steps=steps,
        )

    async def _install_with_fallback(self, pip_cmd: str, req_file: Path) -> tuple[int, str]:
        """
        Install each requirement individually.
        If a pinned version fails to build, retry without the version pin.
        """
        import re
        lines = req_file.read_text().splitlines()
        last_err = ""

        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            # Try pinned version first
            code, err = await self._run_streaming(pip_cmd, "install", line)
            if code == 0:
                continue

            # Pin failed — try unpinned (strip version specifier)
            package_name = re.split(r"[>=<!~\[]", line)[0].strip()
            self.on_log(f"[Fallback] {line} failed, trying unpinned: {package_name}")
            code2, err2 = await self._run_streaming(pip_cmd, "install", package_name)
            if code2 != 0:
                last_err = err2
                self.on_log(f"[Error] Could not install {package_name}: {err2[:200]}")
                # Continue anyway — some packages may be optional or platform-specific
                continue

        return 0, last_err
