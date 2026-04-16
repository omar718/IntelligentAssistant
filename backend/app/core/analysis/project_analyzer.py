from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Optional
import json
import re

@dataclass
class ProjectType:
    language: str
    package_manager: str
    detected_file: str

@dataclass
class ProjectInfo:
    types: List[ProjectType]
    path: Path
    primary_language: Optional[str] = None
    primary_pm: Optional[str] = None
    entry_point: Optional[str] = None
    run_command: Optional[str] = None
    launch_port: Optional[int] = None
    version_constraints: dict = field(default_factory=dict)
    env_vars: dict = field(default_factory=dict)
    steps: List[dict] = field(default_factory=list)

class ProjectAnalyzer:
    INDICATORS = {
        'package.json':     ('nodejs',  'npm'),
        'requirements.txt': ('python',  'pip'),
        'pyproject.toml':   ('python',  'poetry'),
        'composer.json':    ('php',     'composer'),
        'pom.xml':          ('java',    'maven'),
        'build.gradle':     ('java',    'gradle'),
        'Gemfile':          ('ruby',    'bundler'),
        'go.mod':           ('go',      'go modules'),
    }
    # Priority order — higher index = higher priority
    PRIORITY = ['go', 'ruby', 'java', 'php', 'python', 'nodejs']
    def detect_project_type(self, project_path: Path) -> ProjectInfo:
        detected = []

        for filename, (lang, pm) in self.INDICATORS.items():
            if (project_path / filename).exists():
                detected.append(ProjectType(lang, pm, filename))

        # ── Fallback: no indicator files found — scan for source files ──
        if not detected:
            php_files = list(project_path.glob('*.php'))
            if php_files:
                detected.append(ProjectType('php', None, '*.php'))

            py_files = list(project_path.glob('*.py'))
            if py_files:
                detected.append(ProjectType('python', 'pip', '*.py'))

            rb_files = list(project_path.glob('*.rb'))
            if rb_files:
                detected.append(ProjectType('ruby', None, '*.rb'))

            go_files = list(project_path.glob('*.go'))
            if go_files:
                detected.append(ProjectType('go', 'go modules', '*.go'))

        detected.sort(
            key=lambda t: self.PRIORITY.index(t.language)
            if t.language in self.PRIORITY else -1,
            reverse=True,
        )

        info = ProjectInfo(types=detected, path=project_path)
        if detected:
            info.primary_language = detected[0].language
            info.primary_pm = detected[0].package_manager

        return info

    def _extract_run_command(self, steps: list) -> Optional[str]:
        for step in steps:
            if not isinstance(step, dict):
                continue
            if step.get('action') == 'run':
                command = step.get('command')
                if isinstance(command, str) and command.strip():
                    return command.strip()
        return None

    def _infer_launch_port(self, info: ProjectInfo) -> Optional[int]:
        command = (info.run_command or '').strip().lower()
        env_port = info.env_vars.get('PORT')
        if isinstance(env_port, str) and env_port.isdigit():
            return int(env_port)
        if isinstance(env_port, int):
            return env_port

        match = re.search(r'(?:--port(?:=|\s+)|-p(?:=|\s+)|port=)(\d{2,5})', command)
        if match:
            return int(match.group(1))

        if info.primary_language == 'python':
            if 'streamlit' in command:
                return 8501
            if 'flask run' in command:
                return 5000
            if 'uvicorn' in command or 'gunicorn' in command or 'django' in command or 'manage.py' in command:
                return 8000
            return 8000

        if info.primary_language == 'nodejs':
            return 3000

        if info.primary_language == 'php':
            return 8000

        return None

    def _detect_entry_point(
        self,
        project_path: Path,
        language: Optional[str],
        package_manager: Optional[str],
    ) -> Optional[str]:
        if not language:
            return None

        if language == "python":
            candidates = [
                "main.py",
                "app.py",
                "run.py",
                "manage.py",
                "src/main.py",
                "src/app.py",
            ]
            for candidate in candidates:
                if (project_path / candidate).exists():
                    return candidate
            return None

        if language == "nodejs":
            pkg_file = project_path / "package.json"
            if pkg_file.exists():
                try:
                    pkg = json.loads(pkg_file.read_text(encoding="utf-8", errors="ignore"))
                    main_field = pkg.get("main")
                    if isinstance(main_field, str) and main_field.strip():
                        if (project_path / main_field).exists():
                            return main_field

                    scripts = pkg.get("scripts") or {}
                    start_cmd = scripts.get("start") if isinstance(scripts, dict) else None
                    if isinstance(start_cmd, str):
                        for token in start_cmd.replace('"', " ").split():
                            lowered = token.lower()
                            if lowered.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx")):
                                resolved = token.strip()
                                if (project_path / resolved).exists():
                                    return resolved
                except Exception:
                    pass

            candidates = [
                "index.js",
                "server.js",
                "app.js",
                "main.js",
                "src/index.js",
                "src/server.js",
                "src/app.js",
                "index.ts",
                "server.ts",
                "app.ts",
                "main.ts",
                "src/index.ts",
                "src/server.ts",
                "src/app.ts",
            ]
            for candidate in candidates:
                if (project_path / candidate).exists():
                    return candidate
            return None

        return None