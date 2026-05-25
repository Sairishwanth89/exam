@echo off
echo 🔄 Stopping containers...
docker-compose down

echo 🗑️ Cleaning old images...
docker rmi test-backend test-ai-proctor

echo 🏗️ Rebuilding and starting...
docker-compose up -d --build

echo ✅ Done! Application is restarting.
echo ⏳ Waiting for services to initialize...
timeout /t 10

echo 🚀 Opening Dashboard...
start http://localhost:3000

pause
