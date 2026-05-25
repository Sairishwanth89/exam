@echo off
echo ========================================
echo   Stopping Exam Portal
echo ========================================
echo.

docker-compose down

if errorlevel 1 (
    echo ERROR: Failed to stop containers
    pause
    exit /b 1
)

echo.
echo ✓ All containers stopped successfully
echo.
pause
