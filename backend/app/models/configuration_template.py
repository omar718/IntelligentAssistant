from sqlalchemy import Column, Integer, String, JSON
from app.models.base import Base
 
class ConfigurationTemplate(Base):
    __tablename__ = 'configuration_templates'
 
    id           = Column(Integer, primary_key=True, autoincrement=True)
    project_type = Column(String(50))
    framework    = Column(String(100))
    template     = Column(JSON)
    success_count = Column(Integer, default=0)
    use_count    = Column(Integer, default=0)
