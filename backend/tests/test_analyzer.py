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

def test_detect_laravel_with_vite(tmp_path):
    """Laravel project has package.json (for Vite build tool) but should be detected as PHP"""
    # Laravel project structure
    (tmp_path / "package.json").write_text('{"name":"laravel-app","scripts":{"dev":"vite","build":"vite build"}}')
    (tmp_path / "composer.json").write_text('{"name":"laravel/laravel"}')
    (tmp_path / "artisan").write_text("#!/usr/bin/env php")
    
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    # Should detect PHP as primary, NOT Node.js
    assert info.primary_language == "php"
    assert info.primary_pm == "composer"

def test_detect_nodejs_with_actual_server(tmp_path):
    """Pure Node.js project should still be detected as Node.js even if it has dev script"""
    (tmp_path / "package.json").write_text('{"name":"node-app","scripts":{"start":"node server.js","dev":"nodemon server.js"}}')
    (tmp_path / "server.js").write_text("console.log('starting server')")
    
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "nodejs"