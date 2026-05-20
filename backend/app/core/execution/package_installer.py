"""
Installers for every supported project type.
All subprocess calls use asyncio.create_subprocess_exec — never subprocess.run.

Supported:
  - NodeJsInstaller   (npm / yarn / pnpm)
  - PythonInstaller   (pip / poetry / pipenv)
  - PHPInstaller      (composer)
  - JavaInstaller     (maven / gradle)
  - RubyInstaller     (bundler)
  - GoInstaller       (go modules)

Factory:
  get_installer(project_type, project_path, **kwargs) -> BaseInstaller
"""
import asyncio
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional


# ── Shared data classes ──────────────────────────────────────────────────────

@dataclass
class InstallStep:
    action: str
    status: str = "pending"        # pending | running | success | failed
    duration_ms: Optional[int] = None
    error: Optional[str] = None


@dataclass
class InstallResult:
    success: bool
    steps: List[InstallStep] = field(default_factory=list)
    error_output: Optional[str] = None


# ── Base class ────────────────────────────────────────────────────────────────

class BaseInstaller:

    def __init__(
        self,
        project_path: Path,
        on_log: Optional[Callable[[str], None]] = None,
    ):
        self.project_path = Path(project_path)
        self.on_log = on_log or (lambda line: None)

    async def _run_streaming(
        self,
        *cmd: str,
        cwd: Optional[Path] = None,
    ) -> tuple[int, str]:
        """
        Run a command, stream stdout to on_log, capture stderr.
        NEVER use subprocess.run — always asyncio.create_subprocess_exec.
        """
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd or self.project_path),
        )

        stderr_lines: List[str] = []

        async def _read_stdout():
            async for line in proc.stdout:
                self.on_log(line.decode().rstrip())

        async def _read_stderr():
            async for line in proc.stderr:
                stderr_lines.append(line.decode().rstrip())

        await asyncio.gather(_read_stdout(), _read_stderr())
        await proc.wait()
        return proc.returncode, "\n".join(stderr_lines)

    async def _tool_exists(self, tool: str) -> bool:
        """Return True if `tool --version` exits with code 0."""
        try:
            proc = await asyncio.create_subprocess_exec(
                tool, "--version",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            return proc.returncode == 0
        except FileNotFoundError:
            return False

    def _step(self, action: str) -> InstallStep:
        s = InstallStep(action=action, status="running")
        return s

    async def _run_step(
        self,
        action: str,
        *cmd: str,
        cwd: Optional[Path] = None,
    ) -> tuple[InstallStep, str]:
        """Run a single labelled step, return (step, stderr)."""
        step = self._step(action)
        t0 = time.monotonic()
        code, err = await self._run_streaming(*cmd, cwd=cwd)
        step.duration_ms = int((time.monotonic() - t0) * 1000)
        step.status = "success" if code == 0 else "failed"
        step.error = err if code != 0 else None
        return step, err

    async def install(self) -> InstallResult:
        raise NotImplementedError


# ── Node.js ───────────────────────────────────────────────────────────────────

class NodeJsInstaller(BaseInstaller):

    def __init__(
        self,
        project_path: Path,
        node_version: Optional[str] = None,
        **kwargs,
    ):
        super().__init__(project_path, **kwargs)
        self.node_version = node_version

    def _detect_package_manager(self) -> str:
        if (self.project_path / "pnpm-lock.yaml").exists():
            return "pnpm"
        if (self.project_path / "yarn.lock").exists():
            return "yarn"
        return "npm"

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []

        # 1. Switch Node version via nvm if needed
        if self.node_version:
            step, err = await self._run_step(
                "nvm_install", "nvm", "install", self.node_version
            )
            steps.append(step)
            if step.status == "failed":
                return InstallResult(success=False, steps=steps, error_output=err)
            await self._run_streaming("nvm", "use", self.node_version)

        # 2. Install dependencies
        pm = self._detect_package_manager()
        step, err = await self._run_step(f"{pm}_install", pm, "install")
        steps.append(step)

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if step.status == "failed" else None,
        )


