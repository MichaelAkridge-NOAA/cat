@echo off
REM Startup script for CAT: Coral Annotation Tool (Windows)

echo ================================================
echo   CAT: Coral Annotation Tool
echo   File-based Orthomosaic Annotation
echo ================================================
echo.

REM Navigate to project root (one level up from scripts)
cd /d "%~dp0.."

REM Check if config.yaml exists
if not exist "config.yaml" (
    echo Warning: config.yaml not found. Using default configuration.
    echo.
)

REM Check if data directory exists
if not exist "data" (
    echo Creating data directory...
    mkdir data
)

REM Check if data/reference directory exists
if not exist "data\reference" (
    echo Creating data\reference directory...
    mkdir data\reference
)

echo Configuration:
echo    Project Root: %cd%
echo    Data Directory: %cd%\data
echo    Reference Data: %cd%\data\reference
echo.

REM Start server
REM Start CAT server...
echo.
echo    Web Interface: http://localhost:8000
echo    API Documentation: http://localhost:8000/docs
echo.
echo Press Ctrl+C to stop the server
echo.
python -m uvicorn cat.server:app --host 127.0.0.1 --port 8000 --reload
