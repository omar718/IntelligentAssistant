from dataclasses import dataclass, field
from typing import List, Optional
from enum import Enum
import asyncio
import re
import socket
from app.core.analysis.project_analyzer import ProjectInfo


class ConflictType(str, Enum):
    VERSION_MISMATCH = "version_mismatch"
    PORT_CONFLICT    = "port_conflict"
    MISSING_TOOL     = "missing_tool"

class ResolutionStrategy(str, Enum):
    LOCAL        = "local"
    VENV         = "venv"
    NVM          = "nvm"
    DOCKER       = "docker"
    REASSIGN_PORT = "reassign_port"
    INSTALL_TOOL = "install_tool"

@dataclass
class Conflict:
    type:      ConflictType
    component: str
    required:  Optional[str] = None
    actual:    Optional[str] = None
    severity:  str = "medium"
    install_hint: Optional[str] = None
    ask_user: bool = False
    prompt: Optional[str] = None

@dataclass
class ConflictReport:
    conflicts: List[Conflict] = field(default_factory=list)

    @property
    def has_conflicts(self) -> bool:
        return len(self.conflicts) > 0

    @property
    def max_severity(self) -> str:
        if any(c.severity == "high"   for c in self.conflicts): return "high"
        if any(c.severity == "medium" for c in self.conflicts): return "medium"
        return "low"

@dataclass
class ResolutionStep:
    strategy:  ResolutionStrategy
    component: str
    detail:    str
    command:   Optional[str] = None

@dataclass
class ResolutionPlan:
    steps:      List[ResolutionStep] = field(default_factory=list)
    use_docker: bool = False
    final_port: Optional[int] = None


# ── Tool definitions ───────────────────────────────────────────────────────────
# Each entry: constraint_key → (cli_command, version_flag, severity, install_hint)
TOOL_CHECKS = {
    "node":   ("node",        "--version", "high",   "https://nodejs.org"),
    "python": ("python3",     "--version", "medium", "https://python.org"),
    "php":    ("php",         "--version", "high",   "https://php.net"),
    "java":   ("java",        "-version",  "high",   "https://adoptium.net"),
    "ruby":   ("ruby",        "--version", "high",   "https://ruby-lang.org"),
    "go":     ("go",          "version",   "high",   "https://go.dev"),
    "composer": ("composer",  "--version", "medium", "https://getcomposer.org"),
    "mvn":    ("mvn",         "--version", "medium", "https://maven.apache.org"),
    "gradle": ("gradle",      "--version", "medium", "https://gradle.org"),
}

# Version mismatch resolution per component
VERSION_RESOLUTION: dict[str, ResolutionStrategy] = {
    "node":   ResolutionStrategy.NVM,
    "python": ResolutionStrategy.VENV,
    # Everything else → Docker (safest when version matters and no manager exists)
}


