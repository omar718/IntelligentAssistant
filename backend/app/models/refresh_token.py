from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from app.models.base import Base
from sqlalchemy.sql import func

class RefreshToken(Base):
    __tablename__ = 'refresh_tokens'

    id           = Column(Integer, primary_key=True, autoincrement=True)
    token_hash   = Column(String(255), nullable=False, unique=True) #never repeated token value
    session_id   = Column(String(128), nullable=False, index=True)
    user_id      = Column(String(50), ForeignKey('users.id'))
    user_agent   = Column(String(1024), nullable=True)
    ip_address   = Column(String(128), nullable=True)
    last_activity = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    is_active    = Column(Boolean, nullable=False, default=True)
    expires_at   = Column(DateTime(timezone=True), nullable=False)
    revoked      = Column(Boolean, nullable=False, default=False)
    created_at   = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
