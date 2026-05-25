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
from PIL import Image
from io import BytesIO
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
# ─────────────────────────────────────────────────────────────────────────────


class DeviceDetector:
    """
    Detects electronic devices in the webcam frame:
    - Phones / tablets: bright rectangular bright-screen blobs
    - Earbuds / pods: small circular reflective blobs
    Uses purely OpenCV (no ML model needed — CPU-safe).
    """

    # Minimum pixel area fraction of frame for a bright rectangle to count
    PHONE_MIN_AREA_RATIO  = 0.010   # ~1% of frame
    PHONE_MAX_AREA_RATIO  = 0.45    # <45% (full frame = probably the room light)
    PHONE_RECT_THRESHOLD  = 0.70    # How rectangular the contour must be (solidity)
    PHONE_ASPECT_MIN      = 1.3     # Minimum aspect ratio (portrait phone)
    PHONE_ASPECT_MAX      = 4.5     # Maximum aspect ratio
    PHONE_BRIGHTNESS_LOW  = 180     # V-channel (HSV) threshold for bright screen

    EARBUD_MIN_AREA       = 60      # min blob pixel area
    EARBUD_MAX_AREA       = 800     # max blob pixel area
    EARBUD_CIRCULARITY    = 0.55    # how circular the blob must be
    EARBUD_PAIR_DIST_MAX  = 200     # max pixel dist between paired earbuds
    EARBUD_MIN_BRIGHTNESS = 160     # reflective plastic brightness

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

        phone_detected  = self._detect_phone(image, h, w, frame_area)
        earbud_detected = self._detect_earbuds(image)

        if phone_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'phone_or_screen',
                'device_count':    phone_detected['count'],
                'confidence':      min(1.0, phone_detected['confidence'])
            }
        if earbud_detected['found']:
            return {
                'device_detected': True,
                'device_type':     'earbud_or_pod',
                'device_count':    earbud_detected['count'],
                'confidence':      min(1.0, earbud_detected['confidence'])
            }
        return {'device_detected': False, 'device_type': 'none', 'device_count': 0, 'confidence': 0.0}

    def _detect_phone(self, image, h, w, frame_area):
        """Detect bright rectangular screen (phone/tablet/secondary laptop)."""
        try:
            hsv   = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
            # Mask very bright areas (screens glow)
            _, bright_mask = cv2.threshold(hsv[:, :, 2], self.PHONE_BRIGHTNESS_LOW, 255, cv2.THRESH_BINARY)
            # Morphological cleanup
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
            bright_mask = cv2.morphologyEx(bright_mask, cv2.MORPH_CLOSE, kernel)
            bright_mask = cv2.morphologyEx(bright_mask, cv2.MORPH_OPEN,  kernel)

            contours, _ = cv2.findContours(bright_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            found_rects = []
            for cnt in contours:
                area = cv2.contourArea(cnt)
                ratio = area / frame_area
                if ratio < self.PHONE_MIN_AREA_RATIO or ratio > self.PHONE_MAX_AREA_RATIO:
                    continue
                hull       = cv2.convexHull(cnt)
                hull_area  = cv2.contourArea(hull)
                solidity   = area / hull_area if hull_area > 0 else 0
                if solidity < self.PHONE_RECT_THRESHOLD:
                    continue
                rx, ry, rw, rh = cv2.boundingRect(cnt)
                aspect = max(rw, rh) / max(min(rw, rh), 1)
                if self.PHONE_ASPECT_MIN <= aspect <= self.PHONE_ASPECT_MAX:
                    found_rects.append({'area': area, 'solidity': solidity, 'aspect': aspect})

            if found_rects:
                best = max(found_rects, key=lambda r: r['solidity'])
                conf = best['solidity'] * min(1.0, best['area'] / (frame_area * 0.05))
                return {'found': True, 'count': len(found_rects), 'confidence': conf}
        except Exception as e:
            print(f"[DEVICE] Phone detection error: {e}")
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
        img    = Image.open(BytesIO(data))
        arr    = np.array(img)
        if len(arr.shape) == 3 and arr.shape[2] == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        return arr
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
    all_types = {'absent', 'multiple_faces', 'eyes_away', 'head_turned', 'looking_down', 'looking_up', 'face_mismatch'}
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
    'device_earbud':   'Wireless earbuds / pods detected (possible audio cheating)',
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

        # Check face verification if available
        if identity_check_result and not identity_check_result['verified']:
            # Face doesn't match - increment mismatch counter
            state['face_mismatch_counter'] += 1
            detect_ctx['face_confidence'] = round(identity_check_result['confidence'], 3)
            detect_ctx['face_threshold'] = FACE_VERIFICATION_THRESHOLD
            
            # Show warning as soon as possible for clear imposters
            if identity_check_result['confidence'] >= (FACE_VERIFICATION_THRESHOLD + FACE_MISMATCH_IMMEDIATE_DISTANCE):
                suspicious.add('face_mismatch')
                print(f"[FACE_MISMATCH] IMMEDIATE Student={student_id} | Confidence={identity_check_result['confidence']:.3f}", flush=True)
            elif state['face_mismatch_counter'] >= FACE_MISMATCH_CONFIRM_FRAMES:
                suspicious.add('face_mismatch')
                print(f"[FACE_MISMATCH] Student={student_id} | Counter={state['face_mismatch_counter']} reached threshold | Confidence: {identity_check_result['confidence']:.3f}", flush=True)
        else:
            # Face matches or verification not active - reset counter
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
            if dtype == 'phone_or_screen' and dconf >= 0.35:
                suspicious.add('device_phone')
                detect_ctx['device_type']       = dtype
                detect_ctx['device_confidence'] = round(dconf, 3)
                print(f"[DEVICE] Student={student_id} | phone/screen detected conf={dconf:.3f}", flush=True)
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
        device_confirmed        = 'device_phone' in confirmed or 'device_earbud' in confirmed
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
    app.run(host='0.0.0.0', port=5000, debug=False)