# ── Python ────────────────────────────────────────────────────────────────────

class PythonInstaller(BaseInstaller):

    def __init__(
        self,
        project_path: Path,
        use_venv: bool = False,
        **kwargs,
    ):
        super().__init__(project_path, **kwargs)
        self.use_venv = use_venv

    def _detect_package_manager(self) -> str:
        if (self.project_path / "pyproject.toml").exists():
            return "poetry"
        if (self.project_path / "Pipfile").exists():
            return "pipenv"
        return "pip"

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []
        pm = self._detect_package_manager()

        # Poetry / pipenv fallback to pip if tool missing
        if pm == "poetry" and not await self._tool_exists("poetry"):
            self.on_log("[Warning] poetry not found, falling back to pip")
            pm = "pip"
        if pm == "pipenv" and not await self._tool_exists("pipenv"):
            self.on_log("[Warning] pipenv not found, falling back to pip")
            pm = "pip"

        # 1. Create venv if requested
        pip_cmd = "pip"
        if self.use_venv:
            step, err = await self._run_step(
                "create_venv", "python3", "-m", "venv", ".venv"
            )
            steps.append(step)
            if step.status == "failed":
                return InstallResult(success=False, steps=steps, error_output=err)
            pip_cmd = str(self.project_path / ".venv" / "bin" / "pip")

        # 2. Install
        if pm == "poetry":
            step, err = await self._run_step("poetry_install", "poetry", "install")
            steps.append(step)

        elif pm == "pipenv":
            step, err = await self._run_step("pipenv_install", "pipenv", "install")
            steps.append(step)

        else:
            req_file = self.project_path / "requirements.txt"
            if not req_file.exists():
                self.on_log("[Warning] No requirements.txt found, skipping")
                return InstallResult(success=True, steps=steps)

            step, err = await self._run_step(
                "pip_install", pip_cmd, "install", "-r", "requirements.txt"
            )

            # Retry with --no-build-isolation on failure
            if step.status == "failed":
                self.on_log("[Retry] Trying --no-build-isolation")
                step2, err2 = await self._run_step(
                    "pip_install_no_isolation",
                    pip_cmd, "install", "--no-build-isolation",
                    "-r", "requirements.txt",
                )
                steps.append(step)
                steps.append(step2)
                if step2.status == "failed":
                    code, err3 = await self._install_with_fallback(pip_cmd, req_file)
                    step3 = InstallStep(
                        action="pip_install_fallback",
                        status="success" if code == 0 else "failed",
                        error=err3 if code != 0 else None,
                    )
                    steps.append(step3)
                    return InstallResult(
                        success=code == 0,
                        steps=steps,
                        error_output=err3 if code != 0 else None,
                    )
                return InstallResult(success=True, steps=steps)
            else:
                steps.append(step)

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if steps and steps[-1].status == "failed" else None,
        )

    async def _install_with_fallback(self, pip_cmd: str, req_file: Path) -> tuple[int, str]:
        lines = req_file.read_text().splitlines()
        last_err = ""
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            code, err = await self._run_streaming(pip_cmd, "install", line)
            if code == 0:
                continue
            package_name = re.split(r"[>=<!~\[]", line)[0].strip()
            self.on_log(f"[Fallback] {line} failed, trying unpinned: {package_name}")
            code2, err2 = await self._run_streaming(pip_cmd, "install", package_name)
            if code2 != 0:
                last_err = err2
                self.on_log(f"[Error] Could not install {package_name}: {err2[:200]}")
        return 0, last_err


# ── PHP / Composer ────────────────────────────────────────────────────────────

