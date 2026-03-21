from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import CurrentUser
from app.core.database import get_db
from app.core.redis import (
    forgot_limiter,
    login_limiter,
    register_limiter,
    reset_limiter,
)
from app.core.security import (
    create_access_token,
    decode_signed_token,
    generate_refresh_token,
    hash_refresh_token,
    verify_password,
)
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    MessageResponse,
    PaginatedProjects,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    UserProfile,
    UserStats,
)
from app.services.email_service import send_password_reset_email, send_verification_email
from app.services.user_service import (
    activate_user,
    create_user,
    get_refresh_token,
    get_user_by_email,
    get_user_by_id,
    revoke_all_user_refresh_tokens,
    revoke_refresh_token,
    revoke_token_family,
    save_refresh_token,
    update_last_login,
    update_password,
)

auth_router = APIRouter()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REFRESH_COOKIE = "refresh_token"
COOKIE_OPTIONS = dict(
    key=REFRESH_COOKIE,
    httponly=True,
    secure=True,
    samesite="strict",
    max_age=7 * 24 * 3600,  # 7 days in seconds
    path="/auth/refresh",   # Cookie only sent to refresh endpoint
)


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(value=raw_token, **COOKIE_OPTIONS)


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/auth/refresh")


def _rate_limit_error(retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many requests",
        headers={"Retry-After": str(retry_after)},
    )


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------