class ConflictDetector:

    # ── Subprocess helper ──────────────────────────────────────────────────────

    async def _run(self, *cmd: str) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,   # java -version writes to stderr
            )
            stdout, stderr = await proc.communicate()
            return (stdout or stderr).decode().strip()
        except FileNotFoundError:
            return ""

    async def _get_local_version(self, tool: str, flag: str = "--version") -> Optional[str]:
        output = await self._run(tool, flag)
        if not output:
            return None
        match = re.search(r"\d+(?:\.\d+){0,2}", output)
        return match.group(0) if match else None

    # ── Port helpers ───────────────────────────────────────────────────────────

    def _is_port_in_use(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("localhost", port)) == 0

    def _find_available_port(self, start: int, end: int = 9999) -> int:
        for port in range(start, end):
            if not self._is_port_in_use(port):
                return port
        raise RuntimeError("No available ports in range")

    # ── Version comparison ─────────────────────────────────────────────────────

    def _version_satisfies(self, actual: str, required: str) -> bool:
        req_match = re.search(r"\d+(?:\.\d+){0,2}", required or "")
        req_clean = req_match.group(0) if req_match else ""
        try:
            act_major = int(actual.split(".")[0])
            req_major = int(req_clean.split(".")[0]) if req_clean else 0
            return act_major >= req_major
        except (ValueError, IndexError):
            return True  # can't compare — assume OK

    # ── Main check ─────────────────────────────────────────────────────────────

    async def check(self, project_info) -> ConflictReport:
        report = ConflictReport()
        constraints = getattr(project_info, "version_constraints", None) or {}

        # ── Check every tool that has a version constraint ─────────────────────
        for key, required_version in constraints.items():
            if key not in TOOL_CHECKS:
                continue

            cli, flag, severity, hint = TOOL_CHECKS[key]

            # python fallback: try python3 then python
            if key == "python":
                local = await self._get_local_version("python3", flag)
                if local is None:
                    local = await self._get_local_version("python", flag)
            else:
                local = await self._get_local_version(cli, flag)

            if local is None:
                prompt = (
                    f"{key} runtime is missing on this machine. "
                    f"Install it from {hint} or choose Docker fallback."
                )
                report.conflicts.append(Conflict(
                    type=ConflictType.MISSING_TOOL,
                    component=key,
                    required=required_version,
                    severity=severity,
                    install_hint=hint,
                    ask_user=True,
                    prompt=prompt,
                ))
            elif not self._version_satisfies(local, required_version):
                report.conflicts.append(Conflict(
                    type=ConflictType.VERSION_MISMATCH,
                    component=key,
                    required=required_version,
                    actual=local,
                    severity=severity,
                ))

        # ── Check required tools that have no version constraint ───────────────
        # Derive required tools from project type
        project_type = getattr(project_info, "project_type", None) or \
                       getattr(project_info, "primary_language", None)

        REQUIRED_TOOLS: dict[str, list[str]] = {
            "php":    ["php"],
            "java":   ["java"],
            "ruby":   ["ruby"],
            "go":     ["go"],
            "nodejs": ["node"],
            "python": [],   # python check already handled via constraints
        }

        for tool_name in REQUIRED_TOOLS.get(project_type or "", []):
            # Skip if already checked via constraints
            if tool_name in constraints:
                continue
            cli, flag, severity, hint = TOOL_CHECKS[tool_name]
            local = await self._get_local_version(cli, flag)
            if local is None:
                prompt = (
                    f"{tool_name} runtime is missing on this machine. "
                    f"Install it from {hint} or choose Docker fallback."
                )
                report.conflicts.append(Conflict(
                    type=ConflictType.MISSING_TOOL,
                    component=tool_name,
                    required=f"any ({hint})",
                    severity=severity,
                    install_hint=hint,
                    ask_user=True,
                    prompt=prompt,
                ))

        # ── Check ports ────────────────────────────────────────────────────────
        for port in (getattr(project_info, "ports", None) or []):
            if self._is_port_in_use(port):
                report.conflicts.append(Conflict(
                    type=ConflictType.PORT_CONFLICT,
                    component=f"port_{port}",
                    required=str(port),
                    severity="medium",
                ))

        return report


class ConflictResolver:

    def resolve(self, report: ConflictReport) -> ResolutionPlan:
        plan = ResolutionPlan()

        for conflict in report.conflicts:

            # ── Missing tool ───────────────────────────────────────────────────
            if conflict.type == ConflictType.MISSING_TOOL:
                _, _, _, hint = TOOL_CHECKS.get(conflict.component, ("", "", "", ""))
                plan.steps.append(ResolutionStep(
                    strategy=ResolutionStrategy.INSTALL_TOOL,
                    component=conflict.component,
                    detail=f"{conflict.component} not found — install from {hint}",
                    command=None,   # user must install manually or use Docker
                ))
                # Only use Docker if the missing tool is the runtime itself
                # (not a build tool like composer/maven which can be installed separately)
                runtime_tools = {"node", "python", "php", "java", "ruby", "go"}
                if conflict.component in runtime_tools:
                    plan.use_docker = True

            # ── Version mismatch ───────────────────────────────────────────────
            elif conflict.type == ConflictType.VERSION_MISMATCH:
                strategy = VERSION_RESOLUTION.get(
                    conflict.component,
                    ResolutionStrategy.DOCKER,  # default for php, java, ruby, go
                )

                if strategy == ResolutionStrategy.NVM:
                    plan.steps.append(ResolutionStep(
                        strategy=ResolutionStrategy.NVM,
                        component="node",
                        detail=f"Switch Node to {conflict.required} via nvm",
                        command=f"nvm install {conflict.required} && nvm use {conflict.required}",
                    ))

                elif strategy == ResolutionStrategy.VENV:
                    plan.steps.append(ResolutionStep(
                        strategy=ResolutionStrategy.VENV,
                        component="python",
                        detail="Isolate Python deps in virtualenv",
                        command="python3 -m venv .venv",
                    ))

                else:
                    # PHP, Java, Ruby, Go version mismatch → Docker
                    plan.steps.append(ResolutionStep(
                        strategy=ResolutionStrategy.DOCKER,
                        component=conflict.component,
                        detail=(
                            f"{conflict.component} {conflict.actual} installed, "
                            f"{conflict.required} required — using Docker"
                        ),
                        command=None,
                    ))
                    plan.use_docker = True

            # ── Port conflict ──────────────────────────────────────────────────
            elif conflict.type == ConflictType.PORT_CONFLICT:
                original_port = int(conflict.required)
                detector = ConflictDetector()
                new_port = detector._find_available_port(original_port + 1)
                plan.final_port = new_port
                plan.steps.append(ResolutionStep(
                    strategy=ResolutionStrategy.REASSIGN_PORT,
                    component=conflict.component,
                    detail=f"Port {original_port} busy — reassigned to {new_port}",
                ))

        return plan