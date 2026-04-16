from jinja2 import Environment, FileSystemLoader
from pathlib import Path

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"

class ConfigWriter:

    def render_docker_compose(
        self,
        project_path: Path,
        service_name: str,
        image: str,
        version: str,
        port: int,
        env_vars: dict,
        start_command: str,
    ) -> Path:
        env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)))
        template = env.get_template("docker-compose.yml.j2")
        content = template.render(
            service_name=service_name,
            image=image,
            version=version,
            project_path=str(project_path),
            port=port,
            env_vars=env_vars,
            start_command=start_command,
        )
        output_path = project_path / "docker-compose.generated.yml"
        output_path.write_text(content)
        return output_path