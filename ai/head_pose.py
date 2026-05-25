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
import mediapipe as mp
import numpy as np

# ── Hardcoded rule thresholds (degrees) ──────────────────────────────────────
YAW_THRESHOLD        = 45   # Head turned left/right. Was 35.
PITCH_DOWN_THRESHOLD = 40   # Head looking down (at lap/notes). Was 30.
PITCH_UP_THRESHOLD   = 35   # Head looking up (at ceiling/phone above). Was 25.
ROLL_THRESHOLD       = 50   # Head tilted sideways (very permissive — cosmetic)
# ─────────────────────────────────────────────────────────────────────────────

class HeadPoseEstimator:
    def __init__(self):
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=1,              # Only track primary face
            refine_landmarks=False,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.6
        )

        # 6 robust facial landmarks for PnP solve
        # Nose tip, chin, left eye corner, right eye corner, left mouth, right mouth
        self.POSE_LANDMARKS = [1, 152, 263, 33, 61, 291]

        # Standard 3D face model points (generic)
        self.model_points = np.array([
            (  0.0,    0.0,   0.0),   # Nose tip
            (  0.0, -330.0, -65.0),   # Chin
            (-225.0, 170.0,-135.0),   # Left eye corner
            ( 225.0, 170.0,-135.0),   # Right eye corner
            (-150.0,-150.0,-125.0),   # Left mouth corner
            ( 150.0,-150.0,-125.0)    # Right mouth corner
        ], dtype=np.float64)

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
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results   = self.face_mesh.process(image_rgb)

            if not results.multi_face_landmarks:
                return self._no_face()

            h, w      = image.shape[:2]
            landmarks = results.multi_face_landmarks[0]

            image_points = np.array([
                [int(landmarks.landmark[i].x * w),
                 int(landmarks.landmark[i].y * h)]
                for i in self.POSE_LANDMARKS
            ], dtype=np.float64)

            focal   = w
            cx, cy  = w / 2, h / 2
            cam_mtx = np.array([[focal,0,cx],[0,focal,cy],[0,0,1]], dtype=np.float64)
            dist    = np.zeros((4, 1))

            ok, rvec, tvec = cv2.solvePnP(
                self.model_points, image_points, cam_mtx, dist,
                flags=cv2.SOLVEPNP_ITERATIVE
            )
            if not ok:
                return self._no_face()

            R, _ = cv2.Rodrigues(rvec)
            yaw, pitch, roll = self._euler(R)

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

    def _euler(self, R):
        sy = np.sqrt(R[0,0]**2 + R[1,0]**2)
        if sy > 1e-6:
            x = np.arctan2( R[2,1], R[2,2])
            y = np.arctan2(-R[2,0], sy)
            z = np.arctan2( R[1,0], R[0,0])
        else:
            x = np.arctan2(-R[1,2], R[1,1])
            y = np.arctan2(-R[2,0], sy)
            z = 0
        return np.degrees(y), np.degrees(x), np.degrees(z)

    def __del__(self):
        if hasattr(self, 'face_mesh'):
            self.face_mesh.close()
