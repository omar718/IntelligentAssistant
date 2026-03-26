from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSON

from app.models.base import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    actor_id    = Column(String(50), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    target_type = Column(String(50), nullable=False, index=True)
    target_id   = Column(String(50), nullable=True)
    action      = Column(String(100), nullable=False, index=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
