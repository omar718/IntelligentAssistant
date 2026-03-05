import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from jose.exceptions import JWTError
from jose import jwt

from app.core.config import settings


# ---------------------------------------------------------------------------
# Password hashing  (bcrypt cost >= 12 as per spec)
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    """Hash a plaintext password using bcrypt with cost factor >= 12."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-time bcrypt comparison."""
    return bcrypt.checkpw(plain.encode(), hashed.encode())

# ---------------------------------------------------------------------------
# JWT access tokens  (15-minute TTL)
# ---------------------------------------------------------------------------

def create_access_token(subject: str, role: str) -> str:
    """Create a signed JWT access token."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_TTL_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and verify a JWT access token. Raises JWTError on failure."""
    return jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# Refresh tokens  (opaque random token; SHA-256 stored in DB)
# ---------------------------------------------------------------------------

def generate_refresh_token() -> tuple[str, str]:
    """
    Generate a cryptographically secure refresh token.

    Returns:
        (raw_token, sha256_hash)
        - raw_token: sent to the client via httpOnly cookie
        - sha256_hash: stored in the database (never the raw value)
    """
    raw = secrets.token_urlsafe(64)
    hashed = hashlib.sha256(raw.encode()).hexdigest()
    return raw, hashed


def hash_refresh_token(raw: str) -> str:
    """Hash a raw refresh token for DB lookup."""
    return hashlib.sha256(raw.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Email verification & password-reset tokens  (signed JWTs)
# ---------------------------------------------------------------------------

def create_signed_token(subject: str, purpose: str, ttl_hours: int) -> str:
    """
    Create a short-lived signed token for email verification or password reset.

    Args:
        subject: user ID
        purpose: 'email_verify' | 'password_reset'
        ttl_hours: token lifetime in hours
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "purpose": purpose,
        "iat": now,
        "exp": now + timedelta(hours=ttl_hours),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_signed_token(token: str, expected_purpose: str) -> str:
    """
    Decode a signed purpose token.

    Returns:
        user_id (subject)

    Raises:
        JWTError: if expired, invalid, or purpose mismatch
    """
    payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    if payload.get("purpose") != expected_purpose:
        raise JWTError("Token purpose mismatch")
    return payload["sub"]


