"""
Main AI Processor API — ProctorGuard
Receives frames from the Node backend and runs all proctoring detections.

────────────────────────────────────────────────────────────────────────────────
  HARDCODED PROCTORING RULES  (edit the constants below to tune behaviour)
────────────────────────────────────────────────────────────────────────────────

  RULE 1 — Background face ignore
      Handled in face_detection.py (secondary face must be ≥40% primary area).

  RULE 2 — Time-buffer before flagging ("sustained violation")
      A single bad frame is NEVER flagged immediately.
      Each violation type has a "sustained counter" per student.
      The counter increments every suspicious frame and resets on clean frames.
      A flag is only RAISED once the counter hits CONFIRM_FRAMES (default 4).
      At ~1 frame/2s, that means a violation must persist for ≥8 seconds.

  RULE 3 — Cooldown after flagging
      After a violation is confirmed and logged, a per-student cooldown prevents
      the SAME violation type from being logged again for COOLDOWN_FRAMES frames.
      This stops spam-logging the same event.

  RULE 4 — Absence tolerance
      "No face detected" is NOT flagged if the student just momentarily looked down.
      The absence counter must reach ABSENCE_CONFIRM_FRAMES (default 5) before
      flagging — roughly 10 seconds.

  RULE 5 — Looking-away eye only supplements head pose
      Eye gaze alone must sustain for GAZE_CONFIRM_FRAMES (default 5).
      Head pose flag is evaluated independently.

  RULE 6 — Failure audit trail
      Every confirmed violation is stored with:
          - timestamp
          - violation_type (machine key)
          - human_reason  (plain-English explanation for admin logs)
          - angles/metrics at time of violation

────────────────────────────────────────────────────────────────────────────────
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import os, base64, time
import numpy as np
import cv2
from collections import defaultdict

# Force MediaPipe to CPU-only BEFORE importing any mediapipe modules.
# Without this, MediaPipe tries to initialise an EGL/GPU context which
# crashes immediately in headless Docker containers with no display.
os.environ.setdefault('MEDIAPIPE_DISABLE_GPU', '1')
os.environ.setdefault('OPENCV_IO_MAX_IMAGE_PIXELS', '0')
os.environ.setdefault('DISPLAY', '')   # prevent any X11 attempt

from face_detection import FaceDetector
from eye_tracking   import EyeTracker
from head_pose      import HeadPoseEstimator
from face_recognition_module import FaceRecognizer, FACE_VERIFICATION_THRESHOLD

# ── Tunable rule constants ────────────────────────────────────────────────────
CONFIRM_FRAMES         = 10  # Frames a violation must sustain before being flagged
ABSENCE_CONFIRM_FRAMES = 12  # Frames of no-face before flagging student as absent
GAZE_CONFIRM_FRAMES    = 15  # Frames of looking-away before gaze flag fires
COOLDOWN_FRAMES        = 15  # Frames to suppress re-logging the same violation type
FACE_MISMATCH_CONFIRM_FRAMES = 2  # Frames of face mismatch before flagging identity change
FACE_MISMATCH_IMMEDIATE_DISTANCE = 0.12  # Extra gap above threshold for immediate mismatch flag
MAX_YAW_FOR_FACE_MATCH = 28.0     # Do not perform strict face mismatch while head is strongly turned
MAX_PITCH_FOR_FACE_MATCH = 22.0   # Do not perform strict face mismatch while looking too far up/down
# ─────────────────────────────────────────────────────────────────────────────


class DeviceDetector:
    """
    Detects electronic devices in the webcam frame:
    - Phones / tablets: bright rectangular bright-screen blobs
    - Earbuds / pods: small circular reflective blobs
    Uses purely OpenCV (no ML model needed — CPU-safe).
    """

    # Minimum pixel area fraction of frame for a bright rectangle to count
    PHONE_MIN_AREA_RATIO  = 0.002   # permissive enough for partially visible phones
    PHONE_MAX_AREA_RATIO  = 0.55    # allow tablets / large screens too
    PHONE_RECT_THRESHOLD  = 0.42    # rectangular enough to be a screen/device
    PHONE_ASPECT_MIN      = 1.05    # allow square-ish phones seen at angle
    PHONE_ASPECT_MAX      = 8.0     # broad range for rotated/tilted phones
    PHONE_BRIGHTNESS_LOW  = 155     # lower threshold catches dim screens
    PHONE_EDGE_MIN_AREA_RATIO = 0.002
    PHONE_EDGE_MAX_AREA_RATIO = 0.50
    PHONE_EDGE_RECT_RATIO     = 0.32
    PHONE_EDGE_ASPECT_MIN     = 1.00
    PHONE_EDGE_ASPECT_MAX     = 8.0
    PHONE_EDGE_MIN_CONF       = 0.12

    EARBUD_MIN_AREA       = 60      # min blob pixel area
    EARBUD_MAX_AREA       = 800     # max blob pixel area
    EARBUD_CIRCULARITY    = 0.55    # how circular the blob must be
    EARBUD_PAIR_DIST_MAX  = 200     # max pixel dist between paired earbuds
    EARBUD_MIN_BRIGHTNESS = 160     # reflective plastic brightness
    HEADPHONE_MIN_RADIUS      = 10
    HEADPHONE_MAX_RADIUS      = 180
    HEADPHONE_MIN_PAIR_DIST   = 35
    HEADPHONE_MAX_PAIR_DIST   = 620
    HEADPHONE_MAX_Y_DELTA      = 130

    WATCH_MIN_AREA_RATIO      = 0.0006
    WATCH_MAX_AREA_RATIO      = 0.020
    WATCH_ASPECT_MIN          = 0.70
    WATCH_ASPECT_MAX          = 2.20
    WATCH_RECT_MIN            = 0.50
    WATCH_SOLIDITY_MIN        = 0.50
    WATCH_BRIGHTNESS_LOW      = 145

    def __init__(self):
        face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        self.face_detector = cv2.CascadeClassifier(face_cascade_path)
        if self.face_detector.empty():
            raise RuntimeError('Could not load Haar cascade face detector for device context')

    def detect(self, image: np.ndarray) -> dict:
        """
        Returns:
            device_detected: bool
            device_type:     str  ("phone" | "earbud" | "none")
            device_count:    int
            confidence:      float 0-1
        """
        h, w = image.shape[:2]
        frame_area = h * w

        face_box = self._largest_face_box(image)

        phone_detected     = self._detect_phone(image, h, w, frame_area, face_box)
        headphone_detected  = self._detect_headphones(image, h, w, face_box)
        watch_detected      = self._detect_watch_or_wearable(image, h, w, frame_area)
        earbud_detected     = self._detect_earbuds(image)

        if phone_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'phone_or_screen',
                'device_count':    phone_detected['count'],
                'confidence':      min(1.0, phone_detected['confidence'])
            }
        if headphone_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'headphone_or_headset',
                'device_count':    headphone_detected['count'],
                'confidence':      min(1.0, headphone_detected['confidence'])
            }
        if watch_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'watch_or_wearable',
                'device_count':    watch_detected['count'],
                'confidence':      min(1.0, watch_detected['confidence'])
            }
        if earbud_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'earbud_or_pod',
                'device_count':    earbud_detected['count'],
                'confidence':      min(1.0, earbud_detected['confidence'])
            }
        return {'device_detected': False, 'device_type': 'none', 'device_count': 0, 'confidence': 0.0}

    def _largest_face_box(self, image):
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            gray = cv2.equalizeHist(gray)
            faces = self.face_detector.detectMultiScale(gray, 1.08, 4, minSize=(50, 50))
            if len(faces) == 0:
                return None
            x, y, fw, fh = max(faces, key=lambda b: b[2] * b[3])
            return (x, y, fw, fh)
        except Exception:
            return None

    def _intersects(self, box_a, box_b, min_overlap=0.12):
        ax, ay, aw, ah = box_a
        bx, by, bw, bh = box_b
        left = max(ax, bx)
        top = max(ay, by)
        right = min(ax + aw, bx + bw)
        bottom = min(ay + ah, by + bh)
        if right <= left or bottom <= top:
            return False
        intersection = (right - left) * (bottom - top)
        area_a = aw * ah
        area_b = bw * bh
        return intersection / max(min(area_a, area_b), 1) >= min_overlap

    def _detect_phone(self, image, h, w, frame_area, face_box=None):
        """Detect bright rectangular screen (phone/tablet/secondary laptop)."""
        try:
            hsv   = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
            gray  = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            # Mask very bright areas (screens glow)
            _, bright_mask = cv2.threshold(hsv[:, :, 2], self.PHONE_BRIGHTNESS_LOW, 255, cv2.THRESH_BINARY)
            _, dark_mask = cv2.threshold(gray, 85, 255, cv2.THRESH_BINARY_INV)
            # Morphological cleanup
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            bright_mask = cv2.morphologyEx(bright_mask, cv2.MORPH_CLOSE, kernel)
            bright_mask = cv2.morphologyEx(bright_mask, cv2.MORPH_OPEN,  kernel)
            dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_CLOSE, kernel)
            combined_mask = cv2.bitwise_or(bright_mask, dark_mask)

            candidates = []
            face_bottom = (face_box[1] + face_box[3]) if face_box else None
            for mask in (bright_mask, combined_mask):
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for cnt in contours:
                    area = cv2.contourArea(cnt)
                    ratio = area / frame_area
                    if ratio < self.PHONE_MIN_AREA_RATIO or ratio > self.PHONE_MAX_AREA_RATIO:
                        continue
                    hull       = cv2.convexHull(cnt)
                    hull_area  = cv2.contourArea(hull)
                    solidity   = area / hull_area if hull_area > 0 else 0
                    rx, ry, rw, rh = cv2.boundingRect(cnt)
                    aspect = max(rw, rh) / max(min(rw, rh), 1)
                    cx = rx + rw / 2
                    cy = ry + rh / 2
                    if face_box is not None and self._intersects((rx, ry, rw, rh), face_box, 0.08):
                        continue
                    if face_bottom is not None and cy < face_bottom + (0.02 * h):
                        continue
                    if cy < h * 0.28:
                        continue
                    if solidity >= self.PHONE_RECT_THRESHOLD and self.PHONE_ASPECT_MIN <= aspect <= self.PHONE_ASPECT_MAX:
                        score = solidity * min(1.0, ratio / 0.02)
                        candidates.append({'area': area, 'score': score, 'aspect': aspect})

            edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 45, 140)
            edges = cv2.dilate(edges, kernel, iterations=1)
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours:
                area = cv2.contourArea(cnt)
                ratio = area / frame_area
                if ratio < self.PHONE_EDGE_MIN_AREA_RATIO or ratio > self.PHONE_EDGE_MAX_AREA_RATIO:
                    continue

                perimeter = cv2.arcLength(cnt, True)
                if perimeter <= 0:
                    continue

                approx = cv2.approxPolyDP(cnt, 0.03 * perimeter, True)
                rx, ry, rw, rh = cv2.boundingRect(cnt)
                bbox_area = max(rw * rh, 1)
                rectangularity = area / bbox_area
                aspect = max(rw, rh) / max(min(rw, rh), 1)
                cx = rx + rw / 2
                cy = ry + rh / 2
                if face_box is not None and self._intersects((rx, ry, rw, rh), face_box, 0.08):
                    continue
                if face_box is not None and cy < (face_box[1] + face_box[3]) + (0.02 * h):
                    continue
                if cy < h * 0.28:
                    continue

                if len(approx) <= 8 and rectangularity >= self.PHONE_EDGE_RECT_RATIO and self.PHONE_EDGE_ASPECT_MIN <= aspect <= self.PHONE_EDGE_ASPECT_MAX:
                    score = rectangularity * min(1.0, ratio / 0.02)
                    if score >= self.PHONE_EDGE_MIN_CONF:
                        candidates.append({'area': area, 'score': score, 'aspect': aspect})

            if candidates:
                best = max(candidates, key=lambda r: r['score'])
                if face_box is None and best['score'] < 0.90:
                    return {'found': False, 'count': 0, 'confidence': 0.0}
                return {'found': True, 'count': len(candidates), 'confidence': best['score']}
        except Exception as e:
            print(f"[DEVICE] Phone detection error: {e}")
        return {'found': False, 'count': 0, 'confidence': 0.0}

    def _detect_watch_or_wearable(self, image, h, w, frame_area):
        """Detect smartwatch/smart-band like small rectangular gadgets."""
        try:
            hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

            _, bright = cv2.threshold(hsv[:, :, 2], self.WATCH_BRIGHTNESS_LOW, 255, cv2.THRESH_BINARY)
            edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 70, 180)
            merged = cv2.bitwise_or(bright, edges)

            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            merged = cv2.morphologyEx(merged, cv2.MORPH_CLOSE, kernel, iterations=2)
            merged = cv2.morphologyEx(merged, cv2.MORPH_OPEN, kernel, iterations=1)

            contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            candidates = []

            for cnt in contours:
                area = cv2.contourArea(cnt)
                ratio = area / frame_area
                if ratio < self.WATCH_MIN_AREA_RATIO or ratio > self.WATCH_MAX_AREA_RATIO:
                    continue

                x, y, rw, rh = cv2.boundingRect(cnt)
                if rw <= 0 or rh <= 0:
                    continue

                # Wrist gadgets are usually near lower half and toward side regions.
                cx = x + rw / 2
                cy = y + rh / 2
                if cy < h * 0.35:
                    continue
                if w * 0.30 < cx < w * 0.70 and cy < h * 0.70:
                    continue

                aspect = max(rw, rh) / max(min(rw, rh), 1)
                if not (self.WATCH_ASPECT_MIN <= aspect <= self.WATCH_ASPECT_MAX):
                    continue

                hull = cv2.convexHull(cnt)
                hull_area = cv2.contourArea(hull)
                solidity = area / hull_area if hull_area > 0 else 0
                bbox_area = max(rw * rh, 1)
                rectangularity = area / bbox_area

                if rectangularity < self.WATCH_RECT_MIN or solidity < self.WATCH_SOLIDITY_MIN:
                    continue

                conf = (rectangularity * 0.55) + (solidity * 0.45)
                candidates.append(conf)

            if candidates:
                return {'found': True, 'count': len(candidates), 'confidence': float(max(candidates))}
        except Exception as e:
            print(f"[DEVICE] Watch detection error: {e}")

        return {'found': False, 'count': 0, 'confidence': 0.0}

    def _detect_headphones(self, image, h, w, face_box=None):
        """Detect over-ear headphones / headsets using paired circle-like cups."""
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (7, 7), 1.5)

            candidates = []
            # Circular/oval cup detections from multiple Hough parameter sets.
            for dp, param2, min_dist in ((1.2, 18, 35), (1.4, 16, 28), (1.1, 14, 25)):
                circles = cv2.HoughCircles(
                    blurred,
                    cv2.HOUGH_GRADIENT,
                    dp=dp,
                    minDist=min_dist,
                    param1=70,
                    param2=param2,
                    minRadius=self.HEADPHONE_MIN_RADIUS,
                    maxRadius=self.HEADPHONE_MAX_RADIUS
                )
                if circles is None:
                    continue
                circles = np.round(circles[0, :]).astype(int)
                for x, y, r in circles:
                    if y < int(h * 0.08) or y > int(h * 0.92):
                        continue
                    if x < int(w * 0.02) or x > int(w * 0.98):
                        continue
                    area = np.pi * (r ** 2)
                    if area < 350 or area > 45000:
                        continue
                    candidates.append((x, y, r))

            # Ellipse-like contour fallback for cases where Hough misses the cups.
            edges = cv2.Canny(blurred, 35, 110)
            edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours:
                area = cv2.contourArea(cnt)
                if area < 250 or area > 60000:
                    continue
                x, y, rw, rh = cv2.boundingRect(cnt)
                if rw <= 0 or rh <= 0:
                    continue
                cx = x + rw / 2
                cy = y + rh / 2
                if cy < h * 0.08 or cy > h * 0.92:
                    continue
                if cx < w * 0.02 or cx > w * 0.98:
                    continue
                aspect = max(rw, rh) / max(min(rw, rh), 1)
                if aspect > 3.5:
                    continue
                perimeter = cv2.arcLength(cnt, True)
                if perimeter <= 0:
                    continue
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                if circularity >= 0.18:
                    r = int(max(rw, rh) / 2)
                    candidates.append((int(cx), int(cy), max(r, self.HEADPHONE_MIN_RADIUS)))

            if len(candidates) < 2:
                if len(candidates) == 1:
                    x, y, r = candidates[0]
                    if y < int(h * 0.92) and face_box is not None and abs(x - (face_box[0] + face_box[2] / 2)) <= face_box[2] * 1.2:
                        return {'found': True, 'count': 1, 'confidence': 0.42}
                return {'found': False, 'count': 0, 'confidence': 0.0}

            best_score = 0.0
            for i in range(len(candidates)):
                for j in range(i + 1, len(candidates)):
                    x1, y1, r1 = candidates[i]
                    x2, y2, r2 = candidates[j]
                    x_dist = abs(x1 - x2)
                    y_dist = abs(y1 - y2)
                    if y_dist > self.HEADPHONE_MAX_Y_DELTA:
                        continue
                    if x_dist < self.HEADPHONE_MIN_PAIR_DIST or x_dist > self.HEADPHONE_MAX_PAIR_DIST:
                        continue
                    if face_box is not None:
                        face_cx = face_box[0] + face_box[2] / 2
                        face_cy = face_box[1] + face_box[3] / 2
                        if abs(((x1 + x2) / 2) - face_cx) > face_box[2] * 1.3:
                            continue
                        if ((y1 + y2) / 2) < face_cy - (face_box[3] * 0.25):
                            continue
                    radius_similarity = 1.0 - min(abs(r1 - r2) / max(r1, r2), 1.0)
                    pair_score = radius_similarity * 0.55 + min(1.0, x_dist / self.HEADPHONE_MIN_PAIR_DIST) * 0.45
                    if pair_score > best_score:
                        best_score = pair_score

            if best_score > 0:
                if face_box is None and best_score < 0.70:
                    return {'found': False, 'count': 0, 'confidence': 0.0}
                return {'found': True, 'count': 2, 'confidence': max(best_score, 0.45)}
        except Exception as e:
            print(f"[DEVICE] Headphone detection error: {e}")
        return {'found': False, 'count': 0, 'confidence': 0.0}

    def _detect_earbuds(self, image):
        """Detect small bright circular blobs (earbuds, AirPods, TWS pods)."""
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            _, thresh = cv2.threshold(gray, self.EARBUD_MIN_BRIGHTNESS, 255, cv2.THRESH_BINARY)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)

            contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            blobs = []
            for cnt in contours:
                area = cv2.contourArea(cnt)
                if not (self.EARBUD_MIN_AREA <= area <= self.EARBUD_MAX_AREA):
                    continue
                perimeter = cv2.arcLength(cnt, True)
                if perimeter == 0:
                    continue
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                if circularity >= self.EARBUD_CIRCULARITY:
                    M = cv2.moments(cnt)
                    if M['m00'] > 0:
                        cx = int(M['m10'] / M['m00'])
                        cy = int(M['m01'] / M['m00'])
                        blobs.append({'cx': cx, 'cy': cy, 'area': area, 'circ': circularity})

            # Require at least 2 nearby circular blobs (left + right earbud)
            if len(blobs) >= 2:
                for i in range(len(blobs)):
                    for j in range(i + 1, len(blobs)):
                        dist = np.sqrt((blobs[i]['cx'] - blobs[j]['cx'])**2 +
                                       (blobs[i]['cy'] - blobs[j]['cy'])**2)
                        if dist <= self.EARBUD_PAIR_DIST_MAX:
                            conf = (blobs[i]['circ'] + blobs[j]['circ']) / 2
                            return {'found': True, 'count': 1, 'confidence': conf}
        except Exception as e:
            print(f"[DEVICE] Earbud detection error: {e}")
        return {'found': False, 'count': 0, 'confidence': 0.0}


app = Flask(__name__)
CORS(app)

face_detector      = FaceDetector()
eye_tracker        = EyeTracker()
head_pose_estimator= HeadPoseEstimator()
face_recognizer    = FaceRecognizer()
device_detector    = DeviceDetector()

# ── Per-student state (in-memory, resets when server restarts) ────────────────
# student_id → dict of counters and cooldowns per violation type
student_state = defaultdict(lambda: {
    'counters':  defaultdict(int),   # violation_type → consecutive suspicious frames
    'cooldowns': defaultdict(int),   # violation_type → frames remaining in cooldown
    'violations': [],                 # confirmed violation log entries
    'identity_verified': False,       # True if face enrollment completed
    'face_mismatch_counter': 0       # Counter for sustained face mismatch
})


def decode_frame(b64_str):
    """Decode base64 frame string to BGR numpy array."""
    try:
        if ',' in b64_str:
            b64_str = b64_str.split(',')[1]
        data   = base64.b64decode(b64_str)
        arr    = np.frombuffer(data, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as e:
        print(f"Frame decode error: {e}")
        return None


def tick_counters(state, suspicious_types: set, detect_ctx: dict) -> list:
    """
    Update per-student counters and return list of newly confirmed violations.

    Args:
        state          – student-level state dict
        suspicious_types – set of violation type keys seen THIS frame
        detect_ctx     – dict with metrics (yaw, pitch, etc.) for the log
    Returns:
        list of (violation_type, human_reason) tuples that just confirmed
    """
    all_types = {
        'absent', 'multiple_faces', 'eyes_away', 'head_turned', 'looking_down', 'looking_up', 'face_mismatch',
        'device_phone', 'device_headphone', 'device_earbud', 'device_watch'
    }
    newly_confirmed = []

    for vtype in all_types:
        # Tick down cooldown
        if state['cooldowns'][vtype] > 0:
            state['cooldowns'][vtype] -= 1

        if vtype in suspicious_types:
            state['counters'][vtype] += 1
        else:
            # Clean frame for this type — reset counter (no sustained behaviour)
            state['counters'][vtype] = 0

        # Determine confirm threshold per type
        threshold = ABSENCE_CONFIRM_FRAMES if vtype == 'absent' \
                    else (GAZE_CONFIRM_FRAMES if vtype == 'eyes_away' \
                    else (FACE_MISMATCH_CONFIRM_FRAMES if vtype == 'face_mismatch' \
                    else CONFIRM_FRAMES))

        # Confirm if threshold reached and not in cooldown
        if state['counters'][vtype] >= threshold and state['cooldowns'][vtype] == 0:
            newly_confirmed.append(vtype)
            state['cooldowns'][vtype] = COOLDOWN_FRAMES  # suppress for a while
            state['counters'][vtype] = 0                 # reset counter

    return newly_confirmed


HUMAN_REASONS = {
    'absent':          'Student was absent from camera for an extended period',
    'multiple_faces':  'Multiple people detected in the exam environment',
    'eyes_away':       'Student sustained gaze away from the screen',
    'head_turned':     'Student sustained extreme head-turn away from screen',
    'looking_down':    'Student looking down (possible notes/phone on lap)',
    'looking_up':      'Student looking up (possible notes above screen)',
    'face_mismatch':   'Different person detected - enrolled face does not match current frame',
    'device_phone':    'Mobile phone or electronic screen detected in frame',
    'device_headphone':'Headphones / headset detected in frame',
    'device_earbud':   'Wireless earbuds / pods detected (possible audio cheating)',
    'device_watch':    'Smart watch / wearable electronic gadget detected in frame',
}


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy', 'service': 'AI Proctoring'}), 200


@app.route('/analyze', methods=['POST'])
def analyze_frame():
    """Primary analysis endpoint called per webcam frame."""
    try:
        data         = request.json
        frame_b64    = data.get('frame')
        timestamp    = data.get('timestamp', time.time() * 1000)
        student_id   = data.get('studentId', 'unknown')

        if not frame_b64:
            return jsonify({'error': 'No frame provided'}), 400

        image = decode_frame(frame_b64)
        if image is None:
            return jsonify({'error': 'Invalid image data'}), 400

        # ── Run detectors ────────────────────────────────────────────────────
        face_result   = face_detector.detect(image)
        device_result = device_detector.detect(image)
        face_valid    = face_result.get('face_detected') and face_result.get('confidence', 0) >= 0.70

        eye_result  = None
        pose_result = None
        if face_valid:
            eye_result  = eye_tracker.track(image)
            pose_result = head_pose_estimator.estimate(image)

        # ── Face Verification (check if same person as enrolled) ─────────────
        state = student_state[student_id]
        identity_check_result = None
        if state.get('identity_verified') and face_result.get('face_detected'):
            # Only verify when exactly one face is in frame (avoid confusion with multiple people)
            num_faces = face_result.get('num_faces', 1)
            if num_faces == 1:
                identity_check_result = face_recognizer.verify_face(student_id, image)
                print(f"[FACE_VERIFY] Student={student_id} | enrolled=True | verified={identity_check_result.get('verified')} | dist={identity_check_result.get('confidence', '?'):.3f}", flush=True)

        # ── Determine suspicious types THIS frame ─────────────────────────
        suspicious = set()
        detect_ctx = {}

        if not face_result.get('face_detected'):
            suspicious.add('absent')
            state['face_mismatch_counter'] = 0  # Reset face mismatch counter if no face

        elif face_result.get('num_faces', 1) > 1:
            suspicious.add('multiple_faces')
            detect_ctx['num_faces'] = face_result['num_faces']
            state['face_mismatch_counter'] = 0  # Reset on multiple faces

        # Check face verification if available.
        # Important: avoid mismatch flagging while head is strongly turned/down/up.
        if identity_check_result and not identity_check_result['verified']:
            yaw = abs((pose_result or {}).get('yaw', 0.0))
            pitch = abs((pose_result or {}).get('pitch', 0.0))
            frontal_enough = yaw <= MAX_YAW_FOR_FACE_MATCH and pitch <= MAX_PITCH_FOR_FACE_MATCH

            detect_ctx['face_confidence'] = round(identity_check_result['confidence'], 3)
            detect_ctx['face_threshold'] = FACE_VERIFICATION_THRESHOLD
            detect_ctx['face_pose_ok'] = frontal_enough

            if frontal_enough:
                state['face_mismatch_counter'] += 1

                if identity_check_result['confidence'] >= (FACE_VERIFICATION_THRESHOLD + FACE_MISMATCH_IMMEDIATE_DISTANCE):
                    suspicious.add('face_mismatch')
                    print(f"[FACE_MISMATCH] IMMEDIATE Student={student_id} | Confidence={identity_check_result['confidence']:.3f}", flush=True)
                elif state['face_mismatch_counter'] >= FACE_MISMATCH_CONFIRM_FRAMES:
                    suspicious.add('face_mismatch')
                    print(f"[FACE_MISMATCH] Student={student_id} | Counter={state['face_mismatch_counter']} reached threshold | Confidence: {identity_check_result['confidence']:.3f}", flush=True)
            else:
                # Don't let steep head turns accumulate mismatch state.
                state['face_mismatch_counter'] = 0
                print(f"[FACE_MISMATCH] Suppressed due to pose | yaw={yaw:.1f}, pitch={pitch:.1f}", flush=True)
        else:
            state['face_mismatch_counter'] = 0

        if eye_result and eye_result.get('looking_away'):
            suspicious.add('eyes_away')
            detect_ctx['gaze_offset'] = eye_result.get('offset', 0)

        if pose_result:
            if pose_result.get('head_turned'):
                suspicious.add('head_turned')
                detect_ctx['yaw'] = round(pose_result['yaw'], 1)
            if pose_result.get('looking_down'):
                suspicious.add('looking_down')
                detect_ctx['pitch'] = round(pose_result['pitch'], 1)
            if pose_result.get('looking_up'):
                suspicious.add('looking_up')
                detect_ctx['pitch'] = round(pose_result.get('pitch', 0), 1)

        # ── Device detection (always runs, regardless of face state) ────────────
        if device_result.get('device_detected'):
            dtype = device_result.get('device_type', 'unknown')
            dconf = device_result.get('confidence', 0)
            if dtype == 'phone_or_screen' and dconf >= 0.30:
                suspicious.add('device_phone')
                detect_ctx['device_type']       = dtype
                detect_ctx['device_confidence'] = round(dconf, 3)
                print(f"[DEVICE] Student={student_id} | phone/screen detected conf={dconf:.3f}", flush=True)
            elif dtype == 'headphone_or_headset' and dconf >= 0.30:
                suspicious.add('device_headphone')
                detect_ctx['device_type']       = dtype
                detect_ctx['device_confidence'] = round(dconf, 3)
                print(f"[DEVICE] Student={student_id} | headphone/headset detected conf={dconf:.3f}", flush=True)
            elif dtype == 'watch_or_wearable' and dconf >= 0.36:
                suspicious.add('device_watch')
                detect_ctx['device_type']       = dtype
                detect_ctx['device_confidence'] = round(dconf, 3)
                print(f"[DEVICE] Student={student_id} | watch/wearable detected conf={dconf:.3f}", flush=True)
            elif dtype == 'earbud_or_pod' and dconf >= 0.40:
                suspicious.add('device_earbud')
                detect_ctx['device_type']       = dtype
                detect_ctx['device_confidence'] = round(dconf, 3)
                print(f"[DEVICE] Student={student_id} | earbud/pod detected conf={dconf:.3f}", flush=True)

        # ── Apply time-buffer state machine ───────────────────────────────
        confirmed = tick_counters(state, suspicious, detect_ctx)

        # ── Build flags list (only confirmed violations surface to backend) ─
        flags         = []
        new_log_entries = []

        for vtype in confirmed:
            reason = HUMAN_REASONS.get(vtype, vtype)
            flags.append(reason)

            log_entry = {
                'timestamp':      timestamp,
                'violation_type': vtype,
                'human_reason':   reason,
                'metrics':        detect_ctx.copy()
            }
            state['violations'].append(log_entry)
            new_log_entries.append(log_entry)
            print(f"[CONFIRMED] Student={student_id} | {vtype}: {reason} | ctx={detect_ctx}", flush=True)

        if not flags and not suspicious:
            print(f"[OK] Student={student_id} | All clear.", flush=True)
        elif not flags and suspicious:
            print(f"[WATCHING] Student={student_id} | Suspicious: {suspicious} (not yet confirmed)", flush=True)

        # ── Surface face_mismatch as immediate warning to client ────────────────────
        face_mismatch_confirmed = 'face_mismatch' in confirmed
        device_confirmed        = 'device_phone' in confirmed or 'device_headphone' in confirmed or 'device_earbud' in confirmed or 'device_watch' in confirmed
        device_type_label       = detect_ctx.get('device_type', 'none')

        return jsonify({
            'timestamp': timestamp,
            'flags':     flags,
            'face_mismatch_warning': face_mismatch_confirmed,
            'device_warning':        device_confirmed,
            'device_type':           device_type_label,
            'details': {
                'face':      face_result,
                'eyes':      eye_result    if face_valid else None,
                'head_pose': pose_result   if face_valid else None,
                'device':    device_result,
            },
            'newly_confirmed':   new_log_entries,
            'total_violations':  len(state['violations'])
        }), 200

    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e), 'flags': []}), 500


@app.route('/violation_log/<student_id>', methods=['GET'])
def get_violation_log(student_id):
    """
    Return the full confirmed violation log for a student.
    Used by Node backend /api/proctor/report/:username.
    Includes human-readable reasons so admin can see WHY the student failed.
    """
    state = student_state.get(student_id, {})
    violations = state.get('violations', []) if state else []
    return jsonify({
        'student_id': student_id,
        'violations': violations,
        'total':      len(violations),
        'risk_level': _risk_level(len(violations))
    }), 200


@app.route('/reset/<student_id>', methods=['POST'])
def reset_student(student_id):
    """Reset state for a student (admin-triggered reset)."""
    if student_id in student_state:
        del student_state[student_id]
    return jsonify({'success': True, 'message': f'State reset for {student_id}'}), 200


@app.route('/enroll/initiate/<student_id>', methods=['POST'])
def initiate_face_enrollment(student_id):
    """Initiate face enrollment for identity verification."""
    try:
        face_recognizer.initiate_enrollment(student_id)
        state = student_state[student_id]
        state['identity_verified'] = False
        
        return jsonify({
            'success': True,
            'message': 'Face enrollment initiated',
            'frames_needed': 3,
            'student_id': student_id
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/enroll/capture/<student_id>', methods=['POST'])
def capture_enrollment_frame(student_id):
    """Capture and store a frame during enrollment."""
    try:
        data = request.json
        frame_b64 = data.get('frame')
        
        if not frame_b64:
            return jsonify({'error': 'No frame provided'}), 400
        
        image = decode_frame(frame_b64)
        if image is None:
            return jsonify({'error': 'Invalid image data'}), 400
        
        result = face_recognizer.add_enrollment_frame(student_id, image)
        
        return jsonify({
            'captured': result['captured'],
            'frames_collected': result['frames_collected'],
            'frames_needed': result['frames_needed'],
            'status': f"{result['frames_collected']}/{result['frames_needed']} frames captured"
        }), 200
    
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/enroll/finalize/<student_id>', methods=['POST'])
def finalize_face_enrollment(student_id):
    """Finalize enrollment and enable identity verification."""
    try:
        result = face_recognizer.finalize_enrollment(student_id)
        
        if result['success']:
            state = student_state[student_id]
            state['identity_verified'] = True
            state['face_mismatch_counter'] = 0
            print(f"[ENROLLMENT] Face enrollment COMPLETED for {student_id}", flush=True)
        
        return jsonify(result), 200 if result['success'] else 400
    
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/enroll/status/<student_id>', methods=['GET'])
def get_enrollment_status(student_id):
    """Get current enrollment status for a student."""
    try:
        status = face_recognizer.get_enrollment_status(student_id)
        state_status = student_state.get(student_id, {}).get('identity_verified', False)
        status['identity_verification_active'] = state_status
        
        return jsonify(status), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/stats', methods=['GET'])
def get_stats():
    """Get service statistics."""
    try:
        face_stats = face_recognizer.get_stats()
        return jsonify({
            'service': 'ProctorGuard AI',
            'face_recognition': face_stats,
            'active_students': len([s for s, st in student_state.items() if st.get('violations')])
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _risk_level(count):
    if count == 0: return 'NONE'
    if count <= 2: return 'LOW'
    if count <= 5: return 'MEDIUM'
    return 'HIGH'


if __name__ == '__main__':
    print("=" * 60)
    print(" ProctorGuard AI Service - WITH FACE RECOGNITION")
    print(f" Rules: confirm={CONFIRM_FRAMES} frames | cooldown={COOLDOWN_FRAMES} frames")
    print(f"        absent={ABSENCE_CONFIRM_FRAMES} frames | gaze={GAZE_CONFIRM_FRAMES} frames")
    print(f"        face_mismatch={FACE_MISMATCH_CONFIRM_FRAMES} frames")
    print("=" * 60)
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '5000')), debug=False)
