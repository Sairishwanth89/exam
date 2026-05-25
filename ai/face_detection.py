"""
Face Detection Module
Detects presence of faces and counts faces using MediaPipe.

RULES:
- Only the LARGEST face (closest to camera) is treated as the primary student.
- Background faces that are significantly smaller than the primary face are IGNORED.
  This prevents false positives from people/posters in the background.
- Multiple face flag only fires if a SECOND face is at least 40% the area of the primary.
- min_detection_confidence raised to 0.7 to reduce false detections.
"""

import os
os.environ.setdefault('MEDIAPIPE_DISABLE_GPU', '1')
os.environ.setdefault('DISPLAY', '')

import cv2
import mediapipe as mp

# ── Tunable constants (hardcoded rules) ──────────────────────────────────────
PRIMARY_FACE_MIN_CONFIDENCE = 0.70   # Minimum confidence to treat a face as real
SECONDARY_FACE_SIZE_RATIO   = 0.40   # Secondary must be ≥40% primary area to be flagged
# ─────────────────────────────────────────────────────────────────────────────

class FaceDetector:
    def __init__(self):
        self.mp_face_detection = mp.solutions.face_detection
        # model_selection=1 → full-range model (up to ~5m) so distant background
        # faces are still detected but we'll filter them by size.
        self.face_detection = self.mp_face_detection.FaceDetection(
            model_selection=1,
            min_detection_confidence=PRIMARY_FACE_MIN_CONFIDENCE
        )

    def detect(self, image):
        """
        Detect faces and determine primary student face.

        Returns dict:
            face_detected  – bool, True if a valid student face is found
            num_faces      – int, number of SIGNIFICANT faces (after filtering noise)
            confidence     – float, confidence of the primary face
            primary_area   – float, relative bounding-box area of primary face
        """
        try:
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results   = self.face_detection.process(image_rgb)

            if not results.detections:
                return {'face_detected': False, 'num_faces': 0, 'confidence': 0.0}

            h, w = image.shape[:2]
            frame_area = h * w

            # Collect (confidence, bbox_area) for each detected face
            faces = []
            for det in results.detections:
                conf = det.score[0]
                bb   = det.location_data.relative_bounding_box
                area = (bb.width * w) * (bb.height * h)  # pixel area
                faces.append({'conf': conf, 'area': area})

            # Sort by area descending — largest = closest = primary student
            faces.sort(key=lambda f: f['area'], reverse=True)
            primary = faces[0]

            if primary['conf'] < PRIMARY_FACE_MIN_CONFIDENCE:
                # Even the best face is below confidence threshold → ignore
                return {'face_detected': False, 'num_faces': 0, 'confidence': 0.0}

            # Count secondary faces that are large enough to be real people
            significant_secondary = [
                f for f in faces[1:]
                if f['area'] / primary['area'] >= SECONDARY_FACE_SIZE_RATIO
                and f['conf'] >= PRIMARY_FACE_MIN_CONFIDENCE
            ]

            num_significant = 1 + len(significant_secondary)

            return {
                'face_detected': True,
                'num_faces':     num_significant,
                'confidence':    float(primary['conf']),
                'primary_area':  float(primary['area'] / frame_area)
            }

        except Exception as e:
            print(f"Face detection error: {e}")
            return {'face_detected': False, 'num_faces': 0, 'confidence': 0.0, 'error': str(e)}

    def __del__(self):
        if hasattr(self, 'face_detection'):
            self.face_detection.close()
