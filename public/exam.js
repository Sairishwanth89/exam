// Exam page logic
let examData = null;
let answers = {};
let timerInterval = null;
let webcamStream = null;
let captureInterval = null;
const username = sessionStorage.getItem('username');
// When the student interacts with a question, suppress short proctor warnings
let recentlyAnsweredUntil = 0;

let clientFlags = [];
let tabSwitchCount = 0;
const MAX_TAB_SWITCHES = 3;
let submitInProgress = false;

// Face verification variables
let faceVerificationStream = null;
let faceVerificationActive = false;
let framesCollected = 0;
const FRAMES_NEEDED_FOR_VERIFICATION = 3;

// ── Cheat Score ───────────────────────────────────────────────
let cheatScore = 100;
const THRESHOLD_WARNINGS_SHOWN = new Set(); // track which thresholds already alerted

function getScoreClass(score) {
    if (score >= 90) return 'safe';
    if (score >= 70) return 'warn';
    return 'danger';
}
function getClassificationLabel(score) {
    if (score >= 90) return 'Safe';
    if (score >= 70) return 'Suspicious';
    return 'Cheating Detected';
}

function updateCheatScoreUI(score) {
    cheatScore = score;
    const cls    = getScoreClass(score);
    const label  = getClassificationLabel(score);

    const valEl  = document.getElementById('csValue');
    const barEl  = document.getElementById('csBarFill');
    const classEl= document.getElementById('csClassification');

    if (valEl)  { valEl.textContent = score + '%'; valEl.className = 'cs-value ' + cls; }
    if (barEl)  { barEl.style.width = score + '%'; barEl.className = 'cs-bar-fill ' + cls; }
    if (classEl){ classEl.textContent = label; classEl.className = 'cs-classification ' + cls; }

    // Threshold banners (fire once each)
    if (score <= 60 && !THRESHOLD_WARNINGS_SHOWN.has(60)) {
        THRESHOLD_WARNINGS_SHOWN.add(60);
        showThresholdBanner('⚠️ Critical: Integrity score is very low! You may be disqualified.', true);
    } else if (score <= 75 && !THRESHOLD_WARNINGS_SHOWN.has(75)) {
        THRESHOLD_WARNINGS_SHOWN.add(75);
        showThresholdBanner('⚠️ Warning: Your integrity score is dropping. Please follow exam rules.', false);
    } else if (score <= 90 && !THRESHOLD_WARNINGS_SHOWN.has(90)) {
        THRESHOLD_WARNINGS_SHOWN.add(90);
        showThresholdBanner('⚠️ Notice: A violation was detected. Your integrity score has been reduced.', false);
    }
}

function addCheatScoreDeductionEntry(reason, deduction, scoreAfter) {
    const box = document.getElementById('csDeductions');
    if (!box) return;
    // Clear the "no violations" placeholder on first entry
    if (box.querySelector('div[style]')) box.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'cs-deduct-item';
    item.innerHTML = `<span class="deduct-label">${reason}</span><span class="deduct-neg">−${deduction}%</span>`;
    box.prepend(item); // Most recent at top
}

function showThresholdBanner(message, isDanger) {
    const existing = document.getElementById('thresholdBanner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'thresholdBanner';
    banner.className = 'threshold-banner' + (isDanger ? ' danger-banner' : '');
    banner.innerHTML = `<span>${isDanger ? '🚨' : '⚠️'}</span><span>${message}</span>`;
    document.body.appendChild(banner);
    setTimeout(() => {
        banner.style.transition = 'opacity 0.5s';
        banner.style.opacity = '0';
        setTimeout(() => banner.remove(), 500);
    }, 4000);
}

// ── No-person / device overlay ───────────────────────────────
function showProctorOverlay(icon, title, sub) {
    const ov = document.getElementById('proctorOverlay');
    if (!ov) return;
    document.getElementById('overlayIcon').textContent  = icon;
    document.getElementById('overlayTitle').textContent = title;
    document.getElementById('overlaySub').textContent   = sub;
    ov.style.display = 'flex';
}
function hideProctorOverlay() {
    const ov = document.getElementById('proctorOverlay');
    if (ov) ov.style.display = 'none';
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleTabSwitch();
});
window.addEventListener('blur', () => {
    handleTabSwitch();
});

