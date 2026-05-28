"""
Head Pose Estimation Module
Estimates head orientation (yaw, pitch, roll) using MediaPipe Face Mesh.

RULES (hardcoded, relaxed compared to default):
- YAW_THRESHOLD:        35° (was 25°) — much more head turn needed before flagging
- PITCH_DOWN_THRESHOLD: 30° (was 20°) — allows looking at keyboard naturally
- PITCH_UP_THRESHOLD:   25° (was 15°) — allows leaning back slightly
- Only the primary/closest face (index 0) is analysed.

These values are conservative on purpose: a student shifting posture, reading
from the screen at an angle, or leaning back should NOT be flagged. Only
extreme and sustained head movement counts.
"""

import os
os.environ.setdefault('MEDIAPIPE_DISABLE_GPU', '1')
os.environ.setdefault('DISPLAY', '')

import cv2
import numpy as np

# ── Hardcoded rule thresholds (degrees) ──────────────────────────────────────
YAW_THRESHOLD        = 45   # Head turned left/right. Was 35.
PITCH_DOWN_THRESHOLD = 40   # Head looking down (at lap/notes). Was 30.
PITCH_UP_THRESHOLD   = 35   # Head looking up (at ceiling/phone above). Was 25.
ROLL_THRESHOLD       = 50   # Head tilted sideways (very permissive — cosmetic)
# ─────────────────────────────────────────────────────────────────────────────

class HeadPoseEstimator:
    def __init__(self):
        face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        eye_cascade_path = cv2.data.haarcascades + 'haarcascade_eye_tree_eyeglasses.xml'
        self.face_detector = cv2.CascadeClassifier(face_cascade_path)
        self.eye_detector = cv2.CascadeClassifier(eye_cascade_path)
        if self.face_detector.empty() or self.eye_detector.empty():
            raise RuntimeError('Could not load OpenCV cascades for head pose estimation')

    def estimate(self, image):
        """
        Estimate head pose angles and return violation flags with angles.

        Returns dict:
            head_turned  – bool
            looking_down – bool
            looking_up   – bool
            yaw, pitch, roll – float (degrees)
        """
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            faces = self.face_detector.detectMultiScale(gray, 1.1, 5, minSize=(60, 60))

            if len(faces) == 0:
                return self._no_face()

            x, y, fw, fh = max(faces, key=lambda b: b[2] * b[3])
            face_roi = gray[y:y + fh, x:x + fw]
            eyes = self.eye_detector.detectMultiScale(face_roi, 1.1, 8, minSize=(15, 15))
            if len(eyes) < 2:
                return self._no_face()

            eyes = sorted(eyes, key=lambda b: b[2] * b[3], reverse=True)[:2]
            left_eye, right_eye = sorted(eyes, key=lambda b: b[0])
            lx, ly, lw, lh = left_eye
            rx, ry, rw, rh = right_eye
            left_center = (lx + lw / 2.0, ly + lh / 2.0)
            right_center = (rx + rw / 2.0, ry + rh / 2.0)
            eye_mid_x = (left_center[0] + right_center[0]) / 2.0
            eye_mid_y = (left_center[1] + right_center[1]) / 2.0
            face_cx = fw / 2.0
            face_cy = fh / 2.0

            yaw = float(np.clip(((eye_mid_x - face_cx) / max(fw / 2.0, 1.0)) * 90.0, -90.0, 90.0))
            pitch = float(np.clip(((face_cy - eye_mid_y) / max(fh / 2.0, 1.0)) * 90.0, -90.0, 90.0))
            roll = float(np.degrees(np.arctan2((right_center[1] - left_center[1]), max((right_center[0] - left_center[0]), 1.0))))

            return {
                'head_turned':  bool(abs(yaw)  > YAW_THRESHOLD),
                'looking_down': bool(pitch      > PITCH_DOWN_THRESHOLD),
                'looking_up':   bool(pitch      < -PITCH_UP_THRESHOLD),
                'yaw':          float(yaw),
                'pitch':        float(pitch),
                'roll':         float(roll)
            }

        except Exception as e:
            print(f"Head pose error: {e}")
            return self._no_face()

    def _no_face(self):
        return {'head_turned': False, 'looking_down': False, 'looking_up': False,
                'yaw': 0.0, 'pitch': 0.0, 'roll': 0.0}

    def __del__(self):
        if hasattr(self, 'face_mesh'):
            pass
