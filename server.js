// Load .env file for local development (ignored in Docker where env vars are injected)
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const nodeCrypto = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = nodeCrypto.webcrypto;
}

const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fsPromises = require('fs').promises;
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5000';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/proctorguard';

// Middleware
// Support restricted CORS via ALLOWED_ORIGINS env (comma-separated). If not set, allow all origins.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ALLOWED_ORIGINS.length) {
    app.use(cors({
        origin: function (origin, callback) {
            // allow non-browser clients or same-origin (no origin)
            if (!origin) return callback(null, true);
            if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
            return callback(new Error('CORS policy: origin not allowed'), false);
        }
    }));
} else {
    app.use(cors());
}
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        dbReady: mongoose.connection.readyState === 1
    });
});

// MongoDB Connection (with retry)
async function connectMongo(retries = 5) {
    for (let i = 1; i <= retries; i++) {
        try {
            await mongoose.connect(MONGO_URI);
            console.log('✅ MongoDB Connected to', MONGO_URI);
            return;
        } catch (err) {
            console.error(`MongoDB connection attempt ${i}/${retries} failed:`, err.message);
            if (i < retries) await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.error('❌ Could not connect to MongoDB after', retries, 'attempts. API calls will fail.');
}
connectMongo();

// Render free tier cold-starts can take 30-60s — use a generous timeout and retry wrapper
const AI_TIMEOUT_MS = 60000; // 60 seconds

async function postAiWithRetry(url, data, options = {}, retries = 2) {
    let lastError = null;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            return await axios.post(url, data, { ...options, timeout: AI_TIMEOUT_MS });
        } catch (error) {
            lastError = error;
            const status = error.response && error.response.status;
            const shouldRetry = !status || [502, 503, 504].includes(status) || error.code === 'ECONNABORTED';

            if (attempt <= retries && shouldRetry) {
                console.warn(`[AI_PROXY] POST ${url} failed (attempt ${attempt}/${retries + 1})`, status || error.code || error.message);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                continue;
            }

            break;
        }
    }

    throw lastError;
}

// Keep-alive: ping the AI service every 9 minutes so Render doesn't spin it down
// (Render free tier spins down after 15 min of inactivity)
function startAiKeepAlive() {
    const pingInterval = 9 * 60 * 1000; // 9 minutes
    const ping = () => {
        axios.get(`${AI_SERVICE_URL}/health`, { timeout: 10000 })
            .then(() => console.log('[KEEP_ALIVE] AI service pinged OK'))
            .catch(e  => console.warn('[KEEP_ALIVE] AI ping failed:', e.code || e.message));
    };
    // Initial ping on startup to wake the service early
    setTimeout(ping, 3000);
    setInterval(ping, pingInterval);
}
startAiKeepAlive();

// Guard: return 503 if MongoDB is not ready yet
app.use('/api', (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database not ready yet. Please try again in a few seconds.' });
    }
    next();
});

// Mongoose Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'student' }
});
const User = mongoose.model('User', userSchema);

async function getSeedUser(username) {
    try {
        const seedPaths = [
            path.join(__dirname, 'data', 'users.json'),
            path.join(__dirname, '..', 'data', 'users.json')
        ];
        let raw = null;
        for (const candidate of seedPaths) {
            try {
                raw = await fsPromises.readFile(candidate, 'utf8');
                break;
            } catch (error) {}
        }
        if (!raw) return null;
        const users = JSON.parse(raw);
        const seed = users[username];
        if (!seed) return null;
        return {
            username,
            password: typeof seed === 'string' ? seed : seed.password,
            role: typeof seed === 'object' && seed.role ? seed.role : 'student'
        };
    } catch (error) {
        return null;
    }
}

const examQuestionSchema = new mongoose.Schema({
    id: mongoose.Schema.Types.Mixed,
    type: String,
    question: String,
    options: [String],
    correctAnswer: mongoose.Schema.Types.Mixed
}, { _id: false });

const examSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: String,
    courseCode: String,
    badge: String,
    startTime: Date,
    endTime: Date,
    duration: Number,
    questions: [examQuestionSchema],
    createdAt: Date,
    createdBy: String
});
const Exam = mongoose.model('Exam', examSchema);

const resultSchema = new mongoose.Schema({
    username: String,
    answers: mongoose.Schema.Types.Mixed,
    score: Number,
    totalMCQ: Number,
    percentage: Number,
    passed: Boolean,
    examId: String,
    timestamp: Date
});
const Result = mongoose.model('Result', resultSchema);

const proctorLogSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    flags: [{
        timestamp: Date,
        issue: String,
        image: String
    }],
    frames: [{
        timestamp: Date,
        analysis: mongoose.Schema.Types.Mixed
    }],
    meta: {
        absentStart: Number,
        lookingAwayStart: Number,
        warning: mongoose.Schema.Types.Mixed
    },
    cheatScore: { type: Number, default: 100 },
    scoreHistory: [{
        timestamp: Date,
        reason: String,
        deduction: Number,
        scoreBefore: Number,
        scoreAfter: Number
    }]
});
const ProctorLog = mongoose.model('ProctorLog', proctorLogSchema);

const questionBankSchema = new mongoose.Schema({
    name: { type: String, default: 'default' },
    questions: [examQuestionSchema]
});
const QuestionBank = mongoose.model('QuestionBank', questionBankSchema);

// Exam questions
const EXAM_QUESTIONS = [
    {
        id: 1,
        type: 'mcq',
        question: 'What is the capital of France?',
        options: ['London', 'Berlin', 'Paris', 'Madrid'],
        correctAnswer: 2
    },
    {
        id: 2,
        type: 'mcq',
        question: 'Which programming language is known as the "language of the web"?',
        options: ['Python', 'Java', 'JavaScript', 'C++'],
        correctAnswer: 2
    },
    {
        id: 3,
        type: 'short',
        question: 'Explain the concept of Docker in one sentence.',
        correctAnswer: null // Manually graded
    },
    {
        id: 4,
        type: 'mcq',
        question: 'What does AI stand for?',
        options: ['Artificial Intelligence', 'Automated Input', 'Advanced Interface', 'None of the above'],
        correctAnswer: 0
    },
    {
        id: 5,
        type: 'mcq',
        question: 'Which company developed Node.js?',
        options: ['Google', 'Microsoft', 'Joyent', 'Facebook'],
        correctAnswer: 2
    }
];

// Default/fallback questions
async function getExamQuestions() {
    try {
        const doc = await QuestionBank.findOne({ name: 'default' });
        if (doc && doc.questions && doc.questions.length > 0) return doc.questions;
    } catch (e) {}
    return EXAM_QUESTIONS; // Fallback to hardcoded
}

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this';
const SSL_KEY_CANDIDATES = [
    path.join(__dirname, 'localhost+1-key.pem'),
    path.join(__dirname, '..', 'localhost+1-key.pem')
];
const SSL_CERT_CANDIDATES = [
    path.join(__dirname, 'localhost+1.pem'),
    path.join(__dirname, '..', 'localhost+1.pem')
];

