from datetime import datetime, timezone
from pathlib import Path
import secrets
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, File, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import RedirectResponse
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import CurrentUser
from app.core.config import settings
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
    ChangePasswordRequest,
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
    update_profile_picture,
)

auth_router = APIRouter()

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_PROFILE_IMAGE_SIZE = 5 * 1024 * 1024
UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads" / "profile_pictures"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REFRESH_COOKIE = "refresh_token"
COOKIE_OPTIONS = dict(
    key=REFRESH_COOKIE,
    httponly=True,
    secure=not settings.DEBUG,
    samesite="lax",
    max_age=7 * 24 * 3600,  # 7 days in seconds
    path="/",   # Cookie only sent to refresh endpoint
)


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(value=raw_token, **COOKIE_OPTIONS)


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/")


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


def _extract_repository_url(metadata: dict | None) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None

    # Backward-compatible key lookup for old and new metadata formats.
    for key in ("source_url", "repository_url", "git_url", "url"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    source = metadata.get("source")
    if isinstance(source, dict):
        value = source.get("url")
        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def _remove_old_profile_image_if_local(profile_picture: Optional[str]) -> None:
    if not profile_picture:
        return

    uploads_prefix = "/uploads/profile_pictures/"
    if uploads_prefix not in profile_picture:
        return

    filename = profile_picture.rsplit(uploads_prefix, 1)[-1].strip()
    if not filename:
        return

    candidate = (UPLOAD_DIR / filename).resolve()
    try:
        candidate.relative_to(UPLOAD_DIR.resolve())
    except ValueError:
        return

    if candidate.is_file():
        candidate.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------

@auth_router.post("/auth/register", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    # Rate limiting disabled in DEBUG mode for development
    if not settings.DEBUG:
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

@auth_router.get("/auth/verify/{token}")
async def verify_email(token: str, db: AsyncSession = Depends(get_db)):
    try:
        user_id = decode_signed_token(token, expected_purpose="email_verify")
    except JWTError:
        return RedirectResponse(url=f"{settings.APP_BASE_URL}/login?error=invalid_token")

    user = await get_user_by_id(db, user_id)
    if user is None:
        return RedirectResponse(url=f"{settings.APP_BASE_URL}/login?error=user_not_found")

    if not user.is_verified:
        await activate_user(db, user)

    return RedirectResponse(url=f"{settings.APP_BASE_URL}/login?verified=true")


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
    client_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    # Rate limiting disabled in DEBUG mode for development
    if not settings.DEBUG:
        allowed, retry_after = await login_limiter.is_allowed(f"login:{client_ip}")
        if not allowed:
            raise _rate_limit_error(retry_after)

    user = await get_user_by_email(db, body.email)

    # Constant-time: always verify even if user doesn't exist (dummy hash)
    _dummy = "$2b$12$18fY35RWBv47Qx7s7wfH6u4FejNXDfcVsYIKm7lcAMiJmqQZD/Ire"
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
    session_id = secrets.token_urlsafe(32)
    await save_refresh_token(
        db,
        user.id,
        hashed_refresh,
        session_id,
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip,
    )

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
    await save_refresh_token(
        db,
        user.id,
        hashed_new,
        rt.session_id,
        user_agent=rt.user_agent,
        ip_address=rt.ip_address,
    )

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
    # Rate limiting disabled in DEBUG mode for development
    if not settings.DEBUG:
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
    # Rate limiting disabled in DEBUG mode for development
    if not settings.DEBUG:
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


@auth_router.post("/api/users/me/change-password", response_model=MessageResponse)
async def change_password(
    body: ChangePasswordRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    if verify_password(body.new_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from current password",
        )

    await update_password(db, current_user, body.new_password)

    return MessageResponse(message="Password updated successfully")


@auth_router.post("/api/users/me/profile-picture", response_model=UserProfile)
async def upload_profile_picture(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
) -> UserProfile:
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported image format. Use JPG, PNG, WEBP, or GIF.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image file is empty")

    if len(content) > MAX_PROFILE_IMAGE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image is too large. Maximum size is 5 MB.",
        )

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    extension = ALLOWED_IMAGE_TYPES[file.content_type]
    filename = f"{current_user.id}_{secrets.token_urlsafe(8)}{extension}"
    saved_path = UPLOAD_DIR / filename
    saved_path.write_bytes(content)

    _remove_old_profile_image_if_local(current_user.profile_picture)

    public_path = f"/uploads/profile_pictures/{filename}"
    public_url = f"{settings.API_BASE_URL.rstrip('/')}{public_path}"
    await update_profile_picture(db, current_user, public_url)

    return UserProfile.model_validate(current_user)


@auth_router.delete("/api/users/me/profile-picture", response_model=UserProfile)
async def remove_profile_picture(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    _remove_old_profile_image_if_local(current_user.profile_picture)
    await update_profile_picture(db, current_user, None)
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
        items=[
            ProjectSummary.model_validate({
                "id": p.id,
                "name": p.name,
                "type": p.type,
                "status": p.status,
                "created_at": p.created_at,
                "port": p.port,
                "repository_url": _extract_repository_url(p.metadata_),
                "metadata": p.metadata_ or {},
            })
            for p in projects
        ],
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
