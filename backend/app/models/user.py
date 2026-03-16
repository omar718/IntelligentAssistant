from sqlalchemy import Column, String, Boolean, DateTime
from app.models.base import Base
from sqlalchemy import Enum as SAEnum
from sqlalchemy.sql import func
import enum

class UserRole(enum.Enum):
    USER = "user"
    ADMIN = "admin"

class User(Base):
    __tablename__ = 'users'

    id           = Column(String(50), primary_key=True)
    name         = Column(String(255), nullable=False)
    email        = Column(String(255), unique=True, nullable=False)
    password_hash= Column(String(255), nullable=False)
    role         = Column(SAEnum(UserRole), default=UserRole.USER)
    is_active    = Column(Boolean, default=True, nullable=False)
    is_verified  = Column(Boolean, default=False, nullable=False)
    created_at   = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_login   = Column(DateTime(timezone=True), nullable=True)