function handleTabSwitch() {
    if (!timerInterval) return; // Only if exam started
    if (window._tabLostTime && Date.now() - window._tabLostTime < 2000) return;
    window._tabLostTime = Date.now();

    tabSwitchCount++;
    clientFlags.push(`Tab switch or window minimized (Warning ${tabSwitchCount})`);

    if (tabSwitchCount >= MAX_TAB_SWITCHES) {
        showToast("Exam terminated due to multiple tab switches!", true);
        submitExam(true);
    } else {
        alert(`WARNING: Switching tabs or leaving the exam window is strictly prohibited!\n\nWarning ${tabSwitchCount} of ${MAX_TAB_SWITCHES}`);
    }
}

// Redirect if not logged in
if (!username) {
    window.location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', async () => {
    // Display student name
    document.getElementById('studentName').textContent = `Student: ${username}`;

    // Load exam
    await loadExam();

    // Initialize webcam
    await initWebcam();

    // Setup submit button
    document.getElementById('submitBtn').addEventListener('click', submitExam);
});

// Load exam questions
async function loadExam() {
    try {
        // Pick up the examId set by the dashboard when student clicked ATTEMPT
        const examId = sessionStorage.getItem('currentExamId');
        const url = examId ? `/api/exam?examId=${examId}` : '/api/exam';
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token')}` }
        });
        examData = await response.json();

        // Update page title if exam has a title
        if (examData.title) {
            document.querySelector('.exam-header h1').textContent = examData.title;
        }

        displayQuestions(examData.questions);
        // Timer is started in initWebcam after user passes the system check
    } catch (error) {
        console.error('Failed to load exam:', error);
        alert('Failed to load exam. Please refresh the page.');
    }
}

// Display questions
function displayQuestions(questions) {
    const container = document.getElementById('questionsContainer');

    questions.forEach((q, index) => {
        const questionDiv = document.createElement('div');
        questionDiv.className = 'question-card';

        if (q.type === 'mcq') {
            questionDiv.innerHTML = `
                <div class="question-header">
                    <span class="question-number">Question ${index + 1}</span>
                    <span class="question-type">Multiple Choice</span>
                </div>
                <p class="question-text">${q.question}</p>
                <div class="options">
                    ${q.options.map((option, i) => `
                        <label class="option">
                            <input type="radio" name="q${q.id}" value="${i}" onchange="saveAnswer(${q.id}, ${i})">
                            <span>${option}</span>
                        </label>
                    `).join('')}
                </div>
            `;
        } else if (q.type === 'short') {
            questionDiv.innerHTML = `
                <div class="question-header">
                    <span class="question-number">Question ${index + 1}</span>
                    <span class="question-type">Short Answer</span>
                </div>
                <p class="question-text">${q.question}</p>
                <textarea 
                    class="short-answer" 
                    placeholder="Type your answer here..."
                    oninput="saveAnswer(${q.id}, this.value)"
                ></textarea>
            `;
        }

        container.appendChild(questionDiv);
    });
}

// Save answer
function saveAnswer(questionId, answer) {
    answers[questionId] = answer;
    // Mark as recently answering for a short grace period (5 seconds)
    recentlyAnsweredUntil = Date.now() + 5000;
}

// Start countdown timer
function startTimer(durationMinutes) {
    let timeLeft = durationMinutes * 60; // Convert to seconds

    updateTimerDisplay(timeLeft);

    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay(timeLeft);

        // Warning at 2 minutes
        if (timeLeft === 120) {
            document.getElementById('timer').classList.add('timer-warning');
        }

        // Critical at 1 minute
        if (timeLeft === 60) {
            document.getElementById('timer').classList.add('timer-critical');
        }

        // Time up
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            submitExam(true);
        }
    }, 1000);
}

// Update timer display
function updateTimerDisplay(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    document.getElementById('timerDisplay').textContent =
        `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE VERIFICATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function initiateFaceVerification() {
    try {
        console.log('[Face Verification] Initiating enrollment...');
        showFaceVerificationModal();
        const response = await fetch('/api/enroll/initiate', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token')}` }
        });
        const data = await response.json();
        
        if (data.success) {
            const status = document.getElementById('faceVerificationStatus');
            if (status) {
                status.textContent = '✅ Camera ready. Capture your face to begin.';
            }
        } else {
            console.warn('[Face Verification] Failed to initiate:', data.error);
            showToast(data.error || 'Could not start face verification', true);
        }
    } catch (error) {
        console.error('[Face Verification] Initiation error:', error);
        showToast('Face verification could not start. Please try again.', true);
    }
}

