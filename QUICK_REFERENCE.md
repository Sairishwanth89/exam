# Face Verification - Quick Reference

## 🎯 What It Does

**Captures a student's face before the exam and detects if a different person is taking the exam.**

## 📦 What Was Added

### New Files
- `ai/face_recognition_module.py` - Face encoding & verification logic

### Modified Files
- `requirements.txt` - Added: `face-recognition`, `dlib`
- `ai/processor.py` - Added face verification in proctoring
- `server.js` - Added 4 enrollment endpoints
- `public/exam.html` - Added face verification modal UI
- `public/exam.js` - Added enrollment workflow
- `public/styles.css` - Added modal styling

### Documentation Files
- `FACE_VERIFICATION_GUIDE.md` - Complete technical guide
- `IMPLEMENTATION_SUMMARY.md` - Overview of changes

## 🏃 Quick Start

### 1. Update Dependencies
```bash
pip install -r requirements.txt
# Installs: face-recognition, dlib (includes pre-trained models)
```

### 2. Restart Services
```bash
docker-compose down
docker-compose up -d --build
```

### 3. Test
1. Go to exam page
2. Click "Start Exam"
3. **NEW**: Face Verification modal appears
4. Click "Start Capture"
5. Capture 3 face images (auto)
6. Click "Skip" or wait for success
7. Exam questions appear

## ⚙️ How It Works

| Stage | Duration | Action |
|-------|----------|--------|
| **Enrollment** | 2-3 sec | Capture 3 clear face images |
| **Setup** | Instant | Average encodings → Store reference |
| **During Exam** | Every 2.5s | Compare frame to reference |
| **Detection** | ~16 sec | After 8+ mismatches → Flag |

## 📊 What Gets Flagged

**Violation Type:** `face_mismatch`

**When:** Different person detected for 8+ frames (~16 seconds)

**What it looks like in report:**
```json
{
  "violation_type": "face_mismatch",
  "human_reason": "Different person detected - enrolled face does not match current frame",
  "timestamp": "2026-05-08T14:30:45Z"
}
```

## 🎛️ Configuration

### Adjust Sensitivity

**Stricter matching (fewer false passes):**
```python
# In ai/face_recognition_module.py
FACE_VERIFICATION_THRESHOLD = 0.50  # (was 0.55)
```

**More lenient (fewer false flags):**
```python
# In ai/face_recognition_module.py
FACE_VERIFICATION_THRESHOLD = 0.60  # (was 0.55)
```

**Faster detection:**
```python
# In ai/processor.py
FACE_MISMATCH_CONFIRM_FRAMES = 5  # (was 8, ~10 sec instead of 16)
```

## 🔍 API Endpoints

### Backend (Node.js)
```
POST /api/enroll/initiate
POST /api/enroll/capture
POST /api/enroll/finalize
GET  /api/enroll/status
```

### AI Service (Python)
```
POST /enroll/initiate/<student_id>
POST /enroll/capture/<student_id>
POST /enroll/finalize/<student_id>
GET  /enroll/status/<student_id>
POST /analyze (updated with face verification)
```

## 🐛 Troubleshooting

### "Face not captured"
- Move closer to camera
- Improve lighting
- Remove others from background
- Try different angle

### "Different person flagged incorrectly"
- Increase threshold to 0.60
- Ensure good lighting during enrollment
- Recapture with clearer frames

### AI service won't start
```bash
docker logs exam-ai-proctor
# Check for dlib/face-recognition install errors
```

## 📈 Proctoring Report Changes

**New field in `/api/proctor/report/:username`:**

```json
{
  "flags": [
    {
      "timestamp": "...",
      "violation_type": "face_mismatch",  // NEW
      "human_reason": "Different person detected...",
      "source": "ai_confirmed"
    }
  ]
}
```

## ✅ Verification Checklist

- [ ] Updated `requirements.txt`
- [ ] Rebuilt Docker images
- [ ] Accessed exam page → Face verification modal appears
- [ ] Enrollment completes successfully
- [ ] Exam questions appear after enrollment
- [ ] Proctoring report shows face violations

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| `FACE_VERIFICATION_GUIDE.md` | Complete technical guide (550+ lines) |
| `IMPLEMENTATION_SUMMARY.md` | What was changed & why |
| `PROCTORING_SETUP.md` | Overall proctoring system (existing) |
| This file | Quick reference |

## 🎓 Key Terms

- **Face Encoding**: 128-dimensional numerical vector representing a face
- **Face Distance**: Measure of difference (0-1 scale, lower=more similar)
- **Threshold**: Distance value (0.55) for same/different person decision
- **Enrollment**: Process of capturing reference face
- **Verification**: Process of comparing current face to reference

## 🚀 Deployment

### Standard (with Docker)
```bash
git pull
docker-compose down
docker-compose up -d --build
```

### Quick restart (code changes only)
```bash
docker-compose restart backend
```

### Quick restart (AI changes only)
```bash
docker-compose restart ai-proctor
```

## 🔐 Security Notes

- ✅ No face photos stored (only 128-D vectors)
- ✅ Runs locally (no external APIs)
- ✅ Works offline
- ✅ Encrypted model files
- ⚠️ Advanced spoofing (3D masks) not addressed

## 💡 Pro Tips

1. **Test without verification first** - Use "Skip" button during testing
2. **Monitor logs** - Check AI service logs for face capture events
3. **Adjust per exam** - Tighten/loosen threshold based on results
4. **Multiple angles** - Consider capturing reference with different angles (future enhancement)
5. **Lighting matters** - Consistent lighting crucial for accuracy

## ❓ FAQ

**Q: Is face data stored permanently?**
A: No. Encodings stored in RAM only (lost on server restart).

**Q: Can students skip face verification?**
A: Yes, but face mismatches can still be flagged during exam.

**Q: Does it work with glasses/masks?**
A: Yes, if changes are not extreme.

**Q: How accurate is it?**
A: 99.38% on standard LFW test (same person matches, different person rejected).

**Q: Is GPU required?**
A: No. Optimized for CPU-only execution.

## 📞 Support

- Check logs: `docker logs exam-ai-proctor`
- Review guide: `FACE_VERIFICATION_GUIDE.md`
- Check status: `GET /api/enroll/status`

---

**Version:** 1.0  
**Date:** May 8, 2026  
**Status:** Ready for production
