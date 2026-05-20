"""
FastAPI router for stack report endpoints:
  GET  /api/projects/{project_id}/report          → download latest report
  GET  /api/projects/{project_id}/report/history  → list all reports for a project
  POST /api/projects/{project_id}/report/generate → (admin/internal) re-generate on demand
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.models.report import StackReport
from app.services.r2_storage import B2Storage
from app.services.report_service import ReportService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/projects", tags=["reports"])


# ─────────────────────────────────────────────────────────────────────────────
#  Download latest report
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "/{project_id}/report",
    summary="Download the latest stack report PDF for a project",
    responses={
        200: {"content": {"application/pdf": {}}, "description": "PDF file"},
        404: {"description": "No report found for this project"},
        403: {"description": "Not authorised to access this project's report"},
    },
)
async def download_latest_report(
    project_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    report_svc = ReportService(db)

    # Auth: user must own the project (or be admin)
    await report_svc.assert_project_access(project_id, current_user)

    report: StackReport | None = await report_svc.get_latest(project_id)
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No stack report found for this project. "
                   "The report is generated after a successful installation.",
        )

    b2 = B2Storage()
    pdf_bytes = await b2.download(report.r2_key)

    filename = f"stack-report-{project_id}-{report.created_at.strftime('%Y%m%d')}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─────────────────────────────────────────────────────────────────────────────
#  List all reports (history page)
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "/{project_id}/report/history",
    summary="List all stack reports generated for a project",
)
async def list_reports(
    project_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    report_svc = ReportService(db)
    await report_svc.assert_project_access(project_id, current_user)

    reports = await report_svc.list_reports(project_id)
    return {
        "project_id": project_id,
        "reports": [
            {
                "id":           r.id,
                "created_at":   r.created_at.isoformat(),
                "install_id":   r.installation_history_id,
                "r2_key":  r.r2_key,
                "download_url": f"/api/projects/{project_id}/report/{r.id}",
            }
            for r in reports
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Download specific report by ID
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/report/{report_id}", include_in_schema=False)
async def download_report_by_id(
    project_id: str,
    report_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    report_svc = ReportService(db)
    await report_svc.assert_project_access(project_id, current_user)

    report: StackReport | None = await report_svc.get_by_id(report_id)
    if not report or report.project_id != project_id:
        raise HTTPException(status_code=404, detail="Report not found")

    b2 = B2Storage()
    pdf_bytes = await b2.download(report.r2_key)

    filename = f"stack-report-{project_id}-{report.created_at.strftime('%Y%m%d-%H%M')}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )