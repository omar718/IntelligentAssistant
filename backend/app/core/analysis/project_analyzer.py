from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
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
    install_guide_url: Optional[str] = None
    version_constraints: dict = field(default_factory=dict)
    env_vars: dict = field(default_factory=dict)
    steps: List[dict] = field(default_factory=list)
    services: List[Dict[str, Any]] = field(default_factory=list)

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
    # static is lowest: only wins when nothing else is detected
    PRIORITY = ['static', 'go', 'ruby', 'java', 'php', 'nodejs', 'python']

    def detect_project_type(self, project_path: Path) -> ProjectInfo:
        detected = []

        for filename, (lang, pm) in self.INDICATORS.items():
            if (project_path / filename).exists():
                detected.append(ProjectType(lang, pm, filename))

        # ── Fallback: no indicator files found — scan for source files ──
        if not detected:
            # ── Static HTML/CSS/JS — check FIRST before .js glob ──────
            # A plain HTML project has index.html but no server entry points
            if self._is_static_html_project(project_path):
                detected.append(ProjectType('static', 'none', 'index.html'))

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
        info.services = self._detect_services(project_path)

        if info.services:
            preferred = self._select_primary_service(info.services)
            info.primary_language = preferred.get('project_type')
            info.primary_pm = preferred.get('detected_pm')
            info.entry_point = preferred.get('entry_point')
            info.run_command = preferred.get('run_command')
            info.launch_port = preferred.get('launch_port')
        elif detected:
            info.primary_language = detected[0].language
            info.primary_pm = detected[0].package_manager

        # ── Static: set run_command and launch_port directly ──────────
        if info.primary_language == 'static':
            info.run_command = self._default_run_command('static', 'none', None, project_path)
            info.launch_port = 3000
            info.entry_point = self._detect_static_entry_point(project_path)
            return info

        if info.primary_language and not info.entry_point:
            info.entry_point = self._detect_entry_point(
                project_path, info.primary_language, info.primary_pm
            )

        return info

    def _is_static_html_project(self, project_path: Path) -> bool:
        """
        True when the folder is a plain HTML/CSS/JS project:
          - has index.html or index.htm
          - has NO Node.js server entry points (index.js, server.js, app.js …)
          - has NO backend language entry points (manage.py, app.py, artisan …)
          - has NO package.json (those are handled by the nodejs indicator)
        """
        has_html = any(
            (project_path / f).exists()
            for f in ['index.html', 'index.htm']
        )
        if not has_html:
            return False

        # If package.json exists, the nodejs indicator already handles it
        if (project_path / 'package.json').exists():
            return False

        has_server_entry = any(
            (project_path / candidate).exists()
            for candidate in [
                'index.js', 'server.js', 'app.js', 'main.js',
                'src/index.js', 'src/server.js', 'src/app.js',
            ]
        )
        if has_server_entry:
            return False

        has_backend = any(
            (project_path / f).exists()
            for f in ['manage.py', 'app.py', 'main.py', 'artisan', 'pom.xml']
        )
        if has_backend:
            return False

        return True

    def _detect_static_entry_point(self, project_path: Path) -> Optional[str]:
        """Return the main HTML file for a static project."""
        for candidate in ['index.html', 'index.htm', 'home.html']:
            if (project_path / candidate).exists():
                return candidate
        # Fallback: first .html file found
        html_files = sorted(project_path.glob('*.html'))
        return str(html_files[0].name) if html_files else None

    def _detect_services(self, project_path: Path) -> List[Dict[str, Any]]:
        services: List[Dict[str, Any]] = []
        targets = [project_path]

        for child in project_path.iterdir():
            if not child.is_dir():
                continue
            lowered = child.name.lower()
            if lowered.startswith('.') or lowered in {
                'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__'
            }:
                continue
            targets.append(child)

        for target in targets:
            detected = self._detect_stacks_for_path(target)
            if not detected:
                continue

            for language, pm, marker in detected:
                if language == 'nodejs' and not self._is_runnable_node_service(target):
                    continue

                rel_path = (
                    str(target.relative_to(project_path))
                    if target != project_path
                    else '.'
                )
                role = self._infer_role(target, language)
                entry_point = self._detect_entry_point(target, language, pm)

                services.append({
                    'name': target.name if target != project_path else project_path.name,
                    'path': rel_path,
                    'project_type': language,
                    'detected_pm': pm,
                    'detected_file': marker,
                    'role': role,
                    'entry_point': entry_point,
                    'run_command': self._default_run_command(language, pm, entry_point, target),
                    'launch_port': self._default_launch_port(language, role),
                })

        role_weight = {'frontend': 0, 'backend': 1, 'worker': 2, 'unknown': 3}
        services.sort(
            key=lambda svc: (
                role_weight.get(str(svc.get('role')), 3),
                str(svc.get('path')),
            )
        )
        return services

    def _detect_stacks_for_path(self, target: Path) -> List[tuple[str, Optional[str], str]]:
        out: List[tuple[str, Optional[str], str]] = []
        for filename, (lang, pm) in self.INDICATORS.items():
            if (target / filename).exists():
                out.append((lang, pm, filename))
        return out

    def _is_runnable_node_service(self, target: Path) -> bool:
        pkg_file = target / 'package.json'
        if not pkg_file.exists():
            return False
        
        # ── Check if this looks like a build-tool-only package.json ───────────
        # (e.g., Laravel with Vite, PHP project with Mix, etc.)
        has_php = (target / 'composer.json').exists() or list(target.glob('*.php')) or (target / 'artisan').exists()
        has_python = (target / 'requirements.txt').exists() or (target / 'pyproject.toml').exists() or (target / 'manage.py').exists()
        has_ruby = (target / 'Gemfile').exists()
        has_java = (target / 'pom.xml').exists() or (target / 'build.gradle').exists()
        has_go = (target / 'go.mod').exists()
        
        has_other_backend = has_php or has_python or has_ruby or has_java or has_go
        
        try:
            pkg = json.loads(pkg_file.read_text(encoding='utf-8', errors='ignore'))
        except Exception:
            return False
        
        scripts = pkg.get('scripts') or {}
        if not isinstance(scripts, dict):
            return False
        
        # ── Check if package.json has actual app scripts ─────────────────────
        for script_name in ('start', 'dev', 'serve', 'preview'):
            script = scripts.get(script_name)
            if isinstance(script, str) and script.strip():
                # ── If we have another backend language, this Node.js ──────────
                # is likely just build tools (Vite, Mix, etc.) not the app
                if has_other_backend:
                    # Exception: if script is actually running a Node.js server
                    # (not just building), like "node server.js" or "nodemon"
                    if self._is_node_server_script(script):
                        return True
                    return False
                return True
        
        return False
    
    def _is_node_server_script(self, script: str) -> bool:
        """Check if script is actually running a Node.js server vs just build tools."""
        normalized = script.lower()
        
        # Build tools only
        build_tools = {'vite', 'webpack', 'gulp', 'mix', 'parcel', 'rollup', 'esbuild', 'tsc', 'babel'}
        if any(tool in normalized for tool in build_tools):
            return False
        
        # Actual Node.js servers
        server_indicators = {'node', 'nodemon', 'pm2', 'forever', 'supervisor', 'express', 'ts-node', 'tsx'}
        return any(indicator in normalized for indicator in server_indicators)

    def _infer_role(self, target: Path, language: str) -> str:
        lowered = target.name.lower()
        if lowered in {'frontend', 'client', 'web', 'ui'}:
            return 'frontend'
        if lowered in {'backend', 'server', 'api', 'service'}:
            return 'backend'
        if lowered in {'docs', 'doc', 'documentation', 'test', 'tests', 'example', 'examples'}:
            return 'worker'
        if language == 'static':
            return 'frontend'
        if language == 'nodejs':
            return 'frontend'
        if language in {'python', 'java', 'go', 'ruby', 'php'}:
            return 'backend'
        return 'unknown'

    def _default_run_command(
        self,
        language: str,
        package_manager: Optional[str],
        entry_point: Optional[str],
        project_path: Optional[Path] = None,
    ) -> Optional[str]:

        # ── Static HTML/CSS/JS ─────────────────────────────────────
        if language == 'static':
            # python -m http.server works on Windows, macOS, Linux
            # with no extra packages required
            return 'python -m http.server 3000'

        if language == 'nodejs':
            scripts = self._read_node_scripts(project_path) if project_path else {}
            if scripts.get('start'):
                return 'npm start'
            if scripts.get('dev'):
                return 'npm run dev'
            if scripts.get('serve'):
                return 'npm run serve'
            if scripts.get('preview'):
                return 'npm run preview'

            # package.json exists but no run scripts — check if it's actually static
            if project_path and self._is_static_html_project(project_path):
                return 'python -m http.server 3000'

            if entry_point:
                return f'node {entry_point}'

            if project_path:
                for candidate in [
                    'index.js', 'server.js', 'app.js', 'main.js',
                    'src/index.js', 'src/server.js', 'src/app.js',
                ]:
                    if (project_path / candidate).exists():
                        return f'node {candidate}'

            return None

        if language == 'python':
            if entry_point:
                if entry_point.endswith('manage.py'):
                    return f'python {entry_point} runserver 0.0.0.0:8000'
                return f'python {entry_point}'
            return 'python main.py'

        if language == 'php':
            return 'php -S 127.0.0.1:8000 -t public'

        if language == 'java':
            return 'mvn spring-boot:run' if package_manager == 'maven' else './gradlew bootRun'

        if language == 'ruby':
            return 'bundle exec ruby app.rb'

        if language == 'go':
            return 'go run .'

        return None

    def _read_node_scripts(self, project_path: Optional[Path]) -> Dict[str, str]:
        if project_path is None:
            return {}
        pkg_file = project_path / 'package.json'
        if not pkg_file.exists():
            return {}
        try:
            pkg = json.loads(pkg_file.read_text(encoding='utf-8', errors='ignore'))
            scripts = pkg.get('scripts')
            if isinstance(scripts, dict):
                return {str(k): str(v) for k, v in scripts.items()}
        except Exception:
            return {}
        return {}

    def _select_primary_service(self, services: List[Dict[str, Any]]) -> Dict[str, Any]:
        # ── Prefer backend services first (actual app code) ──────────────────
        # Look for backend services that are not Node.js (which might be just build tools)
        backend_non_node = next(
            (
                svc for svc in services
                if svc.get('role') == 'backend' and svc.get('project_type') != 'nodejs'
            ),
            None,
        )
        if backend_non_node:
            return backend_non_node

        # ── If no other backend, check for backend Node.js ──────────────────
        backend_node = next(
            (svc for svc in services if svc.get('role') == 'backend'), None
        )
        if backend_node:
            return backend_node

        # ── Then check for frontend Node.js (actual app, not just build tools) ──
        frontend_node = next(
            (
                svc for svc in services
                if svc.get('role') == 'frontend' and svc.get('project_type') == 'nodejs'
            ),
            None,
        )
        if frontend_node:
            return frontend_node
        
        # ── Fallback to first service ──────────────────────────────────────
        return services[0]

    def _default_launch_port(self, language: str, role: str) -> Optional[int]:
        if language == 'static':
            return 3000
        if language == 'nodejs':
            return 3000
        if language == 'python':
            return 8000
        if language == 'php':
            return 8000
        if language == 'java':
            return 8080
        if language == 'go':
            return 8080
        if language == 'ruby':
            return 3000 if role == 'frontend' else 3001
        return None

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

        if info.primary_language == 'static':
            return 3000
        if info.primary_language == 'python':
            if 'streamlit' in command:
                return 8501
            if 'flask run' in command:
                return 5000
            if any(k in command for k in ('uvicorn', 'gunicorn', 'django', 'manage.py')):
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

        if language == 'static':
            return self._detect_static_entry_point(project_path)

        if language == 'python':
            candidates = [
                'main.py', 'app.py', 'run.py', 'manage.py',
                'src/main.py', 'src/app.py',
            ]
            for candidate in candidates:
                if (project_path / candidate).exists():
                    return candidate
            return None

        if language == 'nodejs':
            pkg_file = project_path / 'package.json'
            if pkg_file.exists():
                try:
                    pkg = json.loads(pkg_file.read_text(encoding='utf-8', errors='ignore'))
                    main_field = pkg.get('main')
                    if isinstance(main_field, str) and main_field.strip():
                        if (project_path / main_field).exists():
                            return main_field
                    scripts = pkg.get('scripts') or {}
                    start_cmd = scripts.get('start') if isinstance(scripts, dict) else None
                    if isinstance(start_cmd, str):
                        for token in start_cmd.replace('"', ' ').split():
                            if token.lower().endswith(('.js', '.mjs', '.cjs', '.ts', '.tsx')):
                                resolved = token.strip()
                                if (project_path / resolved).exists():
                                    return resolved
                except Exception:
                    pass

            candidates = [
                'index.js', 'server.js', 'app.js', 'main.js',
                'src/index.js', 'src/server.js', 'src/app.js',
                'index.ts', 'server.ts', 'app.ts', 'main.ts',
                'src/index.ts', 'src/server.ts', 'src/app.ts',
            ]
            for candidate in candidates:
                if (project_path / candidate).exists():
                    return candidate
            return None

        return None