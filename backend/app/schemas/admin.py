from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, field_validator


# ─── Audit Log Schemas ───────────────────────────────────────────────────────

class AuditLogOut(BaseModel):
    id: int
    actor_id: str
    target_type: str
    target_id: str | None
    action: str
    metadata_: dict[str, Any] | None
    created_at: datetime

    model_config = {"from_attributes": True}


class AuditLogPage(BaseModel):
    items: list[AuditLogOut]
    total: int
    page: int
    page_size: int
    pages: int


# ─── Admin User Schemas ───────────────────────────────────────────────────────

class AdminUserOut(BaseModel):
    id: str
    email: str
    role: str
    is_active: bool
    is_verified: bool
    created_at: datetime
    last_login: datetime | None
    install_count: int = 0

    model_config = {"from_attributes": True}
    #from enum to string
    @field_validator("role", mode="before")
    @classmethod
    def coerce_role(cls, v) -> str:
        return v.value if hasattr(v, "value") else str(v)


class AdminUserPage(BaseModel):
    items: list[AdminUserOut]
    total: int
    page: int
    page_size: int
    pages: int


class AdminUserPatch(BaseModel):
    is_active: bool | None = None
    role: Literal["user", "admin"] | None = None

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in ("user", "admin"):
            raise ValueError("role must be 'user' or 'admin'")
        return v


# ─── Analytics Schemas ────────────────────────────────────────────────────────

class DauPoint(BaseModel):
    date: str          # ISO date string "YYYY-MM-DD"
    active_users: int


class InstallPoint(BaseModel):
    date: str
    success: int
    failed: int


class SuccessRatePoint(BaseModel):
    date: str
    rate: float        # 0.0 – 100.0


class StackSlice(BaseModel):
    stack: str
    count: int
    percentage: float


class TopError(BaseModel):
    category: str
    count: int
    last_seen: datetime
    project_id: str | None


class AnalyticsOut(BaseModel):
    dau: list[DauPoint]
    installs: list[InstallPoint]
    success_rate_trend: list[SuccessRatePoint]
    stack_distribution: list[StackSlice]
    avg_setup_time_by_stack: dict[str, float]   # stack -> seconds
    top_errors: list[TopError]
    total_api_cost_usd: float