function findFirstExistingFile(candidates) {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

const sslKeyPath = findFirstExistingFile(SSL_KEY_CANDIDATES);
const sslCertPath = findFirstExistingFile(SSL_CERT_CANDIDATES);
const sslOptions = sslKeyPath && sslCertPath
    ? {
        key: fs.readFileSync(sslKeyPath),
        cert: fs.readFileSync(sslCertPath)
    }
    : null;

// ── Cheat Score deduction table ────────────────────────────────────────
const CHEAT_DEDUCTIONS = {
    tab_switch:          1,   // client-side flag
    eyes_away:           2,   // sustained gaze away
    absent_short:        3,   // face gone < 45s
    absent_long:         5,   // face gone >= 45s
    multiple_faces:     10,   // extra person visible
    face_mismatch:      20,   // different person
    device_detected:    10,   // phone/device in frame
    device_headphone:   10,   // headphones / headset in frame
    device_watch:       10,   // smart watch / wearable gadget in frame
};
// Per-student cooldowns (ms) to avoid duplicate deductions for same continuous event
// key: `${username}_${violationType}` → timestamp of last deduction
const _deductCooldown = {};
const DEDUCT_COOLDOWN_MS = 30000; // 30s between same-type deductions

/**
 * Deduct from student cheat score. Returns { scoreBefore, scoreAfter, deduction }.
 * Only deducts if cooldown has expired for this violation type.
 */
async function applyCheatDeduction(procLog, violationType, reason, timestamp) {
    const cdKey = `${procLog.username}_${violationType}`;
    const now   = Date.now();
    if (_deductCooldown[cdKey] && (now - _deductCooldown[cdKey]) < DEDUCT_COOLDOWN_MS) {
        return null; // still in cooldown, skip
    }
    const deduction   = CHEAT_DEDUCTIONS[violationType] || 1;
    const scoreBefore = procLog.cheatScore ?? 100;
    const scoreAfter  = Math.max(0, scoreBefore - deduction);

    procLog.cheatScore = scoreAfter;
    procLog.scoreHistory.push({
        timestamp: new Date(timestamp),
        reason,
        deduction,
        scoreBefore,
        scoreAfter
    });

    _deductCooldown[cdKey] = now; // reset cooldown
    console.log(`[CHEAT_SCORE] ${procLog.username} | ${violationType}: -${deduction}% → ${scoreAfter}%`);
    return { scoreBefore, scoreAfter, deduction };
}

// API: Register
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, adminCode } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const existingUser = await User.findOne({ username });

        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Determine role: grant admin if secret code matches
        const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ADMIN2026';
        const role = (adminCode && adminCode === ADMIN_SECRET) ? 'admin' : 'student';

        // Store the user
        await User.create({ username, password, role });

        res.json({ success: true, message: `${role.charAt(0).toUpperCase() + role.slice(1)} account registered successfully` });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API: Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password, role: requestedRole, adminCode } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ADMIN2026';

        // Hardcoded Admin Backdoor (demo only)
        if (username === 'admin' && password === 'admin') {
            if (requestedRole && requestedRole !== 'admin') {
                return res.status(401).json({ error: 'Account is not registered as student. Please log in as Admin.' });
            }
            if (!adminCode || adminCode !== ADMIN_SECRET) {
                return res.status(401).json({ error: 'Invalid admin secret code.' });
            }
            const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
            return res.json({ success: true, message: 'Admin login successful', username, token, role: 'admin' });
        }

        const dbUser = await User.findOne({ username });
        const seedUser = await getSeedUser(username);
        const userData = [dbUser, seedUser].find(user => user && user.password === password);

        if (!userData) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const role = userData.role || 'student';

        // Use the stored role for authentication; do not reject users just because
        // the login form selected a different role button.

        // Admin users must also provide the secret code
        if (role === 'admin') {
            if (!adminCode || adminCode !== ADMIN_SECRET) {
                return res.status(401).json({ error: 'Invalid admin secret code.' });
            }
        }

        if (userData.password === password) {
            const expiresIn = role === 'admin' ? '2h' : '4h';
            const token = jwt.sign({ username, role }, JWT_SECRET, { expiresIn });
            return res.json({ success: true, message: 'Login successful', username, token, role });
        }

        return res.status(401).json({ error: 'Invalid credentials' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Middleware: Authenticate Token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// ── Exam Sessions API ────────────────────────────────────────────────────────

// Admin: Create an exam session
app.post('/api/admin/exams', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const { title, courseCode, badge, startTime, endTime, duration, questions } = req.body;
        if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'title and questions array are required' });
        }
        const newExam = {
            id: Date.now().toString(),
            title, courseCode: courseCode || '', badge: badge || 'EXAM',
            startTime: startTime || null, endTime: endTime || null,
            duration: Number(duration) || 10, questions,
            createdAt: new Date(), createdBy: req.user.username
        };
        await Exam.create(newExam);
        console.log(`[ADMIN] Exam created: "${title}" by ${req.user.username}`);
        res.json({ success: true, exam: newExam });
    } catch (e) {
        console.error('Create exam error:', e);
        res.status(500).json({ error: 'Failed to create exam' });
    }
});

// Admin: List all exam sessions
app.get('/api/admin/exams', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const exams = await Exam.find({}, '-_id -__v');
        res.json(exams);
    } catch (e) { res.status(500).json({ error: 'Failed to load exams' }); }
});

