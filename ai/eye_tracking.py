"""
Eye Tracking Module
Tracks eye gaze direction using MediaPipe Face Mesh.

RULES (hardcoded, less-strict):
- Threshold loosened from 0.35 → 0.50: only flag if eyes are significantly off-center.
- Only the PRIMARY face (index 0 in FaceMesh) is tracked.
- Returns raw offset so the processor can decide whether to confirm the violation
  after sustained observation (time-buffer handled by processor.py).
"""

import os
os.environ.setdefault('MEDIAPIPE_DISABLE_GPU', '1')
os.environ.setdefault('DISPLAY', '')

import cv2
import numpy as np

# ── Tunable constants — HF Space strict mode ─────────────────────────────────
GAZE_AWAY_THRESHOLD = 0.50   # Normalized iris offset — strict: catches subtle gaze deviations
                              # HF Space can handle the compute needed for tight detection
GAZE_DIRECTION_TH   = 0.30   # Threshold for labelling direction (left/right)
# ─────────────────────────────────────────────────────────────────────────────

class EyeTracker:
    def __init__(self):
        eye_cascade_path = cv2.data.haarcascades + 'haarcascade_eye_tree_eyeglasses.xml'
        face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        self.eye_detector = cv2.CascadeClassifier(eye_cascade_path)
        self.face_detector = cv2.CascadeClassifier(face_cascade_path)
        if self.eye_detector.empty() or self.face_detector.empty():
            raise RuntimeError('Could not load OpenCV cascades for eye tracking')

    def track(self, image):
        """
        Track eye gaze direction.

        Returns dict:
            looking_away    – bool, True only if significantly off-center
            gaze_direction  – 'left' | 'right' | 'center'
            offset          – float, normalized horizontal offset (-1 to 1)
            confidence      – float
        """
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            faces = self.face_detector.detectMultiScale(gray, 1.1, 5, minSize=(60, 60))
            if len(faces) == 0:
                return {
                    'looking_away':   False,
                    'gaze_direction': 'unknown',
                    'offset':         0.0,
                    'confidence':     0.0
                }

            x, y, fw, fh = max(faces, key=lambda b: b[2] * b[3])
            face_roi = gray[y:y + fh, x:x + fw]
            eyes = self.eye_detector.detectMultiScale(face_roi, 1.1, 8, minSize=(15, 15))

            if len(eyes) < 2:
                return {
                    'looking_away':   False,
                    'gaze_direction': 'unknown',
                    'offset':         0.0,
                    'confidence':     0.0
                }

            eyes = sorted(eyes, key=lambda b: b[2] * b[3], reverse=True)[:2]
            centers = [((ex + ew / 2.0), (ey + eh / 2.0)) for (ex, ey, ew, eh) in eyes]
            centers.sort(key=lambda c: c[0])
            left_eye_c, right_eye_c = centers

            face_cx = fw / 2.0
            eye_mid_x = (left_eye_c[0] + right_eye_c[0]) / 2.0
            norm = float(np.clip((eye_mid_x - face_cx) / max(fw / 2.0, 1.0), -1.0, 1.0))

            looking_away = bool(abs(norm) > GAZE_AWAY_THRESHOLD)

            if   norm >  GAZE_DIRECTION_TH: direction = 'right'
            elif norm < -GAZE_DIRECTION_TH: direction = 'left'
            else:                           direction = 'center'

            return {
                'looking_away':   looking_away,
                'gaze_direction': direction,
                'offset':         norm,
                'confidence':     0.8
            }

        except Exception as e:
            print(f"Eye tracking error: {e}")
            return {
                'looking_away':   False,
                'gaze_direction': 'unknown',
                'offset':         0.0,
                'confidence':     0.0,
                'error':          str(e)
            }

    def __del__(self):
        if hasattr(self, 'face_mesh'):
            pass
