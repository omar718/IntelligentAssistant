from sqlalchemy.orm import Session
from sqlalchemy import delete
from typing import TypeVar, Generic, Type, Optional, List, Any

ModelType = TypeVar("ModelType")


class CRUDBase(Generic[ModelType]):
    """Base class for CRUD operations on any model."""

    def __init__(self, model: Type[ModelType]):
        self.model = model

    def get(self, db: Session, id: Any) -> Optional[ModelType]:
        """Get a single record by ID."""
        return db.query(self.model).filter(self.model.id == id).first()

    def get_all(self, db: Session, skip: int = 0, limit: int = 100) -> List[ModelType]:
        """Get all records with pagination."""
        return db.query(self.model).offset(skip).limit(limit).all()

    def create(self, db: Session, obj_in: dict) -> ModelType:
        """Create a new record."""
        db_obj = self.model(**obj_in)
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def update(self, db: Session, db_obj: ModelType, obj_in: dict) -> ModelType:
        """Update an existing record."""
        for field, value in obj_in.items():
            setattr(db_obj, field, value)
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def delete(self, db: Session, id: Any) -> bool:
        """Delete a record by ID."""
        stmt = delete(self.model).where(self.model.id == id)
        result = db.execute(stmt)
        db.commit()
        return result.rowcount > 0

    def delete_obj(self, db: Session, db_obj: ModelType) -> None:
        """Delete a specific object."""
        db.delete(db_obj)
        db.commit()


# Initialize CRUD operations for each model
# These will be imported and used in route handlers

from app.models import Project, InstallationHistory, ErrorPattern, ConfigurationTemplate

# Project CRUD
class ProjectCRUD(CRUDBase[Project]):
    """CRUD operations for Project model."""
    pass

project_crud = ProjectCRUD(Project)


# InstallationHistory CRUD
class InstallationHistoryCRUD(CRUDBase[InstallationHistory]):
    """CRUD operations for InstallationHistory model."""
    pass

installation_history_crud = InstallationHistoryCRUD(InstallationHistory)


# ErrorPattern CRUD
class ErrorPatternCRUD(CRUDBase[ErrorPattern]):
    """CRUD operations for ErrorPattern model."""
    pass

error_pattern_crud = ErrorPatternCRUD(ErrorPattern)


# ConfigurationTemplate CRUD
class ConfigurationTemplateCRUD(CRUDBase[ConfigurationTemplate]):
    """CRUD operations for ConfigurationTemplate model."""
    pass

configuration_template_crud = ConfigurationTemplateCRUD(ConfigurationTemplate)
