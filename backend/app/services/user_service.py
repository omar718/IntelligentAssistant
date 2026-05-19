import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.models.user import User, UserRole
from app.models.refresh_token import RefreshToken


# ---------------------------------------------------------------------------
# User CRUD
# ---------------------------------------------------------------------------

async def get_user_by_id(db: AsyncSession, user_id: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def get_user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    """Always normalize email to lowercase before lookup."""
    result = await db.execute(select(User).where(User.email == email.lower()))
    return result.scalar_one_or_none()


async def create_user(db: AsyncSession, email: str, plain_password: str, name: str) -> User:
    """Create a new user. Email is normalized; password is bcrypt-hashed."""
    user = User(
        id=f"user_{secrets.token_urlsafe(8)}",
        name=name,
        email=email.lower(),
        password_hash=hash_password(plain_password),
        role=UserRole.USER,
        is_active=True,
        is_verified=False,
    )
    db.add(user)
    await db.flush()
    return user


async def activate_user(db: AsyncSession, user: User) -> None:
    user.is_verified = True
    await db.flush()


async def update_last_login(db: AsyncSession, user: User) -> None:
    user.last_login = datetime.now(timezone.utc)
    await db.flush()


async def update_password(db: AsyncSession, user: User, new_plain_password: str) -> None:
    user.password_hash = hash_password(new_plain_password)
    user.password_last_changed = datetime.now(timezone.utc)
    await db.flush()


async def update_profile_picture(db: AsyncSession, user: User, profile_picture: str | None) -> None:
    user.profile_picture = profile_picture
    await db.flush()


# ---------------------------------------------------------------------------
# Refresh token management
# ---------------------------------------------------------------------------

async def save_refresh_token(
    db: AsyncSession,
    user_id: str,
    token_hash: str,
    session_id: str,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> RefreshToken:
    now = datetime.now(timezone.utc)
    rt = RefreshToken(
        token_hash=token_hash,
        session_id=session_id,
        user_id=user_id,
        user_agent=user_agent,
        ip_address=ip_address,
        last_activity=now,
        is_active=True,
        expires_at=now + timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
        revoked=False,
    )
    db.add(rt)
    await db.flush()
    return rt


async def get_refresh_token(
    db: AsyncSession, token_hash: str
) -> Optional[RefreshToken]:
    result = await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    )
    return result.scalar_one_or_none()


async def revoke_refresh_token(db: AsyncSession, token: RefreshToken) -> None:
    token.revoked = True
    token.is_active = False
    await db.flush()


async def revoke_all_user_refresh_tokens(db: AsyncSession, user_id: str) -> None:
    """Used on password reset — terminates all sessions across all devices."""
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked == False,  # noqa: E712
        )
    )
    for token in result.scalars().all():
        token.revoked = True
        token.is_active = False
    await db.flush()


async def update_session_activity(db: AsyncSession, user_id: str, session_id: str) -> bool:
    if not session_id:
        return True

    result = await db.execute(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.session_id == session_id,
            RefreshToken.revoked == False,  # noqa: E712
        )
        .order_by(RefreshToken.created_at.desc())
        .limit(1)
    )
    token = result.scalar_one_or_none()
    if token is None:
        return False

    token.last_activity = datetime.now(timezone.utc)
    token.is_active = True
    await db.flush()
    return True


async def list_active_sessions(db: AsyncSession, user_id: str) -> list[RefreshToken]:
    result = await db.execute(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked == False,  # noqa: E712
            RefreshToken.is_active == True,  # noqa: E712
        )
        .order_by(RefreshToken.last_activity.desc(), RefreshToken.created_at.desc())
    )

    sessions: list[RefreshToken] = []
    seen: set[str] = set()
    for token in result.scalars().all():
        if token.session_id in seen:
            continue
        seen.add(token.session_id)
        sessions.append(token)
    return sessions


async def deactivate_other_sessions(db: AsyncSession, user_id: str, current_session_id: str) -> int:
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked == False,  # noqa: E712
            RefreshToken.is_active == True,  # noqa: E712
            RefreshToken.session_id != current_session_id,
        )
    )

    count = 0
    for token in result.scalars().all():
        token.revoked = True
        token.is_active = False
        count += 1

    await db.flush()
    return count


async def deactivate_session(db: AsyncSession, user_id: str, session_id: str) -> bool:
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.session_id == session_id,
            RefreshToken.revoked == False,  # noqa: E712
            RefreshToken.is_active == True,  # noqa: E712
        )
    )

    tokens = result.scalars().all()
    if not tokens:
        return False

    for token in tokens:
        token.revoked = True
        token.is_active = False

    await db.flush()
    return True


async def revoke_token_family(db: AsyncSession, user_id: str) -> None:
    """
    Reuse detection: a revoked token was presented.
    Revoke ALL tokens for this user and force re-login.
    """
    await revoke_all_user_refresh_tokens(db, user_id)