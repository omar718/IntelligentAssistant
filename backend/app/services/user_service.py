import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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
    await db.flush()


# ---------------------------------------------------------------------------
# Refresh token management
# ---------------------------------------------------------------------------

async def save_refresh_token(
    db: AsyncSession, user_id: str, token_hash: str
) -> RefreshToken:
    rt = RefreshToken(
        token_hash=token_hash,
        user_id=user_id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
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
    await db.flush()


async def revoke_token_family(db: AsyncSession, user_id: str) -> None:
    """
    Reuse detection: a revoked token was presented.
    Revoke ALL tokens for this user and force re-login.
    """
    await revoke_all_user_refresh_tokens(db, user_id)