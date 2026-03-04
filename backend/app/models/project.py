from sqlalchemy import Column, String, Integer, DateTime, JSON
from sqlalchemy import Enum as SAEnum
from sqlalchemy.sql import func
from app.models.base import Base
import enum
 
class ProjectStatus(str, enum.Enum):
    queued     = 'queued'
    analyzing  = 'analyzing'
    installing = 'installing'
    running    = 'running'
    stopped    = 'stopped'
    failed     = 'failed'
 
class Project(Base):
    __tablename__ = 'projects'
 
    id         = Column(String(50), primary_key=True)
    name       = Column(String(255), nullable=False)
    type       = Column(String(50))        # nodejs, python, php ...
    path       = Column(String, nullable=False)
    status     = Column(SAEnum(ProjectStatus, name='projectstatus'), default=ProjectStatus.queued)
    port       = Column(Integer)
    pid        = Column(Integer)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    metadata_  = Column('metadata', JSON)  # JSONB in Postgres
