import json
import os
import re
import html
from groq import Groq
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from dotenv import load_dotenv
from .project_analyzer import ProjectInfo

load_dotenv()

INSTRUCTION_PARSE_PROMPT = """
You are a developer onboarding assistant. Analyze the project setup instructions below and extract structured setup information.

Even if the README does not explicitly list all steps, INFER the standard setup steps based on:
- The package manager mentioned (npm, pip, poetry, composer, maven, etc.)
- The language or framework detected
- Common conventions for that ecosystem

Instructions:
{readme_content}

Rules:
- ALWAYS produce at least the basic install/run steps for the detected stack
- For Python/poetry: include python install, poetry install, and run steps
- For Python/pip: include python install, pip install -r requirements.txt, and run
- For Node/npm: include node install, npm install, npm start
- For PHP/composer: include php install, composer install
- Extract any version constraints mentioned (e.g. "requires Python 3.8+")
- Extract any environment variables mentioned

Return ONLY valid JSON with no extra text:
{{
  "system_dependencies": ["redis", "postgresql"],
  "steps": [
    {{"order": 1, "action": "install_python", "command": "Install Python 3.x"}},
    {{"order": 2, "action": "install_deps", "command": "poetry install"}},
    {{"order": 3, "action": "run", "command": "poetry run python app.py"}}
  ],
  "env_vars": {{
    "DATABASE_URL": "postgres://localhost/myapp"
  }},
  "version_constraints": {{
    "python": ">=3.8.0"
  }}
}}
"""

