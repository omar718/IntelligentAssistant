import json
import os
from groq import Groq
from pathlib import Path
from dotenv import load_dotenv
from .project_analyzer import ProjectInfo

load_dotenv()

INSTRUCTION_PARSE_PROMPT = """
Analyze the following project setup instructions and extract:
1. Required system dependencies
2. Installation steps in order
3. Environment variables needed
4. Known version requirements

Instructions:
{readme_content}

Return ONLY valid JSON with no extra text:
{{
  "system_dependencies": ["redis", "postgresql"],
  "steps": [
    {{"order": 1, "action": "install_packages", "command": "npm install"}}
  ],
  "env_vars": {{
    "DATABASE_URL": "postgres://localhost/myapp"
  }},
  "version_constraints": {{
    "node": ">=18.0.0"
  }}
}}
"""

class NLPProcessor:
    def __init__(self):
        self.client = Groq(api_key=os.environ["GROQ_API_KEY"])

    def parse_readme(self, project_path: Path) -> dict:
        readme = self._find_readme(project_path)
        if not readme:
            return {}

        prompt = INSTRUCTION_PARSE_PROMPT.format(readme_content=readme)

        response = self.client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}]
        )

        raw = response.choices[0].message.content

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            clean = raw.strip().removeprefix("```json").removesuffix("```").strip()
            return json.loads(clean)

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


    def merge_with_project_info(self, info: ProjectInfo, nlp_result: dict) -> ProjectInfo:
        info.steps = nlp_result.get('steps', [])
        info.env_vars = nlp_result.get('env_vars', {})
        info.version_constraints = nlp_result.get('version_constraints', {})
        return info