from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.models.base import Base
 
 
class StackReport(Base):
    __tablename__ = "stack_reports"
 
    id                      = Column(Integer, primary_key=True, autoincrement=True)
    project_id              = Column(String(50), ForeignKey("projects.id"), nullable=False, index=True)
    installation_history_id = Column(Integer,    ForeignKey("installation_history.id"), nullable=True)
    r2_key                  = Column(String(500), nullable=False)   # e.g. "reports/proj_abc123/20260512-143000.pdf"
    created_at              = Column(DateTime, default=datetime.utcnow)
 
    project = relationship("Project", back_populates="stack_reports")