class NLPProcessor:
    def __init__(self):
        self.client = Groq(api_key=os.environ["GROQ_API_KEY"])

    def parse_readme(self, project_path: Path) -> dict:
        readme = self._find_readme(project_path)
        if not readme:
            print(f"[NLPProcessor] No README found in {project_path}")
            return {}

        install_guide_url = self._extract_install_guide_url(readme)
        web_instructions = ""
        if install_guide_url:
            web_instructions = self._fetch_install_guide_text(install_guide_url)

        combined_instructions = self._combine_instruction_sources(readme, web_instructions)
        print(f"[NLPProcessor] README found ({len(readme)} chars), sending to Groq...")
        prompt = INSTRUCTION_PARSE_PROMPT.format(readme_content=combined_instructions[:10000])

        try:
            response = self.client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
        except Exception as e:
            print(f"[NLPProcessor] Groq API call failed: {e}")
            return {}

        raw = response.choices[0].message.content
        print(f"[NLPProcessor] Groq raw response: {raw[:300]}")

        try:
            result = json.loads(raw)
            print(f"[NLPProcessor] Parsed OK — steps: {len(result.get('steps', []))}")
            if install_guide_url:
                result.setdefault('install_guide_url', install_guide_url)
            return result
        except json.JSONDecodeError:
            try:
                # Strip any flavour of code fence: ```json, ```JSON, or plain ```
                clean = raw.strip()
                clean = re.sub(r'^```[a-zA-Z]*\n?', '', clean)
                clean = re.sub(r'```$', '', clean).strip()
                result = json.loads(clean)
                print(f"[NLPProcessor] Parsed after strip — steps: {len(result.get('steps', []))}")
                if install_guide_url:
                    result.setdefault('install_guide_url', install_guide_url)
                return result
            except json.JSONDecodeError:
                print(f"[NLPProcessor] Failed to parse Groq response as JSON: {raw[:300]}")
                return {'install_guide_url': install_guide_url} if install_guide_url else {}

    def _find_readme(self, project_path: Path) -> str:
        candidates = [
            'README.md', 'README.txt', 'README.rst',
            'INSTALL.md', 'INSTALL.txt',
            'SETUP.md', 'SETUP.txt',
            'GETTING_STARTED.md',
            'steps.txt', 'steps.md',
            'instructions.txt', 'instructions.md',
            'readme.md', 'readme.txt',
    ]
        #check for exact names first
        for name in candidates:
            f = project_path / name
            if f.exists():
                return f.read_text(encoding='utf-8', errors='ignore')
        #scan all .txt/.md files if no exact match
        for ext in ['*.md', '*.txt', '*.rst']:
            matches = list(project_path.glob(ext))
            if matches:
                return matches[0].read_text(encoding='utf-8', errors='ignore')

        return ""

    def _extract_install_guide_url(self, readme: str) -> Optional[str]:
        if not readme:
            return None

        patterns = [
            r'\[([^\]]*install[^\]]*)\]\((https?://[^)\s]+)\)',
            r'\[([^\]]*documentation[^\]]*)\]\((https?://[^)\s]+)\)',
            r'(?im)^\s*(?:installation guide|install guide|docs?)\s*[:\-]\s*(https?://\S+)',
            r'(https?://\S+)',
        ]

        for pattern in patterns:
            match = re.search(pattern, readme)
            if not match:
                continue

            if match.lastindex and match.lastindex >= 2:
                return match.group(2).rstrip(').,]"\'')

            return match.group(1 if match.lastindex else 0).rstrip(').,]"\'')

        return None

    def _combine_instruction_sources(self, readme: str, web_instructions: str) -> str:
        if not web_instructions:
            return readme

        return (
            f"README instructions:\n{readme}\n\n"
            "Installation guide content fetched from the URL referenced in README:\n"
            f"{web_instructions}"
        )

    def _fetch_install_guide_text(self, url: str) -> str:
        if not isinstance(url, str) or not url.strip():
            return ""

        safe_url = url.strip()
        if not re.match(r"^https?://", safe_url, flags=re.IGNORECASE):
            return ""

        request = Request(
            safe_url,
            headers={
                "User-Agent": "ProjectAssistantBot/1.0 (+https://local.dev)",
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            },
        )

        try:
            with urlopen(request, timeout=8) as response:
                content_type = response.headers.get("Content-Type", "")
                payload = response.read(350000)
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            print(f"[NLPProcessor] Failed to fetch install guide URL '{safe_url}': {exc}")
            return ""
        except Exception as exc:
            print(f"[NLPProcessor] Unexpected install guide fetch error for '{safe_url}': {exc}")
            return ""

        text = payload.decode("utf-8", errors="ignore")
        if "text/html" in content_type.lower() or "<html" in text.lower():
            return self._html_to_text(text)
        return text[:6000]

    def _html_to_text(self, html_doc: str) -> str:
        if not html_doc:
            return ""

        text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html_doc)
        text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
        text = re.sub(r"(?is)<noscript[^>]*>.*?</noscript>", " ", text)

        text = re.sub(r"(?i)</(h[1-6]|p|li|pre|code|br|tr|td|th|section|article|div)>", "\n", text)
        text = re.sub(r"(?is)<[^>]+>", " ", text)
        text = html.unescape(text)
        text = re.sub(r"\r", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"[ \t]{2,}", " ", text)

        lines = []
        for line in text.splitlines():
            stripped = line.strip()
            if stripped:
                lines.append(stripped)

        return "\n".join(lines)[:6000]


    # ── Canonical fallback steps per package manager ──────────────────────────
    _CANONICAL_STEPS = {
        'poetry':     [{'order': 1, 'action': 'install_python', 'command': 'Install Python 3.x'},
                       {'order': 2, 'action': 'install_deps',   'command': 'poetry install'},
                       {'order': 3, 'action': 'run',            'command': 'poetry run python main.py'}],
        'pip':        [{'order': 1, 'action': 'install_python', 'command': 'Install Python 3.x'},
                       {'order': 2, 'action': 'install_deps',   'command': 'pip install -r requirements.txt'},
                       {'order': 3, 'action': 'run',            'command': 'python main.py'}],
        'npm':        [{'order': 1, 'action': 'install_node',   'command': 'Install Node.js'},
                       {'order': 2, 'action': 'install_deps',   'command': 'npm install'},
                       {'order': 3, 'action': 'run',            'command': 'npm start'}],
        'composer':   [{'order': 1, 'action': 'install_php',    'command': 'Install PHP'},
                       {'order': 2, 'action': 'install_deps',   'command': 'composer install'}],
        'maven':      [{'order': 1, 'action': 'install_java',   'command': 'Install Java JDK'},
                       {'order': 2, 'action': 'build',          'command': 'mvn package'},
                       {'order': 3, 'action': 'run',            'command': 'java -jar target/*.jar'}],
        'gradle':     [{'order': 1, 'action': 'install_java',   'command': 'Install Java JDK'},
                       {'order': 2, 'action': 'build',          'command': './gradlew build'},
                       {'order': 3, 'action': 'run',            'command': './gradlew run'}],
        'bundler':    [{'order': 1, 'action': 'install_ruby',   'command': 'Install Ruby'},
                       {'order': 2, 'action': 'install_deps',   'command': 'bundle install'}],
        'go modules': [{'order': 1, 'action': 'install_go',     'command': 'Install Go'},
                       {'order': 2, 'action': 'install_deps',   'command': 'go mod download'},
                       {'order': 3, 'action': 'run',            'command': 'go run .'}],
    }

    # Keywords that identify which ecosystem a command belongs to
    _PM_KEYWORDS = {
        'poetry':     ['poetry'],
        'pip':        ['pip', 'pip3'],
        'npm':        ['npm', 'npx', 'yarn'],
        'composer':   ['composer'],
        'maven':      ['mvn'],
        'gradle':     ['gradle', 'gradlew'],
        'bundler':    ['bundle', 'gem'],
        'go modules': [' go ', 'go mod', 'go run', 'go build'],
    }

    def _steps_conflict_with_pm(self, steps: list, detected_pm: str) -> bool:
        """Return True if NLP steps reference a different ecosystem than what static analysis detected."""
        all_commands = ' ' + ' '.join(s.get('command', '') for s in steps).lower() + ' '
        correct_keywords = self._PM_KEYWORDS.get(detected_pm, [])
        # If steps already use the correct PM, no conflict
        if any(kw in all_commands for kw in correct_keywords):
            return False
        # If steps use keywords from a *different* ecosystem, that's a conflict
        for pm, keywords in self._PM_KEYWORDS.items():
            if pm != detected_pm and any(kw in all_commands for kw in keywords):
                print(f"[NLPProcessor] Conflict: README suggests '{pm}' steps but static analysis detected '{detected_pm}'")
                return True
        return False

    def merge_with_project_info(self, info: ProjectInfo, nlp_result: dict) -> ProjectInfo:
        # ── env_vars: NLP always wins (static analysis cannot detect these) ──
        env_vars = nlp_result.get('env_vars', {})
        if env_vars:
            info.env_vars = env_vars

        # ── version_constraints: merge, static-analysis values win on collision ──
        nlp_constraints = nlp_result.get('version_constraints', {})
        if nlp_constraints:
            info.version_constraints = {**nlp_constraints, **info.version_constraints}

        install_guide_url = nlp_result.get('install_guide_url')
        if isinstance(install_guide_url, str) and install_guide_url.strip():
            info.install_guide_url = install_guide_url.strip()

        # ── steps: use NLP steps unless they conflict with the detected PM ──
        nlp_steps = nlp_result.get('steps', [])
        if nlp_steps:
            if info.primary_pm and self._steps_conflict_with_pm(nlp_steps, info.primary_pm):
                # README is describing a different stack — trust the actual project files
                canonical = self._CANONICAL_STEPS.get(info.primary_pm, [])
                print(f"[NLPProcessor] Using canonical steps for '{info.primary_pm}' due to README conflict")
                info.steps = self._inject_entry_point(canonical, info)
            else:
                info.steps = self._inject_entry_point(nlp_steps, info)
        elif info.primary_pm:
            # README may be missing or ambiguous; fall back to canonical steps.
            canonical = self._CANONICAL_STEPS.get(info.primary_pm, [])
            info.steps = self._inject_entry_point(canonical, info)

        info.run_command = self._extract_run_command(info.steps)
        info.launch_port = self._infer_launch_port(info)

        return info

    def _inject_entry_point(self, steps: list, info: ProjectInfo) -> list:
        if not steps:
            return steps

        if info.primary_language != 'python' or not info.entry_point:
            return steps

        patched_steps = []
        for step in steps:
            command = step.get('command', '')
            if not isinstance(command, str):
                patched_steps.append(step)
                continue

            if 'python main.py' in command:
                command = command.replace('python main.py', f'python {info.entry_point}')
            if 'python app.py' in command:
                command = command.replace('python app.py', f'python {info.entry_point}')

            patched_steps.append({**step, 'command': command})

        return patched_steps

    def _extract_run_command(self, steps: list) -> Optional[str]:
        for step in steps:
            if not isinstance(step, dict):
                continue
            if step.get('action') == 'run':
                command = step.get('command')
                if isinstance(command, str) and command.strip():
                    return command.strip()
        return None

    def _infer_launch_port(self, info: ProjectInfo) -> int | None:
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