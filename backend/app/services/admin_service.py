"""
Admin service — user management, analytics queries, audit-log writes.
All analytics are driven by raw SQL via SQLAlchemy text() for performance.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog
from app.models.user import User, UserRole
from app.schemas.admin import (
    AdminUserOut,
    AdminUserPage,
    AdminUserPatch,
    AnalyticsOut,
    AuditLogOut,
    AuditLogPage,
    DauPoint,
    InstallPoint,
    StackSlice,
    SuccessRatePoint,
    TopError,
)

# ─── Audit Helper ─────────────────────────────────────────────────────────────

async def write_audit(
    db: AsyncSession,
    *,
    actor_id: str,
    target_type: str,
    target_id: str | None,
    action: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    # Initialized using standard Column-based model
    log = AuditLog(
        actor_id=actor_id,
        target_type=target_type,
        target_id=target_id,
        action=action,
        metadata_=metadata,
    )
    db.add(log)
    await db.flush()


# ─── User Management ──────────────────────────────────────────────────────────

async def list_users(
    db: AsyncSession,
    *,
    search: str | None = None,
    role: str | None = None,
    is_active: bool | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 20,
) -> AdminUserPage:
    allowed_sorts = {"email", "created_at", "last_login"}
    if sort_by not in allowed_sorts:
        sort_by = "created_at"
    sort_dir = "asc" if sort_dir.lower() == "asc" else "desc"

    stmt = select(User)
    if search:
        # User.email refers to the Column object
        stmt = stmt.where(User.email.ilike(f"{search.lower()}%"))
    if role:
        normalized_role = role.strip().lower()
        if normalized_role == "admin":
            stmt = stmt.where(User.role == UserRole.ADMIN)
        elif normalized_role == "user":
            stmt = stmt.where(User.role == UserRole.USER)
    if is_active is not None:
        stmt = stmt.where(User.is_active == is_active)

    # Total count
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar_one()

    # Ordering via getattr on the Column objects
    col = getattr(User, sort_by)
    stmt = stmt.order_by(col.desc() if sort_dir == "desc" else col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(stmt)
    rows = result.scalars().all()

    # Fetch install counts using text() as requested
    if rows:
        ids = [u.id for u in rows]
        install_sql = text(
            "SELECT p.user_id, COUNT(*) AS cnt "
            "FROM installation_history ih "
            "JOIN projects p ON p.id = ih.project_id "
            "WHERE p.user_id = ANY(:ids) "
            "GROUP BY p.user_id"
        )
        install_result = await db.execute(install_sql, {"ids": ids})
        install_map = {r.user_id: r.cnt for r in install_result.all()}
    else:
        install_map = {}

    items = []
    for u in rows:
        out = AdminUserOut.model_validate(u)
        out.install_count = install_map.get(u.id, 0)
        items.append(out)

    pages = max(1, -(-total // page_size))
    return AdminUserPage(items=items, total=total, page=page, page_size=page_size, pages=pages)


async def patch_user(
    db: AsyncSession,
    *,
    user_id: str,
    payload: AdminUserPatch,
    actor_id: str,
    actor_ip: str | None = None,
) -> User:
    """Patch a user and return updated User object."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Track changes for audit logging
    changes_made = False
    before_state = {}
    after_state = {}

    # Update is_active if provided
    if payload.is_active is not None and payload.is_active != user.is_active:
        before_state["is_active"] = user.is_active
        after_state["is_active"] = payload.is_active
        user.is_active = payload.is_active
        changes_made = True

    # Update role if provided
    if payload.role is not None:
        current_role_str = user.role.value if hasattr(user.role, "value") else str(user.role)
        if payload.role != current_role_str:
            new_role = UserRole.ADMIN if payload.role == "admin" else UserRole.USER
            before_state["role"] = current_role_str
            after_state["role"] = payload.role
            user.role = new_role
            changes_made = True

    # Save changes and audit log if any changes were made
    if changes_made:
        db.add(user)
        await db.commit()
        await db.refresh(user)
        
        # Log the change
        await write_audit(
            db,
            actor_id=actor_id,
            target_type="user",
            target_id=user_id,
            action="user.updated",
            metadata={"before": before_state, "after": after_state, "ip": actor_ip},
        )
        await db.commit()

    return user


# ─── Audit Log Listing ────────────────────────────────────────────────────────

