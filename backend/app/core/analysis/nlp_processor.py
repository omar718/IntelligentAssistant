import json
import os
import re
from groq import Groq
from pathlib import Path
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

        print(f"[NLPProcessor] README found ({len(readme)} chars), sending to Groq...")
        prompt = INSTRUCTION_PARSE_PROMPT.format(readme_content=readme[:6000])  # cap to avoid token limits

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
            return result
        except json.JSONDecodeError:
            try:
                # Strip any flavour of code fence: ```json, ```JSON, or plain ```
                clean = raw.strip()
                clean = re.sub(r'^```[a-zA-Z]*\n?', '', clean)
                clean = re.sub(r'```$', '', clean).strip()
                result = json.loads(clean)
                print(f"[NLPProcessor] Parsed after strip — steps: {len(result.get('steps', []))}")
                return result
            except json.JSONDecodeError:
                print(f"[NLPProcessor] Failed to parse Groq response as JSON: {raw[:300]}")
                return {}

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

        # ── steps: use NLP steps unless they conflict with the detected PM ──
        nlp_steps = nlp_result.get('steps', [])
        if nlp_steps:
            if info.primary_pm and self._steps_conflict_with_pm(nlp_steps, info.primary_pm):
                # README is describing a different stack — trust the actual project files
                canonical = self._CANONICAL_STEPS.get(info.primary_pm, [])
                print(f"[NLPProcessor] Using canonical steps for '{info.primary_pm}' due to README conflict")
                info.steps = canonical
            else:
                info.steps = nlp_steps

        return info