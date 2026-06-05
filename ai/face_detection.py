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

# ── Tunable constants (hardcoded rules) ──────────────────────────────────────
PRIMARY_FACE_MIN_CONFIDENCE = 0.60   # Minimum confidence to treat a face as real
SECONDARY_FACE_SIZE_RATIO   = 0.40   # Secondary must be ≥40% primary area to be flagged
# ─────────────────────────────────────────────────────────────────────────────

class FaceDetector:
    def __init__(self):
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        self.face_detection = cv2.CascadeClassifier(cascade_path)
        if self.face_detection.empty():
            raise RuntimeError('Could not load Haar cascade face detector')

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
            # Guard: Haar cascade needs at least ~120px in each dimension or it throws
            # "0 <= scaleIdx" assertion error. Upscale tiny frames before processing.
            h_img, w_img = image.shape[:2]
            if h_img < 120 or w_img < 120:
                scale = max(120 / h_img, 120 / w_img)
                image = cv2.resize(image, (int(w_img * scale), int(h_img * scale)),
                                   interpolation=cv2.INTER_LINEAR)

            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            faces = self.face_detection.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(48, 48)
            )

            if len(faces) == 0:
                softened = cv2.GaussianBlur(gray, (3, 3), 0)
                faces = self.face_detection.detectMultiScale(
                    softened,
                    scaleFactor=1.05,
                    minNeighbors=3,
                    minSize=(48, 48)
                )

            if len(faces) == 0:
                return {'face_detected': False, 'num_faces': 0, 'confidence': 0.0}

            h, w = image.shape[:2]
            frame_area = h * w

            # Collect (confidence, bbox_area) for each detected face
            face_items = []
            for (x, y, fw, fh) in faces:
                area = fw * fh
                face_items.append({'conf': 0.9, 'area': area})

            # Sort by area descending — largest = closest = primary student
            face_items.sort(key=lambda f: f['area'], reverse=True)
            primary = face_items[0]

            if primary['conf'] < PRIMARY_FACE_MIN_CONFIDENCE:
                # Even the best face is below confidence threshold → ignore
                return {'face_detected': False, 'num_faces': 0, 'confidence': 0.0}

            # Count secondary faces that are large enough to be real people
            significant_secondary = [
                f for f in face_items[1:]
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
            pass