class PHPInstaller(BaseInstaller):
    """
    Requires: composer (https://getcomposer.org)
    Detected by: composer.json
    """

    def _build_failure_guidance(self, error_output: str) -> str:
        raw = error_output or ""
        output = raw.lower()

        if (
            "your php version" in output
            and "does not satisfy that requirement" in output
        ):
            return (
                "Composer failed because dependencies require a newer PHP runtime. "
                "Upgrade PHP (commonly to 8.1+), then rerun composer install."
            )

        if "failed opening required" in output and "vendor/autoload.php" in output:
            return (
                "vendor/autoload.php is missing, so dependencies are not installed. "
                "Run composer install from the project root, then relaunch."
            )

        if "your requirements could not be resolved" in output:
            return (
                "Composer could not resolve dependency constraints. "
                "Fix the first reported package/version conflict, then retry composer install."
            )

        return (
            "Composer install failed. Inspect the first Composer error in logs, "
            "apply the fix, then retry."
        )

    def _attach_failure_guidance(self, error_output: str) -> str:
        guidance = self._build_failure_guidance(error_output)
        self.on_log(f"[Guidance] {guidance}")
        return f"{error_output}\n\nSuggested fix: {guidance}" if error_output else guidance

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []

        if not (self.project_path / "composer.json").exists():
            return InstallResult(
                success=False,
                steps=steps,
                error_output="composer.json not found",
            )

        if not await self._tool_exists("composer"):
            return InstallResult(
                success=False,
                steps=steps,
                error_output=(
                    "composer is not installed or not on PATH. "
                    "Install Composer from https://getcomposer.org and retry."
                ),
            )

        # 1. Validate composer.json first (fast, catches obvious errors)
        step, err = await self._run_step("composer_validate", "composer", "validate")
        steps.append(step)
        if step.status == "failed":
            self.on_log("[Warning] composer validate failed — attempting install anyway")

        # 2. Install dependencies
        step, err = await self._run_step(
            "composer_install",
            "composer", "install",
            "--no-interaction",
            "--prefer-dist",
            "--optimize-autoloader",
        )
        steps.append(step)

        # 3. If install failed, retry without scripts (safer)
        if step.status == "failed":
            self.on_log("[Retry] Trying composer install --no-scripts")
            step2, err2 = await self._run_step(
                "composer_install_no_scripts",
                "composer", "install",
                "--no-interaction",
                "--no-scripts",
                "--prefer-dist",
            )
            steps.append(step2)
            err = err2

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=(
                self._attach_failure_guidance(err)
                if steps[-1].status == "failed"
                else None
            ),
        )


# ── Java ──────────────────────────────────────────────────────────────────────

class JavaInstaller(BaseInstaller):
    """
    Supports Maven (pom.xml) and Gradle (build.gradle / build.gradle.kts).
    Requires: mvn or gradle on PATH.
    """

    def _detect_build_tool(self) -> str:
        if (self.project_path / "pom.xml").exists():
            return "maven"
        if (
            (self.project_path / "build.gradle").exists()
            or (self.project_path / "build.gradle.kts").exists()
        ):
            return "gradle"
        return "maven"  # default

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []
        tool = self._detect_build_tool()

        if tool == "maven":
            # Use mvnw wrapper if available (respects project's pinned Maven version)
            mvn_cmd = "./mvnw" if (self.project_path / "mvnw").exists() else "mvn"
            step, err = await self._run_step(
                "mvn_install",
                mvn_cmd,
                "install",
                "-DskipTests",          # skip tests during setup
                "--batch-mode",         # non-interactive
                "--no-transfer-progress",
            )
            steps.append(step)

        else:  # gradle
            gradle_cmd = (
                "./gradlew"
                if (self.project_path / "gradlew").exists()
                else "gradle"
            )
            # Make wrapper executable on Unix
            wrapper = self.project_path / "gradlew"
            if wrapper.exists():
                wrapper.chmod(wrapper.stat().st_mode | 0o111)

            step, err = await self._run_step(
                "gradle_build",
                gradle_cmd,
                "build",
                "-x", "test",           # skip tests
                "--no-daemon",          # avoid background daemon issues in CI
            )
            steps.append(step)

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if steps[-1].status == "failed" else None,
        )