async function showFaceVerificationModal() {
    const modal = document.getElementById('faceVerificationModal');
    modal.style.display = 'flex';
    
    // Get access to camera for verification
    try {
        faceVerificationStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
            audio: false
        });
        
        const video = document.getElementById('faceVerificationVideo');
        video.srcObject = faceVerificationStream;
        video.play().catch(() => {});
        
        // Setup button handlers
        document.getElementById('startFaceVerificationBtn').onclick = startFaceCapture;
        document.getElementById('skipFaceVerificationBtn').onclick = skipFaceVerification;
        
    } catch (error) {
        console.error('[Face Verification] Camera error:', error);
        showToast('Camera access needed for face verification', true);
    }
}

async function startFaceCapture() {
    framesCollected = 0;
    faceVerificationActive = true;
    
    document.getElementById('startFaceVerificationBtn').disabled = true;
    document.getElementById('skipFaceVerificationBtn').disabled = true;
    
    const camera = document.getElementById('faceVerificationCamera');
    const status = document.getElementById('faceVerificationStatus');
    
    if (camera) {
        camera.classList.remove('face-error');
        camera.classList.add('capturing-face');
    }
    if (status) {
        status.textContent = '🎯 Capturing face images...';
    }
    
    // Capture frames every 800ms for a steadier enrollment sequence
    let captureCount = 0;
    const faceCapInterval = setInterval(async () => {
        if (!faceVerificationActive || framesCollected >= FRAMES_NEEDED_FOR_VERIFICATION) {
            clearInterval(faceCapInterval);
            return;
        }
        
        const video = document.getElementById('faceVerificationVideo');
        if (!video || !video.videoWidth) return;
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        const frameData = canvas.toDataURL('image/jpeg', 0.90);
        
        try {
            const response = await fetch('/api/enroll/capture', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${sessionStorage.getItem('token')}`
                },
                body: JSON.stringify({ frame: frameData })
            });
            
            const result = await response.json();
            
            if (result.captured) {
                framesCollected = result.frames_collected;
                
                // Update progress dots
                for (let i = 1; i <= 3; i++) {
                    const dot = document.getElementById(`dot${i}`);
                       if (dot) {
                    if (i <= framesCollected) {
                        dot.classList.add('captured');
                        dot.classList.remove('capturing');
                    } else if (i === framesCollected + 1) {
                        dot.classList.add('capturing');
                    }
                       }
                }
                
                   if (status) {
                status.textContent = `✅ Captured ${framesCollected}/3 face images`;
                   }
                
                if (framesCollected >= FRAMES_NEEDED_FOR_VERIFICATION) {
                       clearInterval(faceCapInterval);
                    finalizeFaceVerification();
                }
            } else {
                   if (status) {
                status.textContent = '⚠️ ' + (result.error || 'Move face closer to camera...');
                   }
                   if (camera) {
                camera.classList.add('face-error');
                setTimeout(() => camera.classList.remove('face-error'), 500);
                   }
            }
        } catch (error) {
            console.error('[Face Capture] Error:', error);
               if (status) {
                   status.textContent = '❌ Network error - please try again';
               }
        }
        
        captureCount++;
        }, 800);
}

async function finalizeFaceVerification() {
    try {
        console.log('[Face Verification] Finalizing enrollment...');
        document.getElementById('faceVerificationStatus').textContent = '⏳ Verifying faces...';
        
        const response = await fetch('/api/enroll/finalize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token')}` }
        });
        
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('faceVerificationStatus').textContent = '✅ ' + data.message;
            document.getElementById('faceVerificationCamera').classList.add('face-verified');
            showToast('Face verification complete! Exam will start now.', false);
            
            setTimeout(() => {
                closeFaceVerificationModal();
                proceedToExamQuestions();
            }, 2000);
        } else {
            document.getElementById('faceVerificationStatus').textContent = '❌ ' + (data.error || 'Verification failed');
            document.getElementById('startFaceVerificationBtn').disabled = false;
            document.getElementById('skipFaceVerificationBtn').disabled = false;
            faceVerificationActive = false;
        }
    } catch (error) {
        console.error('[Face Verification] Finalization error:', error);
        showToast('Face verification error. Please try again.', true);
    }
}

function skipFaceVerification() {
    faceVerificationActive = false;
    closeFaceVerificationModal();
    proceedToExamQuestions();
}

