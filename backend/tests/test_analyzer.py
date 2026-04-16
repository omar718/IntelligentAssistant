from app.core.analysis.project_analyzer import ProjectAnalyzer

def test_detect_nodejs(tmp_path):
    (tmp_path / "package.json").write_text('{"name": "test"}')
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "nodejs"
    assert info.primary_pm == "npm"

def test_detect_python(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi")
    (tmp_path / "app.py").write_text("print('ok')")
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "python"
    assert info.entry_point == "app.py"

def test_detect_nothing(tmp_path):
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language is None

def test_detect_multiple(tmp_path):
    (tmp_path / "package.json").write_text("{}")
    (tmp_path / "requirements.txt").write_text("requests")
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert len(info.types) == 2


def test_detect_node_entry_point_from_package_main(tmp_path):
    (tmp_path / "package.json").write_text('{"name":"x","main":"src/server.js"}')
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "server.js").write_text("console.log('ok')")

    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "nodejs"
    assert info.entry_point == "src/server.js"