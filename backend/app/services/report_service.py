import logging
from datetime import datetime, timezone
 
from fastapi import HTTPException, status
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
 
from app.models.report import StackReport
from app.models.project import Project
from app.models.user import User
 
logger = logging.getLogger(__name__)
 
 
class ReportService:
    def __init__(self, db: AsyncSession):
        self.db = db
 
    async def assert_project_access(self, project_id: str, user: User):
        """Raise 403 if the user does not own (or admin) the project."""
        result = await self.db.execute(
            select(Project).where(Project.id == project_id)
        )
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        if project.user_id != user.id and user.role != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="You do not have access to this project")

    async def save(
        self,
        project_id: str,
        r2_key: str,
        installation_history_id: int | None = None,
    ) -> StackReport:
        report = StackReport(
            project_id=project_id,
            installation_history_id=installation_history_id,
            r2_key=r2_key,
            created_at=datetime.utcnow(),
        )
        self.db.add(report)
        await self.db.commit()
        await self.db.refresh(report)
        logger.info("StackReport saved: id=%d project=%s key=%s",
                    report.id, project_id, r2_key)
        return report
 
    async def get_latest(self, project_id: str) -> StackReport | None:
        result = await self.db.execute(
            select(StackReport)
            .where(StackReport.project_id == project_id)
            .order_by(desc(StackReport.created_at))
            .limit(1)
        )
        return result.scalar_one_or_none()
 
    async def get_by_id(self, report_id: int) -> StackReport | None:
        result = await self.db.execute(
            select(StackReport).where(StackReport.id == report_id)
        )
        return result.scalar_one_or_none()
 
    async def list_reports(self, project_id: str) -> list[StackReport]:
        result = await self.db.execute(
            select(StackReport)
            .where(StackReport.project_id == project_id)
            .order_by(desc(StackReport.created_at))
        )
        return result.scalars().all()
