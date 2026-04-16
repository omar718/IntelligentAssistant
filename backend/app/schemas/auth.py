import re # For string validation
from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, EmailStr, field_validator, model_validator # for validation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASSWORD_MIN_LENGTH = 8
_UPPER_RE = re.compile(r"[A-Z]")
_DIGIT_RE = re.compile(r"\d")
RESET_PASSWORD_ERROR = "Password must contain at least one capital letter, 8+ characters, and a number."


def validate_password_strength(v: str) -> str:
    if len(v) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters")
    if not _UPPER_RE.search(v):
        raise ValueError("Password must contain at least one uppercase letter")
    if not _DIGIT_RE.search(v):
        raise ValueError("Password must contain at least one digit")
    return v


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    confirm_password: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return validate_password_strength(v)

    @model_validator(mode="after")
    def passwords_match(self) -> "RegisterRequest":
        if self.password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class ForgotPasswordRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.lower().strip()


class ResetPasswordRequest(BaseModel):
    token: str
    password: str
    confirm_password: str

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < PASSWORD_MIN_LENGTH or not _UPPER_RE.search(v) or not _DIGIT_RE.search(v):
            raise ValueError(RESET_PASSWORD_ERROR)
        return v

    @model_validator(mode="after")
    def passwords_match(self) -> "ResetPasswordRequest":
        if self.password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self


# ---------------------------------------------------------------------------
# Response schemas  (password_hash NEVER included)
# ---------------------------------------------------------------------------

class UserProfile(BaseModel):
    id: str
    name: str
    email: str
    role: str
    is_active: bool
    is_verified: bool
    created_at: datetime
    last_login: Optional[datetime] = None

    model_config = {"from_attributes": True}

    @field_validator("role", mode="before")
    @classmethod
    def coerce_role(cls, v) -> str:
        return v.value if hasattr(v, "value") else str(v)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserProfile


class MessageResponse(BaseModel):
    message: str


# ---------------------------------------------------------------------------
# Personal stats / project history schemas
# ---------------------------------------------------------------------------

class ProjectSummary(BaseModel):
    id: str
    name: str
    name: str
    type: Optional[str]
    status: str
    created_at: datetime
    port: Optional[int] = None
    repository_url: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None

    model_config = {"from_attributes": True}


class PaginatedProjects(BaseModel):
    items: list[ProjectSummary]
    total: int
    page: int
    per_page: int
    pages: int


class UserStats(BaseModel):
    total_installs: int
    successful_installs: int
    success_rate: float           # 0.0 – 100.0
    most_used_stack: Optional[str]