function closeFaceVerificationModal() {
    const modal = document.getElementById('faceVerificationModal');
    modal.style.display = 'none';
    
    if (faceVerificationStream) {
        faceVerificationStream.getTracks().forEach(track => track.stop());
        faceVerificationStream = null;
    }
}

function proceedToExamQuestions() {
    document.getElementById('systemCheckModal').style.display = 'none';
    const examVideo = document.getElementById('webcam');
    if (examVideo && webcamStream) {
        examVideo.srcObject = webcamStream;
    }
    
    const statusElement = document.getElementById('webcamStatus');
    if (statusElement) {
        statusElement.innerHTML = '<div class="status-indicator active"></div><span>Monitoring Active</span>';
        statusElement.classList.add('active');
    }
    
    // Start capturing frames faster so warnings appear sooner
    captureInterval = setInterval(captureAndSendFrame, 1000);
    
    // Start timer
    if (examData) {
        startTimer(examData.duration);
    }
}

// Initialize webcam — exposed retry/skip on window for HTML buttons
async function initWebcam() {
    const statusEl = document.getElementById('webcamStatus');

    // ── helper: attempt to get camera and wire the UI ────────────────────
    async function attemptCamera() {
        const sysStatus = document.getElementById('sysCheckStatus');
        const startBtn  = document.getElementById('startExamBtn');
        const placeholder = document.getElementById('sysCheckVideoPlaceholder');

        if (sysStatus) {
            sysStatus.style.color = 'var(--warning)';
            sysStatus.textContent = '⏳ Requesting camera — please allow access in your browser…';
        }

        // Race getUserMedia against an 8s timeout so we never hang silently
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Camera request timed out. No response from browser.')), 8000)
        );

        try {
            let stream;
            try {
                stream = await Promise.race([
                    navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
                        audio: false
                    }),
                    timeoutPromise
                ]);
            } catch (constraintErr) {
                // Fallback: bare video request
                console.warn('[Webcam] Falling back to bare video:', constraintErr.name || constraintErr.message);
                stream = await Promise.race([
                    navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
                    new Promise((_, r) => setTimeout(() => r(new Error('Timeout on fallback')), 5000))
                ]);
            }

            webcamStream = stream;

            // Wire video element
            const sysVideo = document.getElementById('sysCheckVideo');
            if (sysVideo) {
                sysVideo.srcObject = stream;
                try { await sysVideo.play(); } catch (e) { /* autoplay policy — ignore */ }
                // Hide placeholder once video is playing
                sysVideo.addEventListener('playing', () => {
                    if (placeholder) placeholder.style.display = 'none';
                }, { once: true });
                // Safety: hide placeholder after 2s anyway
                setTimeout(() => { if (placeholder) placeholder.style.display = 'none'; }, 2000);
            }

            if (sysStatus) {
                sysStatus.textContent = '✅ Camera ready! Click Start Exam to begin.';
                sysStatus.style.color = 'var(--success)';
            }
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.onclick = () => initiateFaceVerification();
            }
            if (statusEl) {
                statusEl.innerHTML = '<div class="status-indicator"></div><span>Camera connected</span>';
            }

        } catch (error) {
            console.error('[Webcam] Failed:', error.name, error.message);
            if (statusEl) {
                statusEl.innerHTML = '<div class="status-indicator error"></div><span>Camera Unavailable</span>';
            }

            const isBlocked = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError';
            const isNotFound = error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError';
            const isTimeout  = error.message && error.message.includes('imed out');

            let msg = '';
            if (isBlocked) {
                msg = `🔒 Camera blocked by browser.<br>
                    <span style="font-size:.8rem;color:#94a3b8;font-weight:400;">
                        Click the 🔒 or 📷 icon in your address bar → Allow camera → then click <strong>Retry Camera</strong>.
                    </span>`;
            } else if (isNotFound) {
                msg = `📷 No camera detected.<br>
                    <span style="font-size:.8rem;color:#94a3b8;font-weight:400;">
                        Plug in a webcam then click <strong>Retry Camera</strong>, or click <strong>Skip</strong> to continue without proctoring.
                    </span>`;
            } else if (isTimeout) {
                msg = `⏱ Browser did not respond to camera request.<br>
                    <span style="font-size:.8rem;color:#94a3b8;font-weight:400;">
                        Check if another app is using the camera, then click <strong>Retry Camera</strong>.
                    </span>`;
            } else {
                msg = `❌ ${error.name}: ${error.message}.<br>
                    <span style="font-size:.8rem;color:#94a3b8;font-weight:400;">Click <strong>Retry Camera</strong> or <strong>Skip</strong>.</span>`;
            }

            if (sysStatus) {
                sysStatus.innerHTML = msg;
                sysStatus.style.color = 'var(--danger)';
            }
        }
    }

    // Expose retry and skip to HTML buttons
    window._retryCam = () => {
        if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
        const ph = document.getElementById('sysCheckVideoPlaceholder');
        if (ph) ph.style.display = 'flex';
        const sv = document.getElementById('sysCheckVideo');
        if (sv) sv.srcObject = null;
        document.getElementById('startExamBtn').disabled = true;
        attemptCamera();
    };

    window._skipCam = () => {
        // Allow proceeding without camera — proctoring will show warnings
        const startBtn = document.getElementById('startExamBtn');
        const sysStatus = document.getElementById('sysCheckStatus');
        if (sysStatus) { sysStatus.textContent = '⚠️ Skipped camera. Proctoring may flag issues.'; sysStatus.style.color = 'var(--warning)'; }
        if (startBtn) { startBtn.disabled = false; startBtn.onclick = () => initiateFaceVerification(); }
    };

    await attemptCamera();
}