async def list_audit_logs(
    db: AsyncSession,
    *,
    actor_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    action: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = 20,
) -> AuditLogPage:
    """List audit logs with filtering and pagination."""
    try:
        # Simple query without complex filters
        stmt = select(AuditLog)
        
        # Apply filters
        if target_id:
            stmt = stmt.where(AuditLog.target_id == target_id)
        
        # Get total count
        count_result = await db.execute(select(func.count(AuditLog.id)))
        total = count_result.scalar() or 0
        
        # Get paginated results
        stmt = stmt.order_by(AuditLog.created_at.desc())
        stmt = stmt.limit(page_size).offset((page - 1) * page_size)
        
        result = await db.execute(stmt)
        rows = result.scalars().all()
        
        pages = max(1, -(-total // page_size))
        
        return AuditLogPage(
            items=[AuditLogOut.model_validate(row) for row in rows],
            total=total,
            page=page,
            page_size=page_size,
            pages=pages,
        )
    except Exception as e:
        import traceback
        print(f"ERROR in list_audit_logs: {str(e)}")
        traceback.print_exc()
        raise


async def get_user_detail(db: AsyncSession, user_id: str) -> AdminUserOut:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return AdminUserOut.model_validate(user)


async def get_analytics(
    db: AsyncSession,
    *,
    date_from: date,
    date_to: date,
) -> AnalyticsOut:
    date_from_dt = datetime(date_from.year, date_from.month, date_from.day, tzinfo=timezone.utc)
    date_to_dt = datetime(date_to.year, date_to.month, date_to.day, 23, 59, 59, tzinfo=timezone.utc)

    installs_rows = (
        await db.execute(
            text(
                """
                SELECT
                    DATE(started_at) AS d,
                    SUM(CASE WHEN success IS TRUE THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN success IS FALSE THEN 1 ELSE 0 END) AS failed
                FROM installation_history
                WHERE started_at >= :date_from AND started_at <= :date_to
                GROUP BY DATE(started_at)
                ORDER BY d
                """
            ),
            {"date_from": date_from_dt, "date_to": date_to_dt},
        )
    ).all()

    dau_rows = (
        await db.execute(
            text(
                """
                SELECT DATE(created_at) AS d, COUNT(DISTINCT user_id) AS active_users
                FROM projects
                WHERE created_at >= :date_from AND created_at <= :date_to
                GROUP BY DATE(created_at)
                ORDER BY d
                """
            ),
            {"date_from": date_from_dt, "date_to": date_to_dt},
        )
    ).all()

    stack_rows = (
        await db.execute(
            text(
                """
                SELECT COALESCE(type, 'unknown') AS stack, COUNT(*) AS cnt
                FROM projects
                WHERE created_at >= :date_from AND created_at <= :date_to
                GROUP BY COALESCE(type, 'unknown')
                ORDER BY cnt DESC
                """
            ),
            {"date_from": date_from_dt, "date_to": date_to_dt},
        )
    ).all()

    total_installs = sum(int(r.success or 0) + int(r.failed or 0) for r in installs_rows)
    total_success = sum(int(r.success or 0) for r in installs_rows)

    success_rate_trend = []
    for row in installs_rows:
        success = int(row.success or 0)
        failed = int(row.failed or 0)
        total = success + failed
        rate = round((success / total) * 100, 1) if total > 0 else 0.0
        success_rate_trend.append(SuccessRatePoint(date=str(row.d), rate=rate))

    installs = [
        InstallPoint(date=str(row.d), success=int(row.success or 0), failed=int(row.failed or 0))
        for row in installs_rows
    ]
    dau = [DauPoint(date=str(row.d), active_users=int(row.active_users or 0)) for row in dau_rows]

    stack_distribution = []
    for row in stack_rows:
        count = int(row.cnt or 0)
        percentage = round((count / total_installs) * 100, 1) if total_installs > 0 else 0.0
        stack_distribution.append(StackSlice(stack=str(row.stack), count=count, percentage=percentage))

    return AnalyticsOut(
        dau=dau,
        installs=installs,
        success_rate_trend=success_rate_trend,
        stack_distribution=stack_distribution,
        avg_setup_time_by_stack={},
        top_errors=[],
        total_api_cost_usd=0.0,
    )


async def export_analytics_csv(
    db: AsyncSession,
    *,
    date_from: date,
    date_to: date,
) -> str:
    analytics = await get_analytics(db, date_from=date_from, date_to=date_to)

    buffer = io.StringIO()
    writer = csv.writer(buffer)

    writer.writerow(["section", "date", "metric", "value"])

    for point in analytics.dau:
        writer.writerow(["dau", point.date, "active_users", point.active_users])

    for point in analytics.installs:
        writer.writerow(["installs", point.date, "success", point.success])
        writer.writerow(["installs", point.date, "failed", point.failed])

    for point in analytics.success_rate_trend:
        writer.writerow(["success_rate", point.date, "rate", point.rate])

    for slice_item in analytics.stack_distribution:
        writer.writerow(["stack_distribution", "", slice_item.stack, slice_item.count])

    writer.writerow(["summary", "", "total_api_cost_usd", analytics.total_api_cost_usd])

    return buffer.getvalue()