// Admin: Delete an exam session
app.delete('/api/admin/exams/:id', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        await Exam.deleteOne({ id: req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete exam' }); }
});

// Student: List exams that are currently active (between start and end time)
app.get('/api/exams', authenticateToken, async (req, res) => {
    try {
        const now = new Date();
        const exams = await Exam.find();
        const visible = exams.filter(e => {
            const start = e.startTime ? new Date(e.startTime) : null;
            const end   = e.endTime   ? new Date(e.endTime)   : null;
            if (start && now < start) return false;
            if (end   && now > end)   return false;
            return true;
        });
        // Strip questions from list view for security
        res.json(visible.map(e => ({
            id: e.id, title: e.title, courseCode: e.courseCode,
            badge: e.badge, startTime: e.startTime, endTime: e.endTime,
            duration: e.duration, questionCount: e.questions.length
        })));
    } catch (e) { res.status(500).json({ error: 'Failed to load exams' }); }
});

// ────────────────────────────────────────────────────────────────────────────


// API: Get exam (optionally by examId for specific session)
app.get('/api/exam', authenticateToken, async (req, res) => {
    try {
        const { examId } = req.query;
        if (examId) {
            const exam = await Exam.findOne({ id: examId });
            if (!exam) return res.status(404).json({ error: 'Exam not found' });
            return res.json({ questions: exam.questions, duration: exam.duration, title: exam.title });
        }
        const questions = await getExamQuestions();
        res.json({ questions, duration: 10 });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load exam' });
    }
});

// API: Submit exam
app.post('/api/submit', authenticateToken, async (req, res) => {
    try {
        const { username, answers, examId } = req.body;

        if (req.user.username !== username && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Unauthorized user' });
        }
        if (!username || !answers) {
            return res.status(400).json({ error: 'Username and answers required' });
        }

        // Load the exam questions (from specific exam if examId given, else fallback)
        let questions = EXAM_QUESTIONS;
        if (examId) {
            const exam = await Exam.findOne({ id: examId });
            if (exam) questions = exam.questions;
        } else {
            questions = await getExamQuestions();
        }

        // Auto-score MCQ questions
        let score = 0;
        let totalMCQ = 0;
        questions.forEach(q => {
            if (q.type === 'mcq') {
                totalMCQ++;
                if (String(answers[q.id]) === String(q.correctAnswer)) score++;
            }
        });

        const rawPercentage = totalMCQ > 0 ? Math.round((score / totalMCQ) * 100) : 0;

        // Apply malpractice penalties instead of failing the exam outright.
        // Keep the score out of 100 and deduct points for each detected attempt.
        const procLog = await ProctorLog.findOne({ username });
        const flags = (procLog && procLog.flags) ? procLog.flags : [];
        const counts = {
            warnings: 0,
            faceMismatch: 0,
            multipleFaces: 0,
            tabSwitches: 0,
            other: 0,
        };

        for (const flag of flags) {
            const issue = String(flag.issue || '').toLowerCase();
            if (!issue) continue;
            if (issue.includes('warning issued')) counts.warnings += 1;
            else if (issue.includes('face mismatch') || issue.includes('different person') || issue.includes('identity mismatch')) counts.faceMismatch += 1;
            else if (issue.includes('multiple faces') || issue.includes('multiple people')) counts.multipleFaces += 1;
            else if (issue.includes('tab switch') || issue.includes('window minimized')) counts.tabSwitches += 1;
            else counts.other += 1;
        }

        const malpracticePenalty = Math.min(
            35,
            (counts.warnings * 1) +
            (counts.other * 1) +
            (counts.tabSwitches * 2) +
            (counts.multipleFaces * 3) +
            (counts.faceMismatch * 5)
        );

        const adjustedPercentage = Math.max(0, rawPercentage - malpracticePenalty);
        const passed = adjustedPercentage >= 50;

        // Upsert result into MongoDB
        await Result.findOneAndUpdate(
            { username },
            {
                username,
                answers,
                score,
                totalMCQ,
                rawPercentage,
                percentage: adjustedPercentage,
                malpracticePenalty,
                malpracticeCounts: counts,
                passed,
                examId: examId || null,
                timestamp: new Date()
            },
            { upsert: true, new: true }
        );

        const penaltyNote = malpracticePenalty > 0
            ? ` Malpractice penalty: -${malpracticePenalty} points.`
            : '';

        res.json({
            success: true,
            score,
            totalMCQ,
            rawPercentage,
            percentage: adjustedPercentage,
            malpracticePenalty,
            passed,
            message: `You scored ${score}/${totalMCQ} (${rawPercentage}%)${penaltyNote} Final score: ${adjustedPercentage}/100 — ${passed ? 'PASSED ✅' : 'FAILED ❌'}`
        });
    } catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API: Process proctoring frame
app.post('/api/proctor/frame', authenticateToken, async (req, res) => {
    try {
        const { username, frame, timestamp, isAnswering, clientFlags } = req.body;

        // Validate user
        if (req.user.username !== username) return res.status(403).json({ error: 'Unauthorized' });
        if (!username || !frame) return res.status(400).json({ error: 'Username and frame required' });

        // Forward to AI service — include studentId so face verification looks up the right reference
        // Use retry wrapper — Render cold starts can take up to 60s
        const aiResponse = await postAiWithRetry(`${AI_SERVICE_URL}/analyze`, { frame, timestamp, studentId: username });
        const analysis = aiResponse.data;

        // Load current proctor log from MongoDB
        let procLog = await ProctorLog.findOne({ username });
        if (!procLog) {
            procLog = new ProctorLog({ username, flags: [], frames: [], meta: {} });
        }

        // Append frame summary (NO base64 stored for clean frames — prevents 16MB doc limit)
        procLog.frames.push({ timestamp: new Date(timestamp), analysis });

        let action = 'continue';
        let message = 'Monitoring active';

        if (analysis.flags || analysis.details) {
            if (!procLog.meta) procLog.meta = {};

            // Filter transient flags when student is actively answering
            let reportedFlags = analysis.flags || [];
            if (isAnswering) {
                reportedFlags = reportedFlags.filter(f => {
                    if (/no face detected/i.test(f)) return true;
                    if (/multiple faces detected/i.test(f)) return true;
                    if (/eyes looking away|head turned|head looking down/i.test(f)) return false;
                    return true;
                });
            }

            // Push non-severe flags WITHOUT base64 image to save space
            reportedFlags.forEach(flag => {
                procLog.flags.push({ timestamp: new Date(timestamp), issue: flag });
            });
            if (clientFlags && Array.isArray(clientFlags)) {
                clientFlags.forEach(f => procLog.flags.push({ timestamp: new Date(timestamp), issue: f, image: frame }));
            }

            const details = analysis.details || {};
            const face = details.face || {};
            const eyes = details.eyes || {};
            const frameMs = (() => { try { return new Date(timestamp).getTime(); } catch (e) { return Date.now(); } })();

            // Face presence tracking
            const faceDetected = !!(face.face_detected && (face.confidence || 0) >= 0.5);
            if (!faceDetected) {
                if (!procLog.meta.absentStart) procLog.meta.absentStart = frameMs;
            } else {
                procLog.meta.absentStart = null;
            }

            // Looking-away tracking
            const lookingAway = !!eyes.looking_away;
            if (lookingAway) {
                if (!procLog.meta.lookingAwayStart) procLog.meta.lookingAwayStart = frameMs;
            } else {
                procLog.meta.lookingAwayStart = null;
            }

            const severeReasons = [];
            if (procLog.meta.absentStart && (frameMs - procLog.meta.absentStart) > 45000)
                severeReasons.push('Student left camera frame for >45s');
            if (procLog.meta.lookingAwayStart && (frameMs - procLog.meta.lookingAwayStart) > 60000)
                severeReasons.push('Continuous looking away >60s');
            if (face.num_faces && face.num_faces > 1)
                severeReasons.push(`Multiple faces detected (${face.num_faces})`);

            // ── Face Mismatch: AI confirmed a different person is writing ──────────
            if (analysis.face_mismatch_warning === true) {
                severeReasons.push('Different person detected — enrolled identity does not match current face');
                // Always store evidence image for identity fraud
                procLog.flags.push({ timestamp: new Date(timestamp), issue: '⚠️ Face mismatch: different person detected', image: frame });
                console.log(`[PROCTOR] FACE MISMATCH confirmed for ${username}`);
            }

            const reported = (analysis.flags || []).join(' ').toLowerCase();
            if (/phone|mobile|external device|cell phone|smartphone/i.test(reported))
                severeReasons.push('External device (phone) detected');
            if (/book|paper|notes|text on paper/i.test(reported))
                severeReasons.push('Suspicious object (book/paper) visible');
            if (/audio|speech|person speaking|another person/i.test(reported))
                severeReasons.push('Audio indicates another person speaking nearby');

            if (severeReasons.length > 0) {
                const warning = procLog.meta.warning;
                if (warning && warning.active) {
                    const warnedAt = warning.since || 0;
                    if ((frameMs - warnedAt) >= 30000) {
                        // Keep warning active; do not terminate the exam.
                        severeReasons.forEach(r => procLog.flags.push({ timestamp: new Date(timestamp), issue: r, image: frame }));
                        console.log(`[PROCTOR] Repeated malpractice confirmed for ${username}. Reasons: ${severeReasons.join('; ')}`);
                        action = 'warning';
                        message = `Warning: ${severeReasons.join(', ')}. Continued violations will reduce your score.`;
                        procLog.meta.warning = null;
                    } else {
                        action = 'warning';
                        message = `Warning: ${severeReasons.join(', ')}. Continued violations will reduce your score.`;
                    }
                } else {
                    procLog.meta.warning = { active: true, since: frameMs, reasons: severeReasons };
                    message = `Warning: ${severeReasons.join(', ')}. Continued violations will reduce your score.`;
                    action = 'warning';
                    // Store base64 image only for warning evidence
                    procLog.flags.push({ timestamp: new Date(timestamp), issue: `Warning issued: ${severeReasons.join('; ')}`, image: frame });
                    console.log(`[PROCTOR] Warning for ${username}: ${severeReasons.join('; ')}`);
                }
            } else {
                if (procLog.meta.warning && procLog.meta.warning.active) {
                    procLog.meta.warning = null;
                    procLog.flags.push({ timestamp: new Date(timestamp), issue: 'Warning cleared - behavior normal' });
                    console.log(`[PROCTOR] Warning cleared for ${username}`);
                }
            }

            const WINDOW_MS = 60 * 1000;
            const nowMs = Date.now();
            const recentFlags = procLog.flags.filter(f => {
                try { return (nowMs - new Date(f.timestamp).getTime()) <= WINDOW_MS; } catch (e) { return false; }
            }).length;
            console.log(`[PROCTOR] ${username}. Total: ${procLog.flags.length}, Recent(60s): ${recentFlags}, action=${action}`);

            // ── Apply Cheat Score Deductions ──────────────────────────────────
            if (procLog.cheatScore === undefined || procLog.cheatScore === null) procLog.cheatScore = 100;

            // Tab switches (sent by client)
            for (const f of (clientFlags || [])) {
                if (/tab switch/i.test(f))
                    await applyCheatDeduction(procLog, 'tab_switch', 'Tab switch detected', timestamp);
            }
            // Eyes not focused
            if (eyes.looking_away)
                await applyCheatDeduction(procLog, 'eyes_away', 'Eyes not focused on screen', timestamp);
            // No face
            if (!faceDetected) {
                const absentMs = procLog.meta.absentStart ? (frameMs - procLog.meta.absentStart) : 0;
                if (absentMs >= 45000)
                    await applyCheatDeduction(procLog, 'absent_long', 'No face detected for extended period', timestamp);
                else
                    await applyCheatDeduction(procLog, 'absent_short', 'No face detected', timestamp);
            }
            // Multiple faces
            if (face.num_faces && face.num_faces > 1)
                await applyCheatDeduction(procLog, 'multiple_faces', `Multiple faces detected (${face.num_faces})`, timestamp);
            // Face mismatch
            if (analysis.face_mismatch_warning === true)
                await applyCheatDeduction(procLog, 'face_mismatch', 'Different person detected — identity mismatch', timestamp);
            // Device in frame
            if (/phone|mobile|smartphone|cell phone|headphone|headset|earbud|earbuds|pod|watch|smart watch|smartwatch|wearable|electronic gadget/i.test(reported)) {
                let violationType = 'device_detected';
                let reason = 'Mobile phone/device detected in frame';

                if (/headphone|headset|earbud|earbuds|pod/i.test(reported)) {
                    violationType = 'device_headphone';
                    reason = 'Headphones/earbuds detected in frame';
                } else if (/watch|smart watch|smartwatch|wearable/i.test(reported)) {
                    violationType = 'device_watch';
                    reason = 'Smart watch/wearable gadget detected in frame';
                }

                await applyCheatDeduction(procLog, violationType, reason, timestamp);
            }
        }

        // Mark meta as modified (mixed type needs explicit marking)
        procLog.markModified('meta');
        procLog.markModified('scoreHistory');
        await procLog.save();

        res.json({ success: true, analysis, action, message, cheatScore: procLog.cheatScore ?? 100 });
    } catch (error) {
        console.error('Proctoring error:', error);
        res.json({ success: false, error: 'AI service unavailable', analysis: { flags: [] }, cheatScore: null });
    }
});

// API: Student — get own cheat score
app.get('/api/student/cheat-score', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const procLog  = await ProctorLog.findOne({ username });
        const score    = procLog ? (procLog.cheatScore ?? 100) : 100;
        const history  = procLog ? (procLog.scoreHistory || []) : [];
        let classification = 'Safe';
        if (score < 70)       classification = 'Cheating Detected';
        else if (score < 90)  classification = 'Suspicious';
        res.json({ score, classification, history });
    } catch (e) {
        res.status(500).json({ score: 100, classification: 'Safe', history: [] });
    }
});

// API: Get proctoring report (admin) — includes human-readable failure reasons
app.get('/api/proctor/report/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const procLog  = await ProctorLog.findOne({ username }) || { frames: [], flags: [] };
        const examResult = await Result.findOne({ username });

        const localFlags = procLog.flags || [];

        const frameWarnings = (procLog.frames || []).flatMap(frame => {
            const analysis = frame.analysis || {};
            const issues = [];
            const action = String(analysis.action || '').toLowerCase();
            const message = String(analysis.message || '').toLowerCase();
            const flags = Array.isArray(analysis.flags) ? analysis.flags : [];

            if (action === 'warning' || /warning/.test(message)) {
                issues.push({
                    timestamp: frame.timestamp,
                    issue: analysis.message || 'Proctoring warning',
                    metrics: {},
                    source: 'frame_warning'
                });
            }

            for (const flag of flags) {
                if (flag) {
                    issues.push({
                        timestamp: frame.timestamp,
                        issue: flag,
                        metrics: {},
                        source: 'frame_warning'
                    });
                }
            }

            return issues;
        });

        // Try to also pull the detailed violation log from the AI service
        let aiViolations = [];
        try {
            const aiResp = await axios.get(`${AI_SERVICE_URL}/violation_log/${username}`, { timeout: 3000 });
            aiViolations = aiResp.data.violations || [];
        } catch (e) { /* AI service may not be running */ }

        const merged = [];
        for (const v of aiViolations) {
            merged.push({
                timestamp: v.timestamp, issue: v.human_reason || v.violation_type,
                violation_type: v.violation_type, metrics: v.metrics || {}, source: 'ai_confirmed'
            });
        }
        for (const f of localFlags) {
            merged.push({ timestamp: f.timestamp, issue: f.issue, image: f.image || null, source: 'local' });
        }
        for (const f of frameWarnings) {
            merged.push(f);
        }
        merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        const totalFlags = merged.length;
        let riskLevel = 'NONE';
        if (totalFlags >= 8) riskLevel = 'HIGH';
        else if (totalFlags >= 4) riskLevel = 'MEDIUM';
        else if (totalFlags > 0) riskLevel = 'LOW';

        res.json({
            username,
            totalFrames: procLog.frames ? procLog.frames.length : 0,
            totalFlags, flags: merged, riskLevel,
            cheatScore: procLog.cheatScore ?? 100,
            scoreHistory: procLog.scoreHistory || [],
            examResult: examResult ? {
                score: examResult.score, totalMCQ: examResult.totalMCQ,
                percentage: examResult.percentage, passed: examResult.passed,
                timestamp: examResult.timestamp
            } : null
        });
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API: Admin - Upload new exam questions
app.post('/api/admin/exam', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

        const { questions } = req.body;
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'Questions must be a non-empty array' });
        }

        for (const q of questions) {
            if (!q.id || !q.type || !q.question)
                return res.status(400).json({ error: 'Each question must have id, type, and question fields' });
            if (q.type === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2))
                return res.status(400).json({ error: 'MCQ questions must have an options array with at least 2 choices' });
        }

        await QuestionBank.findOneAndUpdate(
            { name: 'default' },
            { name: 'default', questions },
            { upsert: true, new: true }
        );
        console.log(`[ADMIN] Uploaded ${questions.length} questions by ${req.user.username}`);
        res.json({ success: true, message: `Uploaded ${questions.length} questions successfully` });
    } catch (error) {
        console.error('Admin exam upload error:', error);
        res.status(500).json({ error: 'Failed to save questions' });
    }
});