# ── Ruby ──────────────────────────────────────────────────────────────────────

class RubyInstaller(BaseInstaller):
    """
    Requires: bundler (`gem install bundler`).
    Detected by: Gemfile.
    """

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []

        if not (self.project_path / "Gemfile").exists():
            return InstallResult(
                success=False,
                steps=steps,
                error_output="Gemfile not found",
            )

        # 1. Ensure bundler is installed
        if not await self._tool_exists("bundle"):
            self.on_log("[Setup] bundler not found — installing via gem")
            step, err = await self._run_step(
                "gem_install_bundler", "gem", "install", "bundler"
            )
            steps.append(step)
            if step.status == "failed":
                return InstallResult(success=False, steps=steps, error_output=err)

        # 2. bundle install
        step, err = await self._run_step(
            "bundle_install",
            "bundle", "install",
            "--jobs=4",            # parallel installs
            "--retry=3",           # auto-retry network failures
        )
        steps.append(step)

        # 3. Retry without deployment flag if locked Gemfile.lock causes issues
        if step.status == "failed" and "Gemfile.lock" in err:
            self.on_log("[Retry] Updating Gemfile.lock and retrying")
            await self._run_streaming("bundle", "update")
            step2, err2 = await self._run_step("bundle_install_retry", "bundle", "install")
            steps.append(step2)
            err = err2

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if steps[-1].status == "failed" else None,
        )


# ── Go ────────────────────────────────────────────────────────────────────────

class GoInstaller(BaseInstaller):
    """
    Requires: go (https://go.dev).
    Detected by: go.mod.
    """

    async def install(self) -> InstallResult:
        steps: List[InstallStep] = []

        if not (self.project_path / "go.mod").exists():
            return InstallResult(
                success=False,
                steps=steps,
                error_output="go.mod not found",
            )

        # 1. Download all dependencies into module cache
        step, err = await self._run_step("go_mod_download", "go", "mod", "download")
        steps.append(step)
        if step.status == "failed":
            return InstallResult(success=False, steps=steps, error_output=err)

        # 2. Verify module integrity
        step, err = await self._run_step("go_mod_verify", "go", "mod", "verify")
        steps.append(step)
        if step.status == "failed":
            self.on_log("[Warning] go mod verify failed — dependency checksums may be stale")

        # 3. Build to confirm everything compiles
        step, err = await self._run_step("go_build", "go", "build", "./...")
        steps.append(step)

        return InstallResult(
            success=all(s.status == "success" for s in steps),
            steps=steps,
            error_output=err if steps[-1].status == "failed" else None,
        )


# ── Factory ───────────────────────────────────────────────────────────────────

_INSTALLER_MAP: dict[str, type[BaseInstaller]] = {
    "nodejs": NodeJsInstaller,
    "node":   NodeJsInstaller,
    "python": PythonInstaller,
    "php":    PHPInstaller,
    "java":   JavaInstaller,
    "ruby":   RubyInstaller,
    "go":     GoInstaller,
}


def get_installer(
    project_type: str,
    project_path: Path,
    **kwargs,
) -> BaseInstaller:
    """
    Factory — returns the right installer for the given project_type.

    Usage in install.py:
        from app.core.execution.package_installer import get_installer
        installer = get_installer(project_type, project_path, on_log=log_callback)
        result = await installer.install()
    """
    cls = _INSTALLER_MAP.get((project_type or "").lower())
    if cls is None:
        raise ValueError(
            f"Unsupported project type: '{project_type}'. "
            f"Supported: {sorted(_INSTALLER_MAP.keys())}"
        )
    return cls(project_path=project_path, **kwargs)