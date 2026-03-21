from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import TypeVar, Generic, Type, Optional, List, Any

ModelType = TypeVar("ModelType")


class CRUDBase(Generic[ModelType]):
    """Base class for async CRUD operations on any model."""

    def __init__(self, model: Type[ModelType]):
        self.model = model

    async def get(self, db: AsyncSession, id: Any) -> Optional[ModelType]:
        result = await db.execute(select(self.model).where(self.model.id == id))
        return result.scalar_one_or_none()

    async def get_all(self, db: AsyncSession, skip: int = 0, limit: int = 100) -> List[ModelType]:
        result = await db.execute(select(self.model).offset(skip).limit(limit))
        return result.scalars().all()

    async def create(self, db: AsyncSession, obj_in: dict) -> ModelType:
        db_obj = self.model(**obj_in)
        db.add(db_obj)
        await db.flush()
        await db.refresh(db_obj)
        return db_obj

    async def update(self, db: AsyncSession, db_obj: ModelType, obj_in: dict) -> ModelType:
        for field, value in obj_in.items():
            setattr(db_obj, field, value)
        db.add(db_obj)
        await db.flush()
        await db.refresh(db_obj)
        return db_obj

    async def delete(self, db: AsyncSession, id: Any) -> bool:
        stmt = delete(self.model).where(self.model.id == id)
        result = await db.execute(stmt)
        await db.flush()
        return result.rowcount > 0

    async def delete_obj(self, db: AsyncSession, db_obj: ModelType) -> None:
        await db.delete(db_obj)
        await db.flush()


from app.models import Project, InstallationHistory, ErrorPattern, ConfigurationTemplate

class ProjectCRUD(CRUDBase[Project]):
    pass

class InstallationHistoryCRUD(CRUDBase[InstallationHistory]):
    pass

class ErrorPatternCRUD(CRUDBase[ErrorPattern]):
    pass

class ConfigurationTemplateCRUD(CRUDBase[ConfigurationTemplate]):
    pass

project_crud = ProjectCRUD(Project)
installation_history_crud = InstallationHistoryCRUD(InstallationHistory)
error_pattern_crud = ErrorPatternCRUD(ErrorPattern)
configuration_template_crud = ConfigurationTemplateCRUD(ConfigurationTemplate)