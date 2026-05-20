# Project Type Detection Fixes - April 21, 2026

## Issue: Laravel/PHP Projects Detected as Node.js

### Problem
When a PHP project (Laravel, Symfony, etc.) has a `package.json` file for build tools (Vite, Webpack, Laravel Mix), the assistant incorrectly identified it as a Node.js project instead of PHP.

### Root Causes
1. **Service Selection Priority**: The `_select_primary_service()` method prioritized frontend Node.js services over backend PHP services
2. **Build Tool vs App Confusion**: Package.json was treated as a runnable Node.js service even when it only contained build tool scripts (vite, webpack, mix)
3. **No Backend Language Check**: The `_is_runnable_node_service()` method didn't check if other backend languages were present

### Solution

#### Backend Changes (`app/core/analysis/project_analyzer.py`)

1. **Improved `_select_primary_service()` method**:
   - Now prefers backend services first (PHP, Python, Java, Ruby, Go)
   - Only uses frontend Node.js as a last resort
   - Eliminates false positives where build tools were treated as the main app

2. **Enhanced `_is_runnable_node_service()` method**:
   - Detects when package.json exists alongside other backend indicators
   - Only returns true if the script is actually running a Node.js server
   - Returns false if it's just running build tools

3. **New helper method `_is_node_server_script()`**:
   - Distinguishes between Node.js servers (node, nodemon, pm2, express, ts-node)
   - Filters out build tools (vite, webpack, gulp, mix, parcel, rollup, esbuild)

#### Test Coverage

Added test case: `test_detect_laravel_with_vite()` 
- Verifies Laravel projects with Vite are detected as PHP, not Node.js
- Also verifies pure Node.js projects are still correctly identified

```python
def test_detect_laravel_with_vite(tmp_path):
    """Laravel project has package.json (for Vite build tool) but should be detected as PHP"""
    (tmp_path / "package.json").write_text('{"name":"laravel-app","scripts":{"dev":"vite","build":"vite build"}}')
    (tmp_path / "composer.json").write_text('{"name":"laravel/laravel"}')
    (tmp_path / "artisan").write_text("#!/usr/bin/env php")
    
    info = ProjectAnalyzer().detect_project_type(tmp_path)
    assert info.primary_language == "php"
    assert info.primary_pm == "composer"
```

## Frontend Changes (`localInstaller.ts`)

### Python Library Project Support
Fixed the assistant failing to launch Python library projects (e.g., hanabi-learning-environment)

#### Changes:
- Added `isPythonLibraryProject()`: Detects libraries by checking for setup.py/pyproject.toml without app entry points
- Added `findPythonPackageDir()`: Locates the package directory structure
- Added `extractPackageName()`: Extracts package name from metadata files
- Added `findPythonExamples()`: Finds example files to run as demos
- Added `PythonLibraryProjectError`: Custom error for graceful library handling
- Updated `resolveRunCommand()`: Handles libraries with or without examples
- Updated launch error handler: Completes successfully for libraries without runnable entry points

#### Result:
- Libraries install successfully
- Libraries with examples run the first example as a demo
- User gets helpful message about importing the library

## Testing

### Test Results
```
tests/test_analyzer.py::test_detect_nodejs PASSED
tests/test_analyzer.py::test_detect_python PASSED
tests/test_analyzer.py::test_detect_nothing PASSED
tests/test_analyzer.py::test_detect_multiple PASSED
tests/test_analyzer.py::test_detect_node_entry_point_from_package_main PASSED
tests/test_analyzer.py::test_detect_laravel_with_vite PASSED          [NEW]
tests/test_analyzer.py::test_detect_nodejs_with_actual_server PASSED  [NEW]
```

All 7 tests pass ✓

## Impact

### Fixed Scenarios
- ✅ Laravel projects with Vite → Now detected as PHP
- ✅ Symfony with build tools → Now detected as PHP
- ✅ Other PHP projects with package.json → Now detected as PHP
- ✅ Python library projects → Now install successfully without requiring entry point
- ✅ Pure Node.js projects → Still correctly detected as Node.js

### Backwards Compatibility
- ✅ Pure Node.js projects unaffected
- ✅ Pure Python projects unaffected
- ✅ All existing project types work as before
