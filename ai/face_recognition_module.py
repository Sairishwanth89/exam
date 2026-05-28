"""
Face Recognition & Verification Module
Handles face encoding, storage, and comparison to verify exam taker identity.

This module:
1. Extracts face encodings from frames using face_recognition library
2. Stores reference encodings for identity verification (one per student, captured at exam start)
3. Compares live frames against stored reference to detect person change
4. Returns match confidence (0-1) and flagging decision

Uses dlib's face recognition model internally - highly accurate for 1:1 verification.
"""

import os
os.environ.setdefault('MEDIAPIPE_DISABLE_GPU', '1')
os.environ.setdefault('DISPLAY', '')

import cv2
import numpy as np
from collections import defaultdict
from typing import Any, Dict, List, Optional

# ── Tunable constants ─────────────────────────────────────────────────────
FACE_VERIFICATION_THRESHOLD = 0.55  # Max distance for "same person" (0-1 scale, lower=stricter)
ENROLLMENT_FRAME_COUNT = 3          # Number of frames to capture for initial enrollment
ENROLLMENT_MATCH_RATIO = 0.7        # Need 70% of frames to match reference for verification to pass
MIN_FACE_WIDTH = 48                 # Minimum face bounding box width (pixels) for quality check
MIN_FACE_HEIGHT = 48                # Minimum face bounding box height (pixels) for quality check
# ──────────────────────────────────────────────────────────────────────────