// API: Student - Get own results
app.get('/api/student/results', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const myResult = await Result.findOne({ username });
        const procLog  = await ProctorLog.findOne({ username });

        let riskLevel = 'NONE';
        let flags = [];
        let totalFrames = 0;

        if (procLog) {
            // Strip base64 image data from flags before sending to student
            flags = (procLog.flags || []).map(f => ({ timestamp: f.timestamp, issue: f.issue }));
            totalFrames = (procLog.frames || []).length;
            if (flags.length >= 10) riskLevel = 'HIGH';
            else if (flags.length >= 5) riskLevel = 'MEDIUM';
            else if (flags.length > 0) riskLevel = 'LOW';
        }

        res.json({
            username,
            result: myResult,
            proctoring: { totalFrames, flags, riskLevel }
        });
    } catch (error) {
        console.error('Student results error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API: Admin - Get all users status
app.get('/api/admin/users', async (req, res) => {
    try {
        const users    = await User.find({ username: { $ne: 'admin' } }, 'username role');
        const procLogs = await ProctorLog.find({}, 'username flags frames');
        const results  = await Result.find({}, 'username percentage');

        const procMap   = {};
        procLogs.forEach(p => { procMap[p.username] = p; });
        const resultMap = {};
        results.forEach(r => { resultMap[r.username] = r; });

        const userList = users.map(u => {
            const username   = u.username;
            const procData   = procMap[username] || { flags: [], frames: [] };
            const resData    = resultMap[username];

            const frameWarningCount = (procData.frames || []).filter(frame => {
                const analysis = frame.analysis || {};
                const action = String(analysis.action || '').toLowerCase();
                const message = String(analysis.message || '').toLowerCase();
                const flags = Array.isArray(analysis.flags) ? analysis.flags : [];
                return action === 'warning' || /warning/.test(message) || flags.length > 0;
            }).length;
            const violationCount = (procData.flags || []).length + frameWarningCount;
            const cheatScore     = procData.cheatScore ?? 100;
            let status = 'active';
            let score  = null;

            if (resData) { status = 'finished'; score = resData.percentage; }

            const frames = procData.frames || [];
            return {
                username, status, score, violationCount, cheatScore,
                lastActive: frames.length > 0 ? frames[frames.length - 1].timestamp : new Date().toISOString()
            };
        });

        res.json(userList);
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json([]);
    }
});

// API: Admin - Reset user
app.post('/api/admin/reset/:username', async (req, res) => {
    try {
        const { username } = req.params;
        await ProctorLog.deleteOne({ username });
        await Result.deleteOne({ username });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Reset error' });
    }
});

// ────────────────────────────────────────────────────────────────────────────
// FACE VERIFICATION & ENROLLMENT ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────

// API: Initiate face enrollment (called when student clicks "Start Exam")
app.post('/api/enroll/initiate', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        
        // Notify AI service to start enrollment
        const aiRes = await postAiWithRetry(`${AI_SERVICE_URL}/enroll/initiate/${username}`, {}, { timeout: 15000 });
        
        res.json({
            success: true,
            message: 'Face enrollment initiated. Please position your face in the camera.',
            frames_needed: aiRes.data.frames_needed || 3,
            username
        });
    } catch (error) {
        console.error('Enrollment initiate error:', error.message);
        res.json({ success: false, error: 'Could not initiate face enrollment', frames_needed: 3 });
    }
});

