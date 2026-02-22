from sqlalchemy import Column, Integer, String, Float, JSON
from app.models.base import Base
 
class ErrorPattern(Base):
    __tablename__ = 'error_patterns'
 
    id           = Column(Integer, primary_key=True, autoincrement=True)
    signature    = Column(String, nullable=False)  # regex or substring
    category     = Column(String(50))   # dependency | config | permission
    project_type = Column(String(50))   # nodejs | python | php ...
    solutions    = Column(JSON)          # List[Solution]
    occurrences  = Column(Integer, default=1)
    success_rate = Column(Float)
