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
import mediapipe as mp
import numpy as np

# ── Tunable constants ─────────────────────────────────────────────────────────
GAZE_AWAY_THRESHOLD = 0.70   # Normalized offset to be considered "looking away"
                              # Raised to 0.70 to avoid random flags
GAZE_DIRECTION_TH   = 0.45   # Threshold for labelling direction (left/right)
# ─────────────────────────────────────────────────────────────────────────────

class EyeTracker:
    def __init__(self):
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=1,          # Only track the primary/closest face
            refine_landmarks=True,    # Needed for iris landmarks
            min_detection_confidence=0.6,
            min_tracking_confidence=0.6
        )

        # Iris landmark indices (MediaPipe Face Mesh)
        self.LEFT_IRIS  = [474, 475, 476, 477]
        self.RIGHT_IRIS = [469, 470, 471, 472]

        # Eye contour landmarks
        self.LEFT_EYE  = [362, 385, 387, 263, 373, 380]
        self.RIGHT_EYE = [33,  160, 158, 133, 153, 144]

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
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results   = self.face_mesh.process(image_rgb)

            if not results.multi_face_landmarks:
                return {
                    'looking_away':   False,
                    'gaze_direction': 'unknown',
                    'offset':         0.0,
                    'confidence':     0.0
                }

            landmarks = results.multi_face_landmarks[0]
            h, w = image.shape[:2]

            left_iris  = self._pos(landmarks, self.LEFT_IRIS[0],  w, h)
            right_iris = self._pos(landmarks, self.RIGHT_IRIS[0], w, h)

            left_eye_c  = self._eye_center(landmarks, self.LEFT_EYE,  w, h)
            right_eye_c = self._eye_center(landmarks, self.RIGHT_EYE, w, h)

            # Horizontal offset: positive = looking right, negative = looking left
            left_off  = left_iris[0]  - left_eye_c[0]
            right_off = right_iris[0] - right_eye_c[0]
            avg_off   = (left_off + right_off) / 2

            # Normalize: divide by ~10 px typical range, clip to [-1, 1]
            norm = float(np.clip(avg_off / 10.0, -1.0, 1.0))

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

    def _pos(self, landmarks, index, w, h):
        lm = landmarks.landmark[index]
        return (int(lm.x * w), int(lm.y * h))

    def _eye_center(self, landmarks, indices, w, h):
        pts = [self._pos(landmarks, i, w, h) for i in indices]
        return (sum(p[0] for p in pts) / len(pts),
                sum(p[1] for p in pts) / len(pts))

    def __del__(self):
        if hasattr(self, 'face_mesh'):
            self.face_mesh.close()
