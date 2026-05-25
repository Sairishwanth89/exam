 AI Proctoring System - Technical Setup Guide

This document provides detailed technical information about the AI-powered proctoring system used in the exam portal.

## Overview

The proctoring system uses **local AI processing** with no external API calls. All analysis happens in real-time using OpenCV and MediaPipe libraries.

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│   Browser   │ ───> │   Backend    │ ───> │   AI Service    │
│  (Webcam)   │      │  (Node.js)   │      │    (Python)     │
└─────────────┘      └──────────────┘      └─────────────────┘
     Video                 Frame                  Analysis
    Capture               Relay                  (MediaPipe)
```

## Technology Stack

### Backend Components
- **Node.js + Express**: Handles API requests and frame routing
- **Axios**: Forwards frames to Python AI service
- **JSON Storage**: Stores proctoring reports locally

### AI Components
- **Python 3.10**: Runtime environment
- **Flask**: Lightweight API server for AI processing
- **OpenCV**: Image processing and computer vision
- **MediaPipe**: Pre-trained ML models for face/pose detection
- **NumPy**: Numerical computations
- **Pillow**: Image handling

## AI Detection Modules

### 1. Face Detection (`face_detection.py`)

**Technology:** MediaPipe Face Detection

**What it detects:**
- Presence of human face
- Number of faces in frame
- Detection confidence scores

**Flags raised:**
- ❌ "No face detected" - Student not visible
- ❌ "Multiple faces detected (N)" - More than one person

**Parameters:**
- Model: Short-range (< 2 meters)
- Min confidence: 0.5 (50%)

**How it works:**
1. Converts image from BGR to RGB
2. Runs MediaPipe face detection model
3. Counts detected faces and calculates confidence
4. Returns detection results

### 2. Eye Tracking (`eye_tracking.py`)

**Technology:** MediaPipe Face Mesh (Iris Landmarks)

**What it detects:**
- Eye gaze direction (left, center, right)
- Iris position relative to eye boundaries
- Looking away behavior

**Flags raised:**
- ❌ "Eyes looking away from screen" - Gaze not centered

**Parameters:**
- Iris landmarks: 474-477 (left), 469-472 (right)
- Eye contours: 362-380 (left), 33-160 (right)
- Threshold: 0.25 (25% offset from center)

**How it works:**
1. Detects 478 facial landmarks including iris
2. Calculates iris center position
3. Compares with eye boundary center
4. Computes normalized horizontal offset (-1 to 1)
5. Flags if offset exceeds threshold

**Gaze Direction:**
- Center: -0.25 to 0.25
- Left: < -0.25
- Right: > 0.25

### 3. Head Pose Estimation (`head_pose.py`)

**Technology:** MediaPipe Face Mesh + OpenCV PnP Solver

**What it detects:**
- Head rotation angles (yaw, pitch, roll)
- Head turn left/right (yaw)
- Head tilt up/down (pitch)

**Flags raised:**
- ❌ "Head turned away (yaw: XX°)" - Excessive head rotation
- ❌ "Head looking down (pitch: XX°)" - Looking down at notes

**Parameters:**
- Yaw threshold: ±25° (head turned left/right)
- Pitch threshold down: +20° (looking down)
- Pitch threshold up: -15° (looking up)

**How it works:**
1. Extracts 6 key facial landmarks (nose, chin, eyes, mouth)
2. Uses generic 3D face model points
3. Solves Perspective-n-Point (PnP) problem with camera matrix
4. Converts rotation vector to Euler angles
5. Compares angles with thresholds

**Euler Angles:**
- **Yaw**: Head rotation left (-) or right (+)
- **Pitch**: Head tilt down (+) or up (-)
- **Roll**: Head tilt sideways

## Processing Flow

### Frame Capture (Frontend)
```javascript
// Captures frame every 2.5 seconds
setInterval(captureAndSendFrame, 2500);