// Capture and send frame to AI
async function captureAndSendFrame() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    // Guard: if video isn't playing yet, skip this frame
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!video.srcObject || vw === 0 || vh === 0) {
        console.warn('[Proctor] Video not ready yet, skipping frame capture.');
        return;
    }

    // Set canvas size to match video
    canvas.width = vw;
    canvas.height = vh;

    // Draw video frame to canvas
    ctx.drawImage(video, 0, 0);

    // Convert to base64 JPEG
    const frameData = canvas.toDataURL('image/jpeg', 0.8);

    // Send to server
    try {
        const isAnswering = (Date.now() < recentlyAnsweredUntil) || isInputFocused();

        const response = await fetch('/api/proctor/frame', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionStorage.getItem('token')}`
            },
            body: JSON.stringify({
                username,
                frame: frameData,
                isAnswering,
                clientFlags: [...clientFlags],
                timestamp: new Date().toISOString()
            })
        });
        
        clientFlags = []; // clear after sending

        const data = await response.json();

        // ── Update cheat score from server response ──────────────────────────
        if (data.cheatScore !== null && data.cheatScore !== undefined) {
            // Check if score dropped and log the deduction
            if (data.cheatScore < cheatScore) {
                const deducted = cheatScore - data.cheatScore;
                // Find most recent reason from analysis flags or action message
                const reason = (data.analysis && data.analysis.flags && data.analysis.flags[0])
                    ? data.analysis.flags[0].substring(0, 50)
                    : (data.message || 'Violation detected');
                addCheatScoreDeductionEntry(reason, deducted, data.cheatScore);
            }
            updateCheatScoreUI(data.cheatScore);
        }

        // ── Proctor Overlays (no-face / device) ──────────────────────────
        const aiDetails    = (data.analysis && data.analysis.details) || {};
        const faceResult   = aiDetails.face  || {};
        const deviceResult = aiDetails.device || {};
        const noFace       = faceResult.face_detected === false;
        const devWarning   = data.analysis && data.analysis.device_warning;
        const devType      = (data.analysis && data.analysis.device_type) || '';

        if (noFace) {
            showProctorOverlay('👤', 'No Face Detected',
                'Please return to your seat and keep your face visible to the camera.');
        } else if (devWarning && /earbud|pod/i.test(devType)) {
            showProctorOverlay('🎧', 'Earbuds / Pods Detected',
                'Wireless earbuds were detected. Remove them immediately — audio assistance is not permitted.');
        } else if (devWarning) {
            showProctorOverlay('📱', 'Device Detected',
                'A phone or electronic device was detected. Remove it from view immediately.');
        } else {
            hideProctorOverlay();
        }

        // Handle termination
        if (data.action === 'terminate') {
            clearInterval(captureInterval);
            clearInterval(timerInterval);

            // Show result modal with termination message
            const modal = document.getElementById('resultModal');
            const resultMessage = document.getElementById('resultMessage');
            const scoreDetails = document.getElementById('scoreDetails');
            const scorePercentage = document.getElementById('scorePercentage');
            const modalHeader = modal.querySelector('.modal-header h2');

            modalHeader.textContent = 'Exam Terminated';
            modalHeader.style.color = '#ef4444';

            scorePercentage.textContent = 'FAIL';
            scorePercentage.style.color = '#ef4444';
            scoreDetails.textContent = 'Disqualified';

            // Build detailed reasons from analysis if available
            let reasonsHtml = '';
            try {
                const analysis = data.analysis || {};
                const flags = analysis.flags || [];
                const details = analysis.details || {};

                // List flags
                if (flags.length) {
                    reasonsHtml += '<h4 style="margin:8px 0 4px 0;">Detected issues</h4>';
                    reasonsHtml += '<ul style="margin:0 0 10px 18px;">';
                    // show unique flags
                    [...new Set(flags)].forEach(f => {
                        reasonsHtml += `<li>${f}</li>`;
                    });
                    reasonsHtml += '</ul>';
                }

                // Face details
                if (details.face) {
                    const face = details.face;
                    const conf = (face.confidence || 0).toFixed(2);
                    reasonsHtml += '<h4 style="margin:8px 0 4px 0;">Face analysis</h4>';
                    reasonsHtml += '<ul style="margin:0 0 10px 18px;">';
                    reasonsHtml += `<li>Face detected: ${face.face_detected ? 'Yes' : 'No'}</li>`;
                    reasonsHtml += `<li>Number of faces: ${face.num_faces || 0}</li>`;
                    reasonsHtml += `<li>Detection confidence: ${conf}</li>`;
                    reasonsHtml += '</ul>';
                }

                // Eyes
                if (details.eyes) {
                    const eyes = details.eyes;
                    reasonsHtml += '<h4 style="margin:8px 0 4px 0;">Eye tracking</h4>';
                    reasonsHtml += '<ul style="margin:0 0 10px 18px;">';
                    reasonsHtml += `<li>Gaze direction: ${eyes.gaze_direction || 'unknown'}</li>`;
                    if (typeof eyes.offset !== 'undefined') reasonsHtml += `<li>Offset: ${eyes.offset.toFixed(2)}</li>`;
                    reasonsHtml += `<li>Confidence: ${eyes.confidence || 0}</li>`;
                    reasonsHtml += '</ul>';
                }

                // Head pose
                if (details.head_pose) {
                    const hp = details.head_pose;
                    reasonsHtml += '<h4 style="margin:8px 0 4px 0;">Head pose</h4>';
                    reasonsHtml += '<ul style="margin:0 0 10px 18px;">';
                    reasonsHtml += `<li>Yaw: ${hp.yaw ? hp.yaw.toFixed(1) + '°' : '0°'}</li>`;
                    reasonsHtml += `<li>Pitch: ${hp.pitch ? hp.pitch.toFixed(1) + '°' : '0°'}</li>`;
                    reasonsHtml += `<li>Roll: ${hp.roll ? hp.roll.toFixed(1) + '°' : '0°'}</li>`;
                    reasonsHtml += '</ul>';
                }
            } catch (err) {
                console.error('Error building reasons HTML', err);
            }

            resultMessage.innerHTML = `
                <div style="color: #ef4444; font-weight: bold; font-size: 1.1rem; margin-bottom: 10px;">
                    ${data.message}
                </div>
                <p>Your exam session has been closed due to repeated proctoring violations.</p>
                ${reasonsHtml ? `<div style="margin-top:12px;">${reasonsHtml}</div>` : ''}
                <p style="margin-top:12px;font-size:0.95rem;color:#666;">You can review the proctoring report in the admin console or via the proctoring report API.</p>
            `;

            modal.style.display = 'flex';

            // Disable webcam
            if (webcamStream) {
                webcamStream.getTracks().forEach(track => track.stop());
            }

            return; // Stop further processing
        }

        // Update status UI
        const statusElement = document.getElementById('webcamStatus');

        // ── Determine what the AI sees to control overlays ────────────────
        const faceInfo  = aiDetails.face || {};
        const aiFlags   = (data.analysis && data.analysis.flags) || [];
        const hasDevice = aiFlags.some(f => /phone|mobile|smartphone|device/i.test(f));

        if (noFace) {
            showProctorOverlay('👤', 'No Face Detected', 'Please return to your seat and keep your face visible to the camera.');
        } else if (hasDevice) {
            showProctorOverlay('📱', 'Device Detected', 'A mobile phone or device was detected. Please remove it from view immediately.');
        } else {
            hideProctorOverlay();
        }
        // The AI sends face_mismatch_warning:true AND appends a flag string
        const isFaceMismatch = 
            (data.analysis && data.analysis.face_mismatch_warning === true) ||
            (data.analysis && data.analysis.flags && data.analysis.flags.some(f =>
                /different person/i.test(f) || /face.*(mismatch|does not match)/i.test(f)
            ));

        if (isFaceMismatch) {
            statusElement.innerHTML = `<div class="status-indicator error"></div><span>🚨 IDENTITY MISMATCH DETECTED!</span>`;
            statusElement.classList.add('error');
            statusElement.classList.remove('active');
            showFaceMismatchBanner();
        }
        // Critical Alert for Multiple Faces
        else if (data.analysis && data.analysis.flags && data.analysis.flags.includes('Multiple people detected in the exam environment')) {
            statusElement.innerHTML = `<div class="status-indicator error"></div><span>🚨 MULTIPLE PEOPLE DETECTED!</span>`;
            statusElement.classList.add('error');
            statusElement.classList.remove('active');

            showToast('🚨 CRITICAL: Multiple people detected in exam environment!', true);

            // Flash screen red
            document.body.style.backgroundColor = '#fee2e2';
            setTimeout(() => { document.body.style.backgroundColor = ''; }, 500);
        }
        else if (data.message && data.message.includes('Warning')) {
            statusElement.innerHTML = `<div class="status-indicator error"></div><span>${data.message}</span>`;
            statusElement.classList.add('error');
            statusElement.classList.remove('active');
            
            showToast(data.message, false);
        } else {
            statusElement.innerHTML = `<div class="status-indicator active"></div><span>Monitoring Active</span>`;
            statusElement.classList.remove('error');
            statusElement.classList.add('active');
        }

    } catch (error) {
        console.error('Proctoring frame error:', error);
    }
}

// Helper: detect if an input inside the questions container is focused
function isInputFocused() {
    const active = document.activeElement;
    if (!active) return false;
    // consider textarea or radio/checkbox inputs as answering
    if (active.tagName === 'TEXTAREA') return true;
    if (active.tagName === 'INPUT' && (active.type === 'radio' || active.type === 'checkbox' || active.type === 'text')) return true;
    return false;
}

// Submit exam
async function submitExam(autoSubmit = false) {
    if (autoSubmit instanceof Event) autoSubmit = false;
    if (submitInProgress) return;
    submitInProgress = true;

    // Stop timer and webcam
    if (timerInterval) clearInterval(timerInterval);
    if (captureInterval) clearInterval(captureInterval);
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
    }

    // Disable submit button
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
    }

    try {
        const examId = sessionStorage.getItem('currentExamId') || null;
        const response = await fetch('/api/submit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionStorage.getItem('token')}`
            },
            body: JSON.stringify({ username, answers, examId })
        });

        const result = await response.json().catch(() => ({ success: false, error: 'Invalid server response' }));
        if (!response.ok || !result.success) {
            throw new Error(result.error || `Submission failed (${response.status})`);
        }

        // Clear the examId only after successful submission
        sessionStorage.removeItem('currentExamId');
        showResult(result, autoSubmit);

        // Redirect to dashboard after 3 seconds
        setTimeout(() => {
            window.location.href = '/dashboard.html';
        }, 3000);
    } catch (error) {
        console.error('Submit error:', error);
        alert('Failed to submit exam. Please try again.');
        submitInProgress = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Exam';
        }
    }
}

