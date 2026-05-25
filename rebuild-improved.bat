@echo off
REM Rebuild Docker with improved face recognition
echo Stopping containers...
docker-compose down

echo Cleaning up...
docker system prune -f

echo Building and starting services with improved face verification...
docker-compose up -d --build

echo.
echo Waiting for services to start...
timeout /t 10

echo.
echo Services Status:
docker-compose ps

echo.
echo Access the application:
echo Frontend: http://localhost:3000
echo MongoDB: localhost:27017
echo AI Service: http://localhost:5000
echo.
echo Face Recognition Improvements Active:
echo - CNN-based face detection (more accurate)
echo - Large encoding model (99.38%% accuracy)
echo - Real-time person change warnings
echo - Enhanced violation logging
echo.
pause
