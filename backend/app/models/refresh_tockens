from sqlalchemy import Column, Integer, String, Boolean, DateTime, JSON, ForeignKey
from app.models.base import Base
from sqlalchemy import Enum as SAEnum
from sqlalchemy.sql import func
import enum

class RefreshToken(Base):
    __tablename__ = 'refresh_tokens'

    id           = Column(String(50), primary_key=True, autoincrement=True)
    token_hash   = Column(String(255), nullable=False)
    user_id      = Column(String(50), ForeignKey('users.id'))
    expires_at   = Column(DateTime, nullable=False)
    revoked      = Column(Boolean, default=False)
    created_at   = Column(DateTime, server_default=func.now())