// API: Capture enrollment frame (called multiple times during enrollment)
app.post('/api/enroll/capture', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const { frame } = req.body;
        
        if (!frame) return res.status(400).json({ error: 'No frame provided' });
        
        const aiRes = await postAiWithRetry(
            `${AI_SERVICE_URL}/enroll/capture/${username}`,
            { frame },
            { timeout: 20000 }
        );
        
        res.json(aiRes.data);
    } catch (error) {
        const status = error.response && error.response.status;
        console.error('Enrollment capture error:', status ? `status ${status}` : error.message);
        res.status(200).json({ 
            captured: false, 
            error: 'Face capture service is temporarily unavailable. Please try again.',
            frames_collected: 0,
            frames_needed: 3,
            retryable: true
        });
    }
});

// API: Finalize face enrollment (called after sufficient frames captured)
app.post('/api/enroll/finalize', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        
        const aiRes = await postAiWithRetry(`${AI_SERVICE_URL}/enroll/finalize/${username}`, {}, { timeout: 5000 });
        
        res.json(aiRes.data);
    } catch (error) {
        console.error('Enrollment finalize error:', error.message);
        res.status(200).json({ success: false, error: 'Face verification finalization is temporarily unavailable' });
    }
});

// API: Get enrollment status
app.get('/api/enroll/status', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        
        const aiRes = await axios.get(`${AI_SERVICE_URL}/enroll/status/${username}`, { timeout: 5000 });
        
        res.json(aiRes.data);
    } catch (error) {
        console.error('Enrollment status error:', error.message);
        res.json({ enrolled: false, error: 'Could not fetch enrollment status' });
    }
});

// Start server
if (sslOptions) {
    https.createServer(sslOptions, app).listen(PORT, () => {
        console.log(`✅ HTTPS server on https://localhost:${PORT}`);
        console.log(`🤖 AI Service URL: ${AI_SERVICE_URL}`);
        console.log(`🗄️  MongoDB URI: ${MONGO_URI}`);
    });
} else {
    app.listen(PORT, () => {
        console.log(`✅ Exam Portal Backend running on http://localhost:${PORT}`);
        console.log(`🤖 AI Service URL: ${AI_SERVICE_URL}`);
        console.log(`🗄️  MongoDB URI: ${MONGO_URI}`);
        console.log('ℹ️  HTTPS certs not found. Generate localhost+1-key.pem and localhost+1.pem with mkcert to enable HTTPS.');
    });
}
