from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Optional

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

    def detect_project_type(self, project_path: Path) -> ProjectInfo:
        detected = []
        for filename, (lang, pm) in self.INDICATORS.items():
            if (project_path / filename).exists():
                detected.append(ProjectType(lang, pm, filename))

        info = ProjectInfo(types=detected, path=project_path)
        if detected:
            info.primary_language = detected[0].language
            info.primary_pm = detected[0].package_manager

        return info