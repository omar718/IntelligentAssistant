"""
Admin → Users router
All routes require role == 'admin' via the require_admin dependency.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import require_admin
from app.core.database import get_db
from app.models.user import User
from app.schemas.admin import AdminUserOut, AdminUserPage, AdminUserPatch, AuditLogPage
from app.services import admin_service

router = APIRouter()


@router.get("/users", response_model=AdminUserPage)
async def list_users(
    search: str | None = Query(None, description="Filter by email prefix"),
    role: str | None = Query(None, description="Filter by role: user | admin"),
    is_active: bool | None = Query(None, description="Filter by active status"),
    sort_by: str = Query("created_at", description="Sort field: email | created_at | last_login"),
    sort_dir: str = Query("desc", description="asc | desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> AdminUserPage:
    return await admin_service.list_users(
        db,
        search=search,
        role=role,
        is_active=is_active,
        sort_by=sort_by,
        sort_dir=sort_dir,
        page=page,
        page_size=page_size,
    )


@router.get("/users/{user_id}", response_model=AdminUserOut)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> AdminUserOut:
    return await admin_service.get_user_detail(db, user_id)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def patch_user(
    user_id: str,
    payload: AdminUserPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> AdminUserOut:
    actor_ip = request.client.host if request.client else None
    user = await admin_service.patch_user(
        db,
        user_id=user_id,
        payload=payload,
        actor_id=admin.id,
        actor_ip=actor_ip,
    )
    return AdminUserOut.model_validate(user)


@router.get("/users/{user_id}/audit-logs", response_model=AuditLogPage)
async def get_user_audit_logs(
    user_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> AuditLogPage:
    """Return the last N audit log entries targeting a specific user."""
    return await admin_service.list_audit_logs(
        db,
        target_type="user",
        target_id=user_id,
        actor_id=None,
        action=None,
        date_from=None,
        date_to=None,
        page=page,
        page_size=page_size,
    )