// Show result modal
function showResult(result, autoSubmit) {
    const modal = document.getElementById('resultModal');
    const scorePercentage = document.getElementById('scorePercentage');
    const scoreDetails = document.getElementById('scoreDetails');
    const resultMessage = document.getElementById('resultMessage');

    scorePercentage.textContent = `${result.percentage}%`;
    scoreDetails.textContent = `You scored ${result.score} out of ${result.totalMCQ} questions`;

    const penaltyLine = result.malpracticePenalty > 0
        ? `<p style="color:#ef4444;margin-top:8px;">Malpractice penalty applied: -${result.malpracticePenalty} points</p>`
        : '';

    // Integrity score block
    const finalCS   = cheatScore;
    const csCls     = getScoreClass(finalCS);
    const csLabel   = getClassificationLabel(finalCS);
    const csColors  = { safe: '#10b981', warn: '#f59e0b', danger: '#ef4444' };
    const csColor   = csColors[csCls];
    const integrityHtml = `
        <div style="margin-top:1.25rem;padding:1rem;background:rgba(255,255,255,.05);border-radius:12px;border:1px solid rgba(255,255,255,.1);">
            <div style="font-weight:700;margin-bottom:.6rem;">🛡️ Integrity Report</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem;">
                <span style="font-size:.88rem;color:#94a3b8;">Integrity Score</span>
                <strong style="font-size:1.25rem;color:${csColor}">${finalCS}%</strong>
            </div>
            <div style="height:8px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin-bottom:.5rem;">
                <div style="height:100%;width:${finalCS}%;background:${csColor};border-radius:999px;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:.8rem;color:#94a3b8;">
                <span>Classification</span>
                <strong style="color:${csColor}">${csLabel}</strong>
            </div>
        </div>`;

    if (autoSubmit) {
        resultMessage.innerHTML = `
            <p style="color: #ff6b6b;">⏰ Time expired - Exam auto-submitted</p>
            <p>${result.message}</p>
            ${penaltyLine}
            ${integrityHtml}
        `;
    } else {
        resultMessage.innerHTML = `<p>${result.message}</p>${penaltyLine}${integrityHtml}`;
    }

    modal.style.display = 'flex';
}

