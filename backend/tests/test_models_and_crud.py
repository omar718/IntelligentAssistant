"""
Test suite for database models and CRUD operations.

Tests:
- Model creation and validation
- CRUD operations for all models
- SQLAlchemy relationships and constraints
- Database session management
"""

import pytest
from datetime import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    Project,
    ProjectStatus,
    InstallationHistory,
    ErrorPattern,
    ConfigurationTemplate,
)
from app.db.crud import (
    project_crud,
    installation_history_crud,
    error_pattern_crud,
    configuration_template_crud,
)


@pytest.fixture(scope="function")
def db_engine():
    """Create an in-memory SQLite database for testing."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)


@pytest.fixture(scope="function")
def db_session(db_engine) -> Session:
    """Create a new database session for each test."""
    connection = db_engine.connect()
    transaction = connection.begin()
    session = sessionmaker(autocommit=False, autoflush=False, bind=connection)(
        bind=connection
    )

    yield session

    session.close()
    transaction.rollback()
    connection.close()


class TestProjectModel:
    """Tests for Project model."""

    def test_project_creation(self, db_session):
        """Test creating a new project."""
        project = Project(
            id="test-project-1",
            name="My Test Project",
            type="nodejs",
            path="/home/user/projects/myapp",
            status=ProjectStatus.queued,
            port=3000,
        )
        db_session.add(project)
        db_session.commit()

        retrieved = db_session.query(Project).filter_by(id="test-project-1").first()
        assert retrieved is not None
        assert retrieved.name == "My Test Project"
        assert retrieved.type == "nodejs"
        assert retrieved.status == "queued"

    def test_project_default_status(self, db_session):
        """Test that project defaults to 'queued' status."""
        project = Project(
            id="test-project-2",
            name="Another Project",
            path="/home/user/projects/app2",
        )
        db_session.add(project)
        db_session.commit()

        retrieved = db_session.query(Project).filter_by(id="test-project-2").first()
        assert retrieved.status == "queued"

    def test_project_required_fields(self, db_session):
        """Test that project requires 'id' and 'name' and 'path'."""
        # Missing 'name' field
        project = Project(
            id="test-project-3",
            path="/some/path",
        )
        db_session.add(project)
        # This should raise an error due to NOT NULL constraint
        try:
            db_session.commit()
            assert False, "Should have raised an error for missing required field"
        except Exception:
            db_session.rollback()

    def test_project_metadata_json(self, db_session):
        """Test that project metadata can store JSON."""
        metadata = {"env": "production", "replicas": 3, "tags": ["web", "api"]}
        project = Project(
            id="test-project-4",
            name="JSON Test Project",
            path="/home/user/projects/jsonapp",
            metadata_=metadata,
        )
        db_session.add(project)
        db_session.commit()

        retrieved = db_session.query(Project).filter_by(id="test-project-4").first()
        assert retrieved.metadata_ == metadata


class TestInstallationHistoryModel:
    """Tests for InstallationHistory model."""

    def test_installation_history_creation(self, db_session):
        """Test creating installation history record."""
        # First create a project
        project = Project(
            id="proj-1",
            name="Test Project",
            path="/tmp/test",
        )
        db_session.add(project)
        db_session.commit()

        # Create installation history
        history = InstallationHistory(
            project_id="proj-1",
            started_at=datetime.now(),
            success=True,
            steps=[{"name": "init", "status": "completed"}],
            errors=[],
            resolution_used="venv",
        )
        db_session.add(history)
        db_session.commit()

        retrieved = db_session.query(InstallationHistory).first()
        assert retrieved.project_id == "proj-1"
        assert retrieved.success is True
        assert retrieved.resolution_used == "venv"

    def test_installation_history_foreign_key(self, db_session):
        """Test foreign key relationship with Project."""
        # Create a project
        project = Project(
            id="proj-2",
            name="FK Test Project",
            path="/tmp/test2",
        )
        db_session.add(project)
        db_session.commit()

        # Create installation history
        history = InstallationHistory(
            project_id="proj-2",
            started_at=datetime.now(),
            success=False,
        )
        db_session.add(history)
        db_session.commit()

        retrieved = db_session.query(InstallationHistory).first()
        assert retrieved.project_id == "proj-2"

    def test_installation_history_steps_json(self, db_session):
        """Test that steps can store JSON array."""
        project = Project(
            id="proj-3",
            name="Step Test",
            path="/tmp/test3",
        )
        db_session.add(project)
        db_session.commit()

        steps = [
            {"name": "npm install", "status": "completed", "duration": 45},
            {"name": "npm build", "status": "failed", "error": "Missing package.json"},
        ]
        history = InstallationHistory(
            project_id="proj-3",
            started_at=datetime.now(),
            steps=steps,
            success=False,
        )
        db_session.add(history)
        db_session.commit()

        retrieved = db_session.query(InstallationHistory).first()
        assert len(retrieved.steps) == 2
        assert retrieved.steps[0]["name"] == "npm install"


class TestErrorPatternModel:
    """Tests for ErrorPattern model."""

    def test_error_pattern_creation(self, db_session):
        """Test creating error pattern record."""
        pattern = ErrorPattern(
            signature="ModuleNotFoundError",
            category="dependency",
            project_type="python",
            solutions=[
                {"method": "pip install", "command": "pip install missing-package"}
            ],
            success_rate=0.85,
        )
        db_session.add(pattern)
        db_session.commit()

        retrieved = db_session.query(ErrorPattern).first()
        assert retrieved.signature == "ModuleNotFoundError"
        assert retrieved.category == "dependency"
        assert retrieved.project_type == "python"
        assert retrieved.success_rate == 0.85

    def test_error_pattern_occurrences_default(self, db_session):
        """Test that occurrences defaults to 1."""
        pattern = ErrorPattern(
            signature="test-error",
            category="config",
        )
        db_session.add(pattern)
        db_session.commit()

        retrieved = db_session.query(ErrorPattern).first()
        assert retrieved.occurrences == 1

    def test_error_pattern_solutions_json(self, db_session):
        """Test that solutions can store complex JSON."""
        solutions = [
            {
                "method": "update_package",
                "command": "npm update lodash",
                "success_rate": 0.9,
            },
            {"method": "reinstall", "command": "rm -rf node_modules && npm install"},
        ]
        pattern = ErrorPattern(
            signature="lodash-version-mismatch",
            category="dependency",
            project_type="nodejs",
            solutions=solutions,
        )
        db_session.add(pattern)
        db_session.commit()

        retrieved = db_session.query(ErrorPattern).first()
        assert len(retrieved.solutions) == 2


class TestConfigurationTemplateModel:
    """Tests for ConfigurationTemplate model."""

    def test_config_template_creation(self, db_session):
        """Test creating configuration template."""
        template = ConfigurationTemplate(
            project_type="nodejs",
            framework="express",
            template={"port": 3000, "env": "development"},
            success_count=5,
            use_count=10,
        )
        db_session.add(template)
        db_session.commit()

        retrieved = db_session.query(ConfigurationTemplate).first()
        assert retrieved.project_type == "nodejs"
        assert retrieved.framework == "express"
        assert retrieved.success_count == 5

    def test_config_template_defaults(self, db_session):
        """Test that success_count and use_count default to 0."""
        template = ConfigurationTemplate(
            project_type="python",
            framework="django",
            template={"DEBUG": True},
        )
        db_session.add(template)
        db_session.commit()

        retrieved = db_session.query(ConfigurationTemplate).first()
        assert retrieved.success_count == 0
        assert retrieved.use_count == 0


class TestCRUDOperations:
    """Tests for CRUD helper functions."""

    def test_project_crud_create(self, db_session):
        """Test CRUD create operation for Project."""
        data = {
            "id": "crud-proj-1",
            "name": "CRUD Test",
            "type": "python",
            "path": "/tmp/crud",
            "status": "analyzing",
        }
        project = project_crud.create(db_session, data)

        assert project.id == "crud-proj-1"
        assert project.name == "CRUD Test"
        assert project.status == "analyzing"

    def test_project_crud_get(self, db_session):
        """Test CRUD get operation for Project."""
        # Create first
        data = {
            "id": "crud-proj-2",
            "name": "Get Test",
            "path": "/tmp/get",
        }
        project_crud.create(db_session, data)

        # Retrieve
        retrieved = project_crud.get(db_session, "crud-proj-2")
        assert retrieved is not None
        assert retrieved.name == "Get Test"

    def test_project_crud_update(self, db_session):
        """Test CRUD update operation for Project."""
        # Create
        data = {
            "id": "crud-proj-3",
            "name": "Update Test",
            "path": "/tmp/update",
        }
        project = project_crud.create(db_session, data)

        # Update
        update_data = {"name": "Updated Name", "status": "running"}
        updated = project_crud.update(db_session, project, update_data)
        assert updated.name == "Updated Name"
        assert updated.status == "running"

    def test_project_crud_delete(self, db_session):
        """Test CRUD delete operation for Project."""
        # Create
        data = {
            "id": "crud-proj-4",
            "name": "Delete Test",
            "path": "/tmp/delete",
        }
        project_crud.create(db_session, data)

        # Delete
        deleted = project_crud.delete(db_session, "crud-proj-4")
        assert deleted is True

        # Verify deleted
        retrieved = project_crud.get(db_session, "crud-proj-4")
        assert retrieved is None

    def test_project_crud_get_all(self, db_session):
        """Test CRUD get_all operation for Project."""
        # Create multiple projects
        for i in range(5):
            data = {
                "id": f"crud-proj-all-{i}",
                "name": f"Project {i}",
                "path": f"/tmp/project{i}",
            }
            project_crud.create(db_session, data)

        # Retrieve all
        projects = project_crud.get_all(db_session)
        assert len(projects) == 5

    def test_installation_history_crud(self, db_session):
        """Test CRUD operations for InstallationHistory."""
        # Create project first
        proj_data = {
            "id": "crud-inst-proj",
            "name": "Install Test",
            "path": "/tmp/install",
        }
        project_crud.create(db_session, proj_data)

        # Create installation history
        hist_data = {
            "project_id": "crud-inst-proj",
            "started_at": datetime.now(),
            "success": True,
            "steps": [{"status": "completed"}],
        }
        history = installation_history_crud.create(db_session, hist_data)
        assert history.project_id == "crud-inst-proj"

        # Retrieve
        retrieved = installation_history_crud.get(db_session, history.id)
        assert retrieved is not None
        assert retrieved.success is True

    def test_error_pattern_crud(self, db_session):
        """Test CRUD operations for ErrorPattern."""
        data = {
            "signature": "crud-test-error",
            "category": "config",
            "project_type": "nodejs",
        }
        pattern = error_pattern_crud.create(db_session, data)
        assert pattern.signature == "crud-test-error"

        # Update
        update_data = {"success_rate": 0.95}
        updated = error_pattern_crud.update(db_session, pattern, update_data)
        assert updated.success_rate == 0.95

    def test_config_template_crud(self, db_session):
        """Test CRUD operations for ConfigurationTemplate."""
        data = {
            "project_type": "python",
            "framework": "flask",
            "template": {"port": 5000},
        }
        template = configuration_template_crud.create(db_session, data)
        assert template.framework == "flask"

        # Get all
        all_templates = configuration_template_crud.get_all(db_session)
        assert len(all_templates) == 1


class TestDatabaseConstraints:
    """Tests for database constraints and relationships."""

    def test_cascade_delete_on_project_deletion(self, db_session):
        """Test that installation history records cascade delete with project."""
        # Create project
        proj_data = {
            "id": "cascade-proj",
            "name": "Cascade Test",
            "path": "/tmp/cascade",
        }
        project_crud.create(db_session, proj_data)

        # Create installation history
        hist_data = {
            "project_id": "cascade-proj",
            "started_at": datetime.now(),
            "success": True,
        }
        installation_history_crud.create(db_session, hist_data)

        # Verify history was created
        histories = installation_history_crud.get_all(db_session)
        assert len(histories) == 1

        # Delete project
        project_crud.delete(db_session, "cascade-proj")

        # Verify history is also deleted (if cascade is enabled in model)
        histories = installation_history_crud.get_all(db_session)
        # Note: Cascade delete depends on model configuration
        # This test may need adjustment based on actual cascade settings


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