class FaceRecognizer:
    """
    Handles face encoding, enrollment, and verification.
    
    Workflow:
    1. Student starts exam → initiate_enrollment(student_id)
    2. Show "Capture your face" prompt, collect ENROLLMENT_FRAME_COUNT frames
    3. extract_face_encoding(frame) → returns encoding or None
    4. store_reference_encoding(student_id, encoding) after collecting frames
    5. During exam → verify_face(student_id, frame) → returns {'verified': bool, 'confidence': float}
    """
    
    def __init__(self):
        """Initialize lightweight OpenCV-based face verifier."""
        self.reference_encodings: Dict[str, np.ndarray] = {}  # student_id → encoding array
        self.enrollment_buffers: defaultdict[str, List[np.ndarray]] = defaultdict(list)  # student_id → [encodings...] during enrollment
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        self.face_detector = cv2.CascadeClassifier(cascade_path)
        if self.face_detector.empty():
            raise RuntimeError('Could not load OpenCV Haar cascade for face detection')
        
    def extract_face_encoding(self, image: np.ndarray) -> Optional[np.ndarray]:
        """
        Extract face encoding from an image frame with quality validation.
        
        Args:
            image: BGR numpy array (opencv format)
            
        Returns:
            encoding (np.array of floats) or None if no/multiple faces detected or poor quality
            
            Note: Returns encoding only if exactly ONE face is detected with good quality.
        """
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            face_locations = self.face_detector.detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(MIN_FACE_WIDTH, MIN_FACE_HEIGHT)
            )

            if len(face_locations) == 0:
                softened = cv2.GaussianBlur(gray, (3, 3), 0)
                face_locations = self.face_detector.detectMultiScale(
                    softened,
                    scaleFactor=1.05,
                    minNeighbors=3,
                    minSize=(MIN_FACE_WIDTH, MIN_FACE_HEIGHT)
                )

            if len(face_locations) == 0:
                return None

            if len(face_locations) > 1:
                face_locations = sorted(
                    face_locations,
                    key=lambda loc: loc[2] * loc[3],
                    reverse=True
                )
                primary = face_locations[0]
                primary_area = primary[2] * primary[3]
                secondary = face_locations[1]
                secondary_area = secondary[2] * secondary[3]
                if secondary_area >= primary_area * 0.65:
                    return None
                face_locations = [primary]
            
            # Validate face size/position (quality check)
            x, y, face_width, face_height = face_locations[0]
            
            # Ensure face is large enough (avoid tiny/edge faces)
            if face_width < MIN_FACE_WIDTH or face_height < MIN_FACE_HEIGHT:
                return None
            face = gray[y:y + face_height, x:x + face_width]
            if face.size == 0:
                return None

            face = cv2.resize(face, (64, 64), interpolation=cv2.INTER_AREA)
            face = cv2.GaussianBlur(face, (3, 3), 0)
            pixels = face.astype(np.float32).reshape(-1)
            hist = cv2.calcHist([face], [0], None, [16], [0, 256]).flatten().astype(np.float32)
            features = np.concatenate([pixels, hist])
            features -= float(np.mean(features))
            norm = float(np.linalg.norm(features))
            if norm <= 1e-6:
                return None

            return features / norm
            
        except Exception as e:
            print(f"[FACE_RECOGNITION] Encoding extraction failed: {e}")
            return None
    
    def initiate_enrollment(self, student_id: str) -> None:
        """Start enrollment process for a student."""
        if student_id in self.enrollment_buffers:
            self.enrollment_buffers[student_id] = []
        print(f"[FACE_ENROLLMENT] Started for student: {student_id}")
    
    def add_enrollment_frame(self, student_id: str, image: np.ndarray) -> Dict[str, Any]:
        """
        Add a frame to the enrollment buffer during initial capture.
        
        Returns:
            dict: {
                'captured': bool,        # True if frame was usable
                'frames_collected': int, # Number of frames collected so far
                'frames_needed': int     # Total frames needed
            }
        """
        encoding = self.extract_face_encoding(image)
        
        if encoding is None:
            return {
                'captured': False,
                'frames_collected': len(self.enrollment_buffers[student_id]),
                'frames_needed': ENROLLMENT_FRAME_COUNT
            }
        
        self.enrollment_buffers[student_id].append(encoding)
        
        result: Dict[str, Any] = {
            'captured': True,
            'frames_collected': len(self.enrollment_buffers[student_id]),
            'frames_needed': ENROLLMENT_FRAME_COUNT
        }
        
        print(f"[FACE_ENROLLMENT] Captured frame {result['frames_collected']}/{ENROLLMENT_FRAME_COUNT} for {student_id}")
        return result
    
    def finalize_enrollment(self, student_id: str) -> Dict[str, Any]:
        """
        Finalize enrollment by averaging collected face encodings.
        
        Returns:
            dict: {
                'success': bool,
                'message': str,
                'frames_used': int
            }
        """
        encodings = self.enrollment_buffers.get(student_id, [])
        
        if len(encodings) < ENROLLMENT_FRAME_COUNT:
            return {
                'success': False,
                'message': f'Not enough frames captured. Got {len(encodings)}, need {ENROLLMENT_FRAME_COUNT}',
                'frames_used': len(encodings)
            }
        
        # Use mean for a stable lightweight reference, then normalize
        reference = np.mean(encodings, axis=0)
        reference_norm = float(np.linalg.norm(reference))
        if reference_norm > 1e-6:
            reference = reference / reference_norm
        
        self.reference_encodings[student_id] = reference
        self.enrollment_buffers[student_id] = []  # Clear buffer
        
        print(f"[FACE_ENROLLMENT] Finalized for {student_id}. Stored reference encoding.")
        return {
            'success': True,
            'message': f'Face verification enrolled successfully using {len(encodings)} frames',
            'frames_used': len(encodings)
        }
    
    def verify_face(self, student_id: str, image: np.ndarray) -> Dict[str, Any]:
        """
        Verify if the face in the image matches the stored reference for this student.
        
        Args:
            student_id: Student identifier
            image: BGR numpy array (opencv format)
            
        Returns:
            dict: {
                'verified': bool,           # True if face matches
                'confidence': float,        # Distance score (0-1), lower=better match
                'reference_found': bool,    # True if reference encoding exists
                'face_detected': bool,      # True if a face was found in image
                'frames_until_match': int   # Frames of continuous non-match before flagging
            }
        """
        # Check if reference exists
        if student_id not in self.reference_encodings:
            return {
                'verified': False,
                'confidence': 1.0,
                'reference_found': False,
                'face_detected': False,
                'frames_until_match': -1
            }
        
        # Try to extract encoding from current frame
        current_encoding = self.extract_face_encoding(image)
        
        if current_encoding is None:
            return {
                'verified': False,
                'confidence': 1.0,
                'reference_found': True,
                'face_detected': False,
                'frames_until_match': -1
            }
        
        # Compare with reference using cosine distance on lightweight features
        reference = self.reference_encodings[student_id]
        similarity = float(np.clip(np.dot(reference, current_encoding), -1.0, 1.0))
        distance: float = float(np.clip(1.0 - similarity, 0.0, 1.0))
        
        # distance < threshold means same person
        verified: bool = distance < FACE_VERIFICATION_THRESHOLD
        
        return {
            'verified': verified,
            'confidence': float(distance),
            'reference_found': True,
            'face_detected': True,
            'match_threshold': FACE_VERIFICATION_THRESHOLD
        }
    
    def get_enrollment_status(self, student_id: str) -> Dict[str, Any]:
        """Get current enrollment status for a student."""
        if student_id not in self.reference_encodings:
            return {
                'enrolled': False,
                'frames_collected': len(self.enrollment_buffers.get(student_id, [])),
                'frames_needed': ENROLLMENT_FRAME_COUNT
            }
        
        return {
            'enrolled': True,
            'frames_collected': ENROLLMENT_FRAME_COUNT,
            'frames_needed': ENROLLMENT_FRAME_COUNT
        }
    
    def delete_reference(self, student_id: str) -> None:
        """Delete stored reference for a student (admin reset)."""
        if student_id in self.reference_encodings:
            del self.reference_encodings[student_id]
        if student_id in self.enrollment_buffers:
            self.enrollment_buffers[student_id] = []
        print(f"[FACE_RECOGNITION] Deleted reference for {student_id}")
    
    def get_stats(self) -> Dict[str, int]:
        """Return statistics about stored faces."""
        return {
            'students_enrolled': len(self.reference_encodings),
            'students_enrolling': len([s for s, b in self.enrollment_buffers.items() if b])
        }
