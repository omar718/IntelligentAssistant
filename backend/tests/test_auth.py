# -*- coding: utf-8 -*-
"""
Auth endpoint tests.
Covers all 12 security checklist items.

Run with:
    pytest tests/test_auth.py -v
"""
import hashlib
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator
from unittest.mock import patch, AsyncMock

import pytest
import pytest_asyncio
from fastapi import status
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import get_db
from app.core.security import (
    create_signed_token,
    generate_refresh_token,
    hash_password,
)
from app.main import app
from app.models.user import Base, User, UserRole
from app.models.refresh_token import RefreshToken
from app.models.project import Project, ProjectStatus
from app.services.user_service import save_refresh_token

# ---------------------------------------------------------------------------
# Test DB setup (in-memory SQLite for speed)
# ---------------------------------------------------------------------------

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
test_engine = create_async_engine(TEST_DB_URL, echo=False)
TestSession = async_sessionmaker(test_engine, expire_on_commit=False)


async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
    async with TestSession() as session:
        yield session
        await session.commit()


app.dependency_overrides[get_db] = override_get_db


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture(autouse=True)
async def mock_rate_limiter():
    """Bypass Redis rate limiting in tests — avoids event-loop/connection issues."""
    with patch("app.core.redis.RateLimiter.is_allowed", new_callable=AsyncMock, return_value=(True, 0)):
        yield


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as c:
        yield c


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    async with TestSession() as session:
        yield session
        await session.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def make_user(
    db: AsyncSession,
    email: str = "test@example.com",
    password: str = "Password1",
    verified: bool = True,
    active: bool = True,
) -> User:
    user = User(
        id=f"user_test_{email[:4]}",
        name="Test User",
        email=email.lower(),
        password_hash=hash_password(password),
        role=UserRole.USER,
        is_active=active,
        is_verified=verified,
    )
    db.add(user)
    await db.flush()
    return user


# ---------------------------------------------------------------------------
# Registration tests
# ---------------------------------------------------------------------------

class TestRegister:
    @pytest.mark.asyncio
    async def test_register_success(self, client, db):
        with patch("app.api.routes.auth.send_verification_email"):
            resp = await client.post("/auth/register", json={
                "name": "New User",
                "email": "new@example.com",
                "password": "Password1",
                "confirm_password": "Password1",
            })
        assert resp.status_code == status.HTTP_201_CREATED
        assert "email" in resp.json()["message"].lower()

    @pytest.mark.asyncio
    async def test_register_duplicate_email_same_response(self, client, db):
        """Duplicate email returns identical 201 — no enumeration."""
        await make_user(db)
        with patch("app.api.routes.auth.send_verification_email"):
            resp = await client.post("/auth/register", json={
                "name": "Test User",
                "email": "test@example.com",
                "password": "Password1",
                "confirm_password": "Password1",
            })
        assert resp.status_code == status.HTTP_201_CREATED

    @pytest.mark.asyncio
    async def test_register_email_normalized(self, client, db):
        """Email is lowercased on storage."""
        with patch("app.api.routes.auth.send_verification_email"):
            await client.post("/auth/register", json={
                "name": "Upper User",
                "email": "UPPER@EXAMPLE.COM",
                "password": "Password1",
                "confirm_password": "Password1",
            })
        result = await db.execute(
            __import__("sqlalchemy").select(User).where(User.email == "upper@example.com")
        )
        assert result.scalar_one_or_none() is not None

    @pytest.mark.asyncio
    async def test_register_weak_password_rejected(self, client):
        resp = await client.post("/auth/register", json={
            "email": "x@example.com",
            "password": "short",
            "confirm_password": "short",
        })
        assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    @pytest.mark.asyncio
    async def test_register_password_mismatch_rejected(self, client):
        resp = await client.post("/auth/register", json={
            "email": "x@example.com",
            "password": "Password1",
            "confirm_password": "Password2",
        })
        assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

# ---------------------------------------------------------------------------
# Login tests
# ---------------------------------------------------------------------------

