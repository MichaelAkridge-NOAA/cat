@echo off
REM CAT Shortcut Creator for Windows
REM Double-click this file to create desktop shortcuts

echo.
echo ============================================================
echo   CAT: Coral Annotation Tool - Shortcut Creator
echo ============================================================
echo.

echo Checking if pyshortcuts is installed...
python -c "import pyshortcuts" 2>nul
if errorlevel 1 (
    echo.
    echo [!] pyshortcuts not found. Installing...
    pip install pyshortcuts
    if errorlevel 1 (
        echo.
        echo [X] Failed to install pyshortcuts
        echo.
        echo Please run manually:
        echo    pip install pyshortcuts
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Creating shortcuts...
python -m cat.shortcuts

echo.
echo ============================================================
echo   Done!
echo ============================================================
echo.
echo You should now have a CAT shortcut on your desktop and in
echo the Start Menu.
echo.
pause