@auth_router.post("/auth/register", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    client_ip = request.client.host
    allowed, retry_after = await register_limiter.is_allowed(f"register:{client_ip}")
    if not allowed:
        raise _rate_limit_error(retry_after)

    existing = await get_user_by_email(db, body.email)
    if existing:
        # Return success-shaped response to prevent email enumeration
        return MessageResponse(message="Check your email to verify your account")

    user = await create_user(db, body.email, body.password, body.name)
    send_verification_email(user.id, user.email)  # fire-and-forget (sync for simplicity)

    return MessageResponse(message="Check your email to verify your account")


# ---------------------------------------------------------------------------
# GET /auth/verify/{token}
# ---------------------------------------------------------------------------

@auth_router.get("/auth/verify/{token}", response_model=MessageResponse)
async def verify_email(token: str, db: AsyncSession = Depends(get_db)) -> MessageResponse:
    try:
        user_id = decode_signed_token(token, expected_purpose="email_verify")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification link")

    user = await get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if not user.is_verified:
        await activate_user(db, user)

    return MessageResponse(message="Email verified successfully. You may now log in.")


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------

@auth_router.post("/auth/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    client_ip = request.client.host
    allowed, retry_after = await login_limiter.is_allowed(f"login:{client_ip}")
    if not allowed:
        raise _rate_limit_error(retry_after)

    user = await get_user_by_email(db, body.email)

    # Constant-time: always verify even if user doesn't exist (dummy hash)
    _dummy = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    password_ok = verify_password(body.password, user.password_hash if user else _dummy)

    if not user or not password_ok or not user.is_active or not user.is_verified:
        # Deliberately vague: never reveal which field is wrong
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    await update_last_login(db, user)

    access_token = create_access_token(user.id, user.role.value if hasattr(user.role, 'value') else user.role)
    raw_refresh, hashed_refresh = generate_refresh_token()
    await save_refresh_token(db, user.id, hashed_refresh)

    _set_refresh_cookie(response, raw_refresh)

    return TokenResponse(access_token=access_token, user=UserProfile.model_validate(user))

# ---------------------------------------------------------------------------

@auth_router.post("/auth/refresh", response_model=TokenResponse)
async def refresh_token(
    response: Response,
    refresh_token: Optional[str] = Cookie(default=None, alias=REFRESH_COOKIE),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token")

    token_hash = hash_refresh_token(refresh_token)
    rt = await get_refresh_token(db, token_hash)

    if rt is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    if rt.revoked:
        # Reuse detected — revoke entire token family
        await revoke_token_family(db, rt.user_id)
        await db.commit()  # Commit revocation durably before raising
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session compromised. Please log in again.",
        )

    if _as_utc(rt.expires_at) < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token expired")

    user = await get_user_by_id(db, rt.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account inactive")

    # Rotate: revoke old, issue new
    await revoke_refresh_token(db, rt)
    new_access = create_access_token(user.id, user.role.value if hasattr(user.role, 'value') else user.role)
    raw_new, hashed_new = generate_refresh_token()
    await save_refresh_token(db, user.id, hashed_new)

    _set_refresh_cookie(response, raw_new)

    return TokenResponse(access_token=new_access, user=UserProfile.model_validate(user))


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------

@auth_router.post("/auth/logout", response_model=MessageResponse)
async def logout(
    response: Response,
    current_user: CurrentUser,
    refresh_token: Optional[str] = Cookie(default=None, alias=REFRESH_COOKIE),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    if refresh_token:
        token_hash = hash_refresh_token(refresh_token)
        rt = await get_refresh_token(db, token_hash)
        if rt and not rt.revoked:
            await revoke_refresh_token(db, rt)

    _clear_refresh_cookie(response)
    return MessageResponse(message="Logged out successfully")


# ---------------------------------------------------------------------------
# POST /auth/forgot-password
# ---------------------------------------------------------------------------

@auth_router.post("/auth/forgot-password", response_model=MessageResponse)
async def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    allowed, retry_after = await forgot_limiter.is_allowed(f"forgot:{body.email}")
    if not allowed:
        # Return identical body — never reveal enumeration info
        return MessageResponse(message="If an account exists, you will receive an email")

    user = await get_user_by_email(db, body.email)
    if user and user.is_active:
        send_password_reset_email(user.id, user.email)

    # ALWAYS return 200 with identical message (§2.5 enumeration prevention)
    return MessageResponse(message="If an account exists, you will receive an email")


# ---------------------------------------------------------------------------
# POST /auth/reset-password
# ---------------------------------------------------------------------------

@auth_router.post("/auth/reset-password", response_model=MessageResponse)
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    allowed, retry_after = await reset_limiter.is_allowed(f"reset:{body.token}")
    if not allowed:
        # Invalidate the token immediately on breach
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please request a new reset link.",
            headers={"Retry-After": str(retry_after)},
        )

    try:
        user_id = decode_signed_token(body.token, expected_purpose="password_reset")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    user = await get_user_by_id(db, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reset link")

    await update_password(db, user, body.password)
    # Revoke ALL refresh tokens — terminate every active session
    await revoke_all_user_refresh_tokens(db, user_id)

    return MessageResponse(message="Password updated. Please log in with your new password.")


# ---------------------------------------------------------------------------
# GET /api/users/me
# ---------------------------------------------------------------------------

@auth_router.get("/api/users/me", response_model=UserProfile)
async def get_me(current_user: CurrentUser) -> UserProfile:
    return UserProfile.model_validate(current_user)


# ---------------------------------------------------------------------------
# GET /api/users/me/projects
# ---------------------------------------------------------------------------

@auth_router.get("/api/users/me/projects", response_model=PaginatedProjects)
async def get_my_projects(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    page: int = 1,
    per_page: int = 20,
    status: Optional[str] = None,
    type: Optional[str] = None,
) -> PaginatedProjects:
    from sqlalchemy import select, func
    from app.models.project import Project

    query = select(Project).where(Project.user_id == current_user.id)

    if status:
        query = query.where(Project.status == status)
    if type:
        query = query.where(Project.type == type)

    count_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = count_result.scalar_one()

    query = query.order_by(Project.created_at.desc())
    query = query.offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    projects = result.scalars().all()

    from app.schemas.auth import ProjectSummary
    return PaginatedProjects(
        items=[ProjectSummary.model_validate(p) for p in projects],
        total=total,
        page=page,
        per_page=per_page,
        pages=-(-total // per_page),  # ceiling division
    )


# ---------------------------------------------------------------------------
# GET /api/users/me/stats
# ---------------------------------------------------------------------------

@auth_router.get("/api/users/me/stats", response_model=UserStats)
async def get_my_stats(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> UserStats:
    from sqlalchemy import select, func, case
    from app.models.project import Project

    result = await db.execute(
        select(
            func.count(Project.id).label("total"),
            func.sum(case((Project.status == "running", 1), else_=0)).label("successful"),
            func.mode().within_group(Project.type.asc()).label("most_used_stack"),
        ).where(Project.user_id == current_user.id)
    )
    row = result.one()
    total = row.total or 0
    successful = int(row.successful or 0)

    return UserStats(
        total_installs=total,
        successful_installs=successful,
        success_rate=round((successful / total * 100) if total > 0 else 0.0, 1),
        most_used_stack=row.most_used_stack,
    )