class TestLogin:
    @pytest.mark.asyncio
    async def test_login_success_returns_access_token_and_cookie(self, client, db):
        await make_user(db)
        resp = await client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "Password1",
        })
        assert resp.status_code == status.HTTP_200_OK
        body = resp.json()
        assert "access_token" in body
        assert "user" in body
        assert "password_hash" not in str(body)  # ✓ password_hash excluded
        assert "refresh_token" in resp.cookies      # ✓ httpOnly cookie set

    @pytest.mark.asyncio
    async def test_login_wrong_password_401(self, client, db):
        await make_user(db)
        resp = await client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "WrongPass1",
        })
        assert resp.status_code == status.HTTP_401_UNAUTHORIZED
        # ✓ vague error — no "which field is wrong"
        assert resp.json()["detail"] == "Invalid email or password"

    @pytest.mark.asyncio
    async def test_login_unverified_rejected(self, client, db):
        await make_user(db, verified=False)
        resp = await client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "Password1",
        })
        assert resp.status_code == status.HTTP_401_UNAUTHORIZED

    @pytest.mark.asyncio
    async def test_login_inactive_rejected(self, client, db):
        await make_user(db, active=False)
        resp = await client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "Password1",
        })
        assert resp.status_code == status.HTTP_401_UNAUTHORIZED

    @pytest.mark.asyncio
    async def test_login_refresh_token_hash_stored_not_raw(self, client, db):
        """Raw refresh token must never be stored in DB. Only SHA-256 hash."""
        await make_user(db)
        resp = await client.post("/auth/login", json={
            "email": "test@example.com", "password": "Password1"
        })
        raw_cookie = resp.cookies.get("refresh_token")
        assert raw_cookie is not None

        from sqlalchemy import select
        result = await db.execute(select(RefreshToken))
        rt = result.scalar_one()
        expected_hash = hashlib.sha256(raw_cookie.encode()).hexdigest()
        assert rt.token_hash == expected_hash  # ✓ hash stored, not raw


# ---------------------------------------------------------------------------
# Refresh Token Rotation (RTR) tests
# ---------------------------------------------------------------------------

class TestRefreshRotation:
    @pytest.mark.asyncio
    async def test_refresh_rotates_token(self, client, db):
        """Each /auth/refresh must revoke old token and issue a new one."""
        await make_user(db)
        login_resp = await client.post("/auth/login", json={
            "email": "test@example.com", "password": "Password1"
        })
        old_cookie = login_resp.cookies.get("refresh_token")

        refresh_resp = await client.post("/auth/refresh")
        assert refresh_resp.status_code == status.HTTP_200_OK
        new_cookie = refresh_resp.cookies.get("refresh_token")
        assert new_cookie != old_cookie  # ✓ new token issued

        # Old token should be revoked
        old_hash = hashlib.sha256(old_cookie.encode()).hexdigest()
        from sqlalchemy import select
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == old_hash)
        )
        old_rt = result.scalar_one()
        assert old_rt.revoked is True  # ✓ RTR: old revoked immediately

    @pytest.mark.asyncio
    async def test_reuse_detection_revokes_entire_family(self, client, db):
        """Presenting a revoked token must revoke ALL tokens for the user."""
        await make_user(db)
        login_resp = await client.post("/auth/login", json={
            "email": "test@example.com", "password": "Password1"
        })
        stolen_cookie = login_resp.cookies.get("refresh_token")

        # Legitimate refresh
        await client.post("/auth/refresh")

        # Attacker presents stolen (now-revoked) token
        attacker_client = AsyncClient(
            transport=ASGITransport(app=app), base_url="https://test"
        )
        attacker_client.cookies.set("refresh_token", stolen_cookie)
        async with attacker_client:
            resp = await attacker_client.post("/auth/refresh")
        assert resp.status_code == status.HTTP_401_UNAUTHORIZED

        # All tokens for the user must now be revoked
        from sqlalchemy import select
        await db.commit()  # End current read snapshot, see latest committed state
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.revoked == False)  # noqa
        )
        assert result.scalars().all() == []  # ✓ entire family revoked


        # ---------------------------------------------------------------------------