function captureAndSendFrame() {
    // 1. Draw video frame to canvas
    ctx.drawImage(video, 0, 0);
    
    // 2. Convert to base64 JPEG
    const frameData = canvas.toDataURL('image/jpeg', 0.8);
    
    // 3. Send to backend
    fetch('/api/proctor/frame', {
        method: 'POST',
        body: JSON.stringify({
            username,
            frame: frameData,
            timestamp: new Date().toISOString()
        })
    });
}
```

### Backend Processing (server.js)
```javascript
app.post('/api/proctor/frame', async (req, res) => {
    // 1. Receive frame from frontend
    const { username, frame, timestamp } = req.body;
    
    // 2. Forward to AI service
    const aiResponse = await axios.post(`${AI_SERVICE_URL}/analyze`, {
        frame,
        timestamp
    });
    
    // 3. Store proctoring data
    proctoring[username].frames.push({
        timestamp,
        analysis: aiResponse.data
    });
    
    // 4. Store flags
    if (aiResponse.data.flags.length > 0) {
        proctoring[username].flags.push(...aiResponse.data.flags);
    }
});
```

### AI Analysis (processor.py)
```python
@app.route('/analyze', methods=['POST'])
def analyze_frame():
    # 1. Decode base64 image
    image = decode_base64_image(frame_base64)
    
    # 2. Run face detection
    face_result = face_detector.detect(image)
    
    # 3. Run eye tracking (if face found)
    if face_result['face_detected']:
        eye_result = eye_tracker.track(image)
    
    # 4. Run head pose estimation (if face found)
    if face_result['face_detected']:
        pose_result = head_pose_estimator.estimate(image)
    
    # 5. Collect all flags
    flags = []
    if not face_result['face_detected']:
        flags.append('No face detected')
    # ... more flag checks
    
    # 6. Return analysis
    return jsonify({
        'timestamp': timestamp,
        'flags': flags,
        'details': {...}
    })
```

## Docker Setup

### Container Architecture
```
┌────────────────────────────────────────┐
│          docker-compose.yml            │
│                                        │
│  ┌──────────────┐  ┌──────────────┐  │
│  │   backend    │  │  ai-proctor  │  │
│  │  (Node.js)   │  │   (Python)   │  │
│  │  Port 3000   │  │  Port 5000   │  │
│  └──────────────┘  └──────────────┘  │
│         │                  │          │
│         └──────────────────┘          │
│            exam-network                │
└────────────────────────────────────────┘
           │
           ▼
      ./data (volume)
```

### Health Checks

**Backend Health Check:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s CMD \
  node -e "require('http').get('http://localhost:3000/api/exam', ...)"
```

**AI Service Health Check:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s CMD \
  python -c "import urllib.request; ..."
