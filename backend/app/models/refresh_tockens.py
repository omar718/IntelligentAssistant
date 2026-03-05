from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from app.models.base import Base
from sqlalchemy.sql import func

class RefreshToken(Base):
    __tablename__ = 'refresh_tokens'

    id           = Column(Integer, primary_key=True, autoincrement=True)
    token_hash   = Column(String(255), nullable=False, unique=True) #never repeated token value
    user_id      = Column(String(50), ForeignKey('users.id'))
    expires_at   = Column(DateTime(timezone=True), nullable=False)
    revoked      = Column(Boolean, nullable=False, default=False)
    created_at   = Column(DateTime(timezone=True), nullable=False, server_default=func.now())