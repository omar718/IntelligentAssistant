# scripts/seed_test_report.py
import asyncio
import enum
import sys
sys.path.append(".")
from app.db.session import SessionLocal
from app.models.report import StackReport
from app.models.project import Project
from app.services.report_generator import generate_stack_report
from app.services.r2_storage import B2Storage
from datetime import datetime, timezone
from sqlalchemy import select

SAMPLE_PROJECT_ID = "proj_test001"

sample_data = {
    "project_name": "test-project",
    "project_id":   SAMPLE_PROJECT_ID,
    "user_email":   "omar@pfe2026.dz",
    "stack": {
        "type": "Node.js", "framework": "Express",
        "language": "JavaScript", "package_manager": "npm",
        "node_version": "20.11.0", "entry_point": "npm start",
        "port": 3000, "resolution": "local",
    },
    "environment":        {"NODE_ENV": "production", "PORT": "3000"},
    "dependencies":       [{"name": "express", "version": "4.18.2", "status": "installed"}],
    "installation_steps": [{"order": 1, "action": "install_packages", "status": "success", "duration_s": 12}],
    "health_checks":      [{"name": "http", "detail": "HTTP 200 on /", "passed": True}],
    "conflicts_resolved": [],
    "notes": "Seeded for testing.",
}
class ProjectStatus(str, enum.Enum):
    queued     = 'queued'
    analyzing  = 'analyzing'
    installing = 'installing'
    running    = 'running'
    stopped    = 'stopped'
    failed     = 'failed'

async def seed():
    pdf_bytes = generate_stack_report(sample_data)
    print(f"PDF generated: {len(pdf_bytes):,} bytes")

    ts      = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    r2_key  = f"reports/{SAMPLE_PROJECT_ID}/{ts}.pdf"
    storage = B2Storage()
    await storage.upload(r2_key, pdf_bytes)
    print(f"Uploaded to B2: {r2_key}")

    async with SessionLocal() as db:
        # Ensure project exists
        existing = await db.execute(select(Project).where(Project.id == SAMPLE_PROJECT_ID))
        if not existing.scalar_one_or_none():
            project = Project(
                id=SAMPLE_PROJECT_ID,
                name="test-project",
                path="C:/tmp/intelligent-assistant/test-project",
                type="nodejs",
                status=ProjectStatus.stopped,
            )
            db.add(project)
            await db.flush()
            print(f"Project created: {SAMPLE_PROJECT_ID}")

        # Save StackReport row
        report = StackReport(
            project_id=SAMPLE_PROJECT_ID,
            installation_history_id=None,
            r2_key=r2_key,
            created_at=datetime.utcnow(),
        )
        db.add(report)
        await db.commit()
        print(f"StackReport row saved: id={report.id}")


asyncio.run(seed())