```

## Data Storage

### users.json
```json
{
  "student": "password",
  "admin": "admin123"
}
```

### answers.json
```json
{
  "student": {
    "answers": {
      "1": 2,
      "2": 2,
      "3": "Docker is a containerization platform",
      "4": 0,
      "5": 2
    },
    "score": 4,
    "totalMCQ": 4,
    "percentage": 100,
    "timestamp": "2026-02-07T08:56:30.000Z"
  }
}
```

### proctoring.json
```json
{
  "student": {
    "frames": [
      {
        "timestamp": "2026-02-07T08:56:30.000Z",
        "analysis": {
          "flags": ["Eyes looking away from screen"],
          "details": {
            "face": {"face_detected": true, "num_faces": 1},
            "eyes": {"looking_away": true, "gaze_direction": "right"},
            "head_pose": {"yaw": -5.2, "pitch": 8.1}
          }
        }
      }
    ],
    "flags": [
      {
        "timestamp": "2026-02-07T08:56:30.000Z",
        "issue": "Eyes looking away from screen"
      }
    ]
  }
}
```

## Performance Considerations

### Frame Capture Rate
- **Interval**: 2.5 seconds (2500ms)
- **Reason**: Balance between detection accuracy and performance
- **Frames per 10-min exam**: ~240 frames

### Image Quality
- **Format**: JPEG
- **Quality**: 0.8 (80%)
- **Typical size**: 50-100 KB per frame
- **Total data**: ~12-24 MB per exam

### Processing Time
- **Face detection**: ~50-100ms
- **Eye tracking**: ~100-150ms
- **Head pose**: ~50-100ms
- **Total per frame**: ~200-350ms

### Resource Usage
- **Backend RAM**: ~50-100 MB
- **AI Service RAM**: ~300-500 MB (MediaPipe models)
- **CPU**: Low (< 10% on modern processors)

## Troubleshooting

### Issue: "No face detected" repeatedly
**Solutions:**
- Ensure good lighting
- Position face centered in webcam
- Check webcam quality
- Verify camera permissions

### Issue: Too many "Eyes looking away" flags
**Solutions:**
- Adjust `EYE_TRACKING_THRESHOLD` in `eye_tracking.py`
- Current: 0.25, try: 0.35 (more lenient)

### Issue: "Head turned" flags when looking straight
**Solutions:**
- Calibrate thresholds in `head_pose.py`
- Current yaw: ±25°, try: ±30°
- Verify webcam is at eye level

### Issue: AI service not responding
**Solutions:**
- Check Docker logs: `docker-compose logs ai-proctor`
- Verify Python dependencies installed
- Restart AI container: `docker-compose restart ai-proctor`

## Customization

### Adjust Capture Interval
In `public/exam.js`, line 114:
```javascript
// Change from 2500ms to desired interval
captureInterval = setInterval(captureAndSendFrame, 3000); // 3 seconds
```

### Adjust Detection Thresholds
In `ai/eye_tracking.py`:
```python
# Line 62: Change gaze threshold
looking_away = abs(normalized_offset) > 0.30  # More lenient
```

In `ai/head_pose.py`:
```python
# Lines 28-30: Change pose thresholds
self.YAW_THRESHOLD = 30  # Allow more head rotation
self.PITCH_THRESHOLD_DOWN = 25  # Allow more downward tilt
```

### Modify Risk Levels
In `server.js`, lines 162-166:
```javascript
let riskLevel = 'LOW';
if (totalFlags >= 15) {  // Changed from 10
    riskLevel = 'HIGH';
} else if (totalFlags >= 8) {  // Changed from 5
    riskLevel = 'MEDIUM';
}
```

## Security Considerations

### Data Privacy
- All processing happens locally
- No external API calls
- No data sent to third parties
- Webcam frames not permanently stored

### Recommendations
- Use HTTPS in production
- Implement proper password hashing (currently plaintext)
- Add JWT authentication for API
- Set CORS restrictions
- Implement rate limiting

## Future Enhancements

1. **Object Detection**: Detect phones, books, additional monitors
2. **Audio Monitoring**: Detect speaking/unusual sounds
3. **Tab Switching**: Detect when student switches tabs
4. **Advanced ML**: Train custom models for cheating patterns
5. **Real-time Alerts**: Notify proctors immediately on violations
6. **Dashboard**: Admin UI to monitor all students live

## References

- [MediaPipe Face Detection](https://google.github.io/mediapipe/solutions/face_detection.html)
- [MediaPipe Face Mesh](https://google.github.io/mediapipe/solutions/face_mesh.html)
- [OpenCV PnP Solver](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga549c2075fac14829ff4a58bc931c033d)
- [Head Pose Estimation Guide](https://learnopencv.com/head-pose-estimation-using-opencv-and-dlib/)

## Support

For issues or questions:
1. Check Docker logs: `docker-compose logs`
2. Verify all services running: `docker-compose ps`
3. Test endpoints manually with curl/Postman
4. Review browser console for frontend errors

---

**Last Updated:** 2026-02-07
**Version:** 1.0.0