# Forgot password — enumeration prevention
# ---------------------------------------------------------------------------

class TestForgotPassword:
    @pytest.mark.asyncio
    async def test_always_returns_200(self, client):
        """Must return 200 even for non-existent emails (§2.5)."""
        resp = await client.post("/auth/forgot-password", json={"email": "nobody@example.com"})
        assert resp.status_code == status.HTTP_200_OK

    @pytest.mark.asyncio
    async def test_known_and_unknown_email_identical_response(self, client, db):
        await make_user(db)
        with patch("app.api.routes.auth.send_password_reset_email"):
            r1 = await client.post("/auth/forgot-password", json={"email": "test@example.com"})
            r2 = await client.post("/auth/forgot-password", json={"email": "ghost@example.com"})
        assert r1.json() == r2.json()  # ✓ identical body


        # ---------------------------------------------------------------------------
# Reset password tests
# ---------------------------------------------------------------------------

class TestResetPassword:
    @pytest.mark.asyncio
    async def test_reset_revokes_all_sessions(self, client, db):
        """On password reset, ALL refresh tokens must be revoked."""
        user = await make_user(db)
        raw, hashed = generate_refresh_token()
        await save_refresh_token(db, user.id, hashed)
        raw2, hashed2 = generate_refresh_token()
        await save_refresh_token(db, user.id, hashed2)

        token = create_signed_token(user.id, "password_reset", ttl_hours=1)
        resp = await client.post("/auth/reset-password", json={
            "token": token,
            "password": "NewPass1word",
            "confirm_password": "NewPass1word",
        })
        assert resp.status_code == status.HTTP_200_OK

        from sqlalchemy import select
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)  # noqa
        )
        assert result.scalars().all() == []  # ✓ all sessions terminated

    @pytest.mark.asyncio
    async def test_expired_token_rejected(self, client, db):
        user = await make_user(db)
        expired = create_signed_token.__wrapped__ if hasattr(create_signed_token, "__wrapped__") else None
        # Manually create expired token
        from jose import jwt
        from app.core.config import settings
        payload = {
            "sub": user.id,
            "purpose": "password_reset",
            "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        }
        expired_token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
        resp = await client.post("/auth/reset-password", json={
            "token": expired_token,
            "password": "NewPass1word",
            "confirm_password": "NewPass1word",
        })
        assert resp.status_code == status.HTTP_400_BAD_REQUEST


# ---------------------------------------------------------------------------
# Data isolation tests
# ---------------------------------------------------------------------------

class TestDataIsolation:
    @pytest.mark.asyncio
    async def test_user_cannot_access_another_users_project(self, client, db):
        """A user fetching another user's project_id must get 403, not the data."""
        user_a = await make_user(db, email="a@example.com")
        user_b = await make_user(db, email="b@example.com")

        project = Project(
            id="proj_other",
            name="B's project",
            path="/tmp/b",
            status=ProjectStatus.running,
            user_id=user_b.id,
        )
        db.add(project)
        await db.flush()

        # Login as user A
        resp = await client.post("/auth/login", json={"email": "a@example.com", "password": "Password1"})
        token = resp.json()["access_token"]

        # Attempt to access user B's project
        project_resp = await client.get(
            "/api/projects/proj_other",
            headers={"Authorization": f"Bearer {token}"},
        )
        # Must be 403, not 200 with wrong data, not 404
        assert project_resp.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Me endpoint — password_hash exclusion
# ---------------------------------------------------------------------------

class TestMe:
    @pytest.mark.asyncio
    async def test_me_excludes_password_hash(self, client, db):
        await make_user(db)
        login = await client.post("/auth/login", json={
            "email": "test@example.com", "password": "Password1"
        })
        token = login.json()["access_token"]
        resp = await client.get("/api/users/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == status.HTTP_200_OK
        body = resp.json()
        assert "password_hash" not in body   # ✓ never exposed
        assert "email" in body
        assert "role" in body


