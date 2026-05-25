# Basic Exam Website

A simple exam portal with login authentication, timed exams, and AI-powered proctoring. No external AI APIs used - all processing is local.

## Features

✅ **Frontend & Backend**
- Login page with user authentication
- Exam interface with MCQ and short-answer questions
- 10-minute countdown timer with visual warnings
- Real-time score calculation

✅ **Webcam Monitoring** 
- Webcam video feed on exam screen
- Frames captured every 2-3 seconds
- Automatic proctoring report generation

✅ **AI Proctoring (Local)**
- **Face Detection** - Detects if candidate present, flags multiple faces
- **Eye Tracking** - Monitors gaze direction, flags looking away
- **Head Pose Detection** - Detects head turns and unusual positioning
- **Proctoring Report** - Timestamped flags with risk assessment

## Project Structure

```
├── server.js                  # Express backend + AI proctoring API
├── package.json              # Node dependencies
├── requirements.txt          # Python dependencies
├── docker-compose.yml        # Docker orchestration
├── Dockerfile.node           # Node.js backend container
├── Dockerfile.python         # Python AI service container
├── public/
│   ├── index.html           # Login page
│   ├── exam.html            # Exam interface with webcam
│   ├── app.js               # Login logic
│   ├── exam.js              # Exam, timer, frame capture
│   └── styles.css           # Full styling
├── ai/                       # Python AI modules
│   ├── processor.py         # Main frame processor
│   ├── face_detection.py    # Face & multiple-face detection
│   ├── eye_tracking.py      # Eye gaze direction tracking
│   └── head_pose.py         # Head turn & tilt detection
└── data/                     # Created at runtime
    ├── users.json           # User credentials
    ├── answers.json         # Exam responses
    └── proctoring.json      # Proctoring flags & report
```

## Quick Start with Docker

### Prerequisites
- Docker Desktop installed
- Docker Compose installed

### 1. Start the Application
```bash
docker-compose up -d
```

This will:
- Build both backend and AI service containers
- Start all services
- Create necessary data directories
- Make the app available at http://localhost:3000

### 2. Check Status
```bash
docker-compose ps
```

### 3. View Logs
```bash
docker-compose logs -f
```

### 4. Stop the Application
```bash
docker-compose down
```

## Manual Setup (Without Docker)

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Install Python Dependencies
Requires Python 3.8+
```bash
pip install -r requirements.txt
```
This installs: OpenCV, MediaPipe, NumPy, Pillow, Flask

### 3. Start Backend Server
```bash
npm start
```
Server runs on `http://localhost:3000`

### 4. Start AI Service (in separate terminal)
```bash
python ai/processor.py
```
AI service runs on `http://localhost:5000`

### 5. Open in Browser
- Go to `http://localhost:3000`
- Login with any username/password (auto-creates user)
- **Allow camera access when prompted**
- Take the exam - webcam monitoring starts automatically

## Default Test Credentials
- **Username:** student
- **Password:** password

## API Endpoints

### POST /api/login
Login or create user account
```json
{
  "username": "student",
  "password": "password"
}
```

### GET /api/exam
Fetch exam questions and duration

### POST /api/submit
Submit completed exam with answers
```json
{
  "username": "student",
  "answers": {
    "1": 2,
    "2": 2,
    "3": "short answer text",
    "4": 1,
    "5": 2
  }
}
```

### POST /api/proctor/frame ⭐ NEW
Send webcam frame for proctoring analysis
```json
{
  "username": "student",
  "frame": "data:image/jpeg;base64,...",
  "timestamp": "2025-02-06T10:05:30.000Z"
}
```
**Auto-called every 2-3 seconds during exam**

### GET /api/proctor/report/:username ⭐ NEW
Get proctoring report for a student
```
GET /api/proctor/report/student
```
Returns flagged issues with timestamps and risk level

## Question Types

- **MCQ** - Multiple choice with 4 options
- **Short Answer** - Text input for written responses

## Proctoring System

### What Gets Monitored
- **Face Detection** - Ensures student is present and visible
  - Flags: "No face detected", "Multiple faces detected"
- **Eye Tracking** - Monitors where student is looking
  - Flags: "Eyes frequently looking away from screen"
- **Head Pose** - Detects unusual head positioning
  - Flags: "Head turned away", "Head looking down excessively"

### Access Reports
1. Via API: `GET http://localhost:3000/api/proctor/report/student`
2. In file: `data/proctoring.json`

### Risk Levels
- **HIGH** - 10+ flags (serious concern)
- **MEDIUM** - 5-10 flags (monitor)
- **LOW** - <5 flags (normal)

## Docker Commands Reference

### Build containers
```bash
docker-compose build
```

### Start in foreground (see logs)
```bash
docker-compose up
```

### Start in background
```bash
docker-compose up -d
```

### Stop containers
```bash
docker-compose down
```

### Rebuild and restart
```bash
docker-compose up -d --build
```

### View backend logs
```bash
docker-compose logs -f backend
```

### View AI service logs
```bash
docker-compose logs -f ai-proctor
```

### Clear data volumes
```bash
docker-compose down -v
```

## Technology Stack

- **Frontend:** Vanilla HTML, CSS, JavaScript
- **Backend:** Node.js, Express
- **Database:** MongoDB
- **AI/ML:** Python, OpenCV, MediaPipe
- **Deployment:** Docker, Docker Compose

## License

MIT

## For detailed proctoring setup, see [PROCTORING_SETUP.md](PROCTORING_SETUP.md)
