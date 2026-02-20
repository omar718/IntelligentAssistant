from app.core.analysis.project_analyzer import ProjectAnalyzer

def test_detect_nodejs(tmp_path):
    (tmp_path / "package.json").write_text('{"name": "test"}')
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "nodejs"
    assert info.primary_pm == "npm"

def test_detect_python(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi")
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "python"

def test_detect_nothing(tmp_path):
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language is None

def test_detect_multiple(tmp_path):
    (tmp_path / "package.json").write_text("{}")
    (tmp_path / "requirements.txt").write_text("requests")
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert len(info.types) == 2