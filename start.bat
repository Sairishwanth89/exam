@echo off
echo ========================================
echo   Exam Portal - Quick Start Script
echo ========================================
echo.

REM Check if Docker is running
echo [1/4] Checking Docker...
docker --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not installed or not running
    echo Please install Docker Desktop and try again
    pause
    exit /b 1
)
echo ✓ Docker is installed

REM Check if docker-compose is available
echo.
echo [2/4] Checking Docker Compose...
docker-compose --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Compose is not available
    pause
    exit /b 1
)
echo ✓ Docker Compose is available

REM Build and start containers
echo.
echo [3/4] Building and starting containers...
echo This may take 3-5 minutes on first run...
docker-compose up -d --build

if errorlevel 1 (
    echo.
    echo ERROR: Failed to start containers
    echo Check the error messages above
    pause
    exit /b 1
)

echo.
echo ✓ Containers started successfully

REM Wait for services to be ready
echo.
echo [4/4] Waiting for services to be ready...
timeout /t 10 /nobreak >nul

echo.
echo ========================================
echo   🎉 Application Started Successfully!
echo ========================================
echo.
echo 📝 Access the exam portal:
echo    http://localhost:3000
echo.
echo 👤 Demo credentials:
echo    Username: student
echo    Password: password
echo.
echo 📊 View logs:
echo    docker-compose logs -f
echo.
echo 🛑 Stop application:
echo    docker-compose down
echo.
echo Opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
pause