// Make saveAnswer global
window.saveAnswer = saveAnswer;

// Show Toast
function showToast(message, isError = false) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'toast-error' : 'toast-warning'}`;
    toast.innerHTML = `
        <div class="toast-icon">${isError ? '❌' : '⚠️'}</div>
        <div class="toast-content">${message}</div>
    `;
    
    container.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after 5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Show a persistent face mismatch warning banner (stays until dismissed or exam ends)
let faceMismatchBannerShown = false;
function showFaceMismatchBanner() {
    if (faceMismatchBannerShown) return; // Show only once (avoid spam)
    faceMismatchBannerShown = true;

    // Flash entire screen red
    document.body.style.outline = '6px solid #ef4444';
    document.body.style.outlineOffset = '-6px';

    // Create persistent banner
    const banner = document.createElement('div');
    banner.id = 'faceMismatchBanner';
    banner.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 9999;
        background: linear-gradient(135deg, #7f1d1d, #991b1b);
        border-bottom: 3px solid #ef4444;
        color: #fff;
        padding: 1rem 1.5rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        font-family: 'Inter', sans-serif;
        box-shadow: 0 4px 24px rgba(239,68,68,0.5);
        animation: bannerSlideIn 0.4s ease-out;
    `;
    banner.innerHTML = `
        <span style="font-size:2rem">🚨</span>
        <div style="flex:1">
            <div style="font-weight:800;font-size:1.1rem;letter-spacing:.02em">IDENTITY VERIFICATION FAILED</div>
            <div style="font-size:0.88rem;opacity:0.9;margin-top:0.2rem">
                The face in front of the camera does not match the person who enrolled for this exam.
                This incident has been recorded with photographic evidence.
                Continued impersonation will result in <strong>exam termination</strong>.
            </div>
        </div>
        <button onclick="dismissFaceMismatchBanner()" style="
            background: rgba(255,255,255,0.15);
            border: 1px solid rgba(255,255,255,0.3);
            color: #fff;
            padding: 0.4rem 0.875rem;
            border-radius: 8px;
            cursor: pointer;
            font-size:0.83rem;
            font-weight:600;
            font-family:inherit;
            flex-shrink:0;
        ">Dismiss</button>
    `;

    // Add keyframe if not already added
    if (!document.getElementById('bannerKeyframe')) {
        const style = document.createElement('style');
        style.id = 'bannerKeyframe';
        style.textContent = `@keyframes bannerSlideIn { from { transform: translateY(-100%); opacity:0; } to { transform: translateY(0); opacity:1; } }`;
        document.head.appendChild(style);
    }

    document.body.prepend(banner);

    // Also show toast
    showToast('🚨 IDENTITY MISMATCH: A different person has been detected! This incident has been logged.', true);
}

function dismissFaceMismatchBanner() {
    const banner = document.getElementById('faceMismatchBanner');
    if (banner) banner.remove();
    document.body.style.outline = '';
    document.body.style.outlineOffset = '';
    // Allow banner to re-appear on next detection after 30 seconds
    setTimeout(() => { faceMismatchBannerShown = false; }, 30000);
}
