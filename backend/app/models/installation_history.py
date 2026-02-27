from sqlalchemy import Column, Integer, String, Boolean, DateTime, JSON, ForeignKey
from app.models.base import Base
 
class InstallationHistory(Base):
    __tablename__ = 'installation_history'
 
    id              = Column(Integer, primary_key=True, autoincrement=True)
    project_id      = Column(String(50), ForeignKey('projects.id'))
    started_at      = Column(DateTime)
    completed_at    = Column(DateTime)
    success         = Column(Boolean)
    steps           = Column(JSON)   # Array of step objects
    errors          = Column(JSON)   # Array of error objects
    resolution_used = Column(String(50))  # local | venv | container
