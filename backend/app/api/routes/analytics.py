"""
Admin → Analytics router
All routes require role == 'admin'.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import require_admin
from app.core.database import get_db
from app.models.user import User
from app.schemas.admin import AnalyticsOut, AuditLogPage
from app.services import admin_service

router = APIRouter(tags=["admin-analytics"])


def _default_from() -> date:
    return date.today() - timedelta(days=30)


@router.get("/analytics", response_model=AnalyticsOut)
async def get_analytics(
    date_from: date = Query(default_factory=_default_from, description="Start date (YYYY-MM-DD)"),
    date_to: date = Query(default_factory=date.today, description="End date (YYYY-MM-DD)"),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> AnalyticsOut:
    return await admin_service.get_analytics(db, date_from=date_from, date_to=date_to)


@router.get("/analytics/export")
async def export_analytics(
    date_from: date = Query(..., description="Start date (YYYY-MM-DD)"),
    date_to: date = Query(..., description="End date (YYYY-MM-DD)"),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> StreamingResponse:
    csv_data = await admin_service.export_analytics_csv(db, date_from=date_from, date_to=date_to)
    filename = f"analytics_{date_from}_{date_to}.csv"

    def generate():
        yield csv_data

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/audit-logs", response_model=AuditLogPage)
async def list_audit_logs(
    actor_id: str | None = Query(None),
    target_type: str | None = Query(None),
    action: str | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> AuditLogPage:
    return await admin_service.list_audit_logs(
        db,
        actor_id=actor_id,
        target_type=target_type,
        action=action,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
    )