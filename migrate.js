/**
 * migrate.js — One-time migration from local JSON files → MongoDB
 *
 * Usage:
 *   1. Make sure MONGO_URI is set in your .env (or the default local one works)
 *   2. node migrate.js
 *
 * What it migrates:
 *   data/users.json       → users collection
 *   data/exams.json       → exams collection
 *   data/answers.json     → results collection
 *   data/proctoring.json  → proctorlogs collection
 *   data/questions.json   → questionbanks collection (stored as "default")
 */

require('dotenv').config();
const fs        = require('fs').promises;
const path      = require('path');
const mongoose  = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/proctorguard';
const DATA_DIR  = path.join(__dirname, 'data');

// ── Schemas (mirrors server.js) ───────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role:     { type: String, default: 'student' }
});

const examQuestionSchema = new mongoose.Schema({
    id: mongoose.Schema.Types.Mixed,
    type: String,
    question: String,
    options: [String],
    correctAnswer: mongoose.Schema.Types.Mixed
}, { _id: false });

const examSchema = new mongoose.Schema({
    id:         { type: String, required: true, unique: true },
    title:      String,
    courseCode: String,
    badge:      String,
    startTime:  Date,
    endTime:    Date,
    duration:   Number,
    questions:  [examQuestionSchema],
    createdAt:  Date,
    createdBy:  String
});

const resultSchema = new mongoose.Schema({
    username:   String,
    answers:    mongoose.Schema.Types.Mixed,
    score:      Number,
    totalMCQ:   Number,
    percentage: Number,
    passed:     Boolean,
    examId:     String,
    timestamp:  Date
});

const proctorLogSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    flags:    [{ timestamp: Date, issue: String, image: String }],
    frames:   [{ timestamp: Date, analysis: mongoose.Schema.Types.Mixed }],
    meta:     mongoose.Schema.Types.Mixed
});

const questionBankSchema = new mongoose.Schema({
    name:      { type: String, default: 'default' },
    questions: [examQuestionSchema]
});

const User        = mongoose.model('User',        userSchema);
const Exam        = mongoose.model('Exam',        examSchema);
const Result      = mongoose.model('Result',      resultSchema);
const ProctorLog  = mongoose.model('ProctorLog',  proctorLogSchema);
const QuestionBank = mongoose.model('QuestionBank', questionBankSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function readJSON(filename) {
    try {
        const data = await fs.readFile(path.join(DATA_DIR, filename), 'utf8');
        return JSON.parse(data);
    } catch (e) { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function migrate() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB:', MONGO_URI);

    // 1. Users
    const usersRaw = await readJSON('users.json');
    if (usersRaw) {
        let count = 0;
        for (const [username, val] of Object.entries(usersRaw)) {
            const password = typeof val === 'string' ? val : val.password;
            const role     = typeof val === 'object' && val.role ? val.role : 'student';
            try {
                await User.updateOne({ username }, { username, password, role }, { upsert: true });
                count++;
            } catch (e) { console.warn(`  ⚠ Skipped user ${username}:`, e.message); }
        }
        console.log(`👤 Migrated ${count} users`);
    } else {
        console.log('⏭ No users.json found — skipping');
    }

    // 2. Exams
    const examsRaw = await readJSON('exams.json');
    if (Array.isArray(examsRaw)) {
        let count = 0;
        for (const exam of examsRaw) {
            try {
                await Exam.updateOne({ id: exam.id }, exam, { upsert: true });
                count++;
            } catch (e) { console.warn(`  ⚠ Skipped exam ${exam.id}:`, e.message); }
        }
        console.log(`📝 Migrated ${count} exams`);
    } else {
        console.log('⏭ No exams.json found — skipping');
    }

    // 3. Answers → Results
    const answersRaw = await readJSON('answers.json');
    if (answersRaw && typeof answersRaw === 'object') {
        let count = 0;
        for (const [username, val] of Object.entries(answersRaw)) {
            try {
                await Result.updateOne(
                    { username },
                    {
                        username,
                        answers:    val.answers || {},
                        score:      val.score,
                        totalMCQ:   val.totalMCQ,
                        percentage: val.percentage,
                        passed:     val.passed,
                        examId:     val.examId || null,
                        timestamp:  val.timestamp ? new Date(val.timestamp) : new Date()
                    },
                    { upsert: true }
                );
                count++;
            } catch (e) { console.warn(`  ⚠ Skipped answer for ${username}:`, e.message); }
        }
        console.log(`📊 Migrated ${count} results`);
    } else {
        console.log('⏭ No answers.json found — skipping');
    }

    // 4. Proctoring logs
    const proctRaw = await readJSON('proctoring.json');
    if (proctRaw && typeof proctRaw === 'object') {
        let count = 0;
        for (const [username, val] of Object.entries(proctRaw)) {
            const flags  = (val.flags  || []).map(f => ({
                timestamp: f.timestamp ? new Date(f.timestamp) : new Date(),
                issue:     f.issue,
                image:     f.image || null
            }));
            // frames: strip base64 images from clean (non-flagged) frames to save space
            const frames = (val.frames || []).map(f => ({
                timestamp: f.timestamp ? new Date(f.timestamp) : new Date(),
                analysis:  f.analysis || {}
            }));
            try {
                await ProctorLog.updateOne(
                    { username },
                    { username, flags, frames, meta: val.meta || {} },
                    { upsert: true }
                );
                count++;
            } catch (e) { console.warn(`  ⚠ Skipped proctor log for ${username}:`, e.message); }
        }
        console.log(`🎥 Migrated ${count} proctor logs`);
    } else {
        console.log('⏭ No proctoring.json found — skipping');
    }

    // 5. Question bank
    const questionsRaw = await readJSON('questions.json');
    if (Array.isArray(questionsRaw) && questionsRaw.length > 0) {
        await QuestionBank.updateOne(
            { name: 'default' },
            { name: 'default', questions: questionsRaw },
            { upsert: true }
        );
        console.log(`❓ Migrated ${questionsRaw.length} questions`);
    } else {
        console.log('⏭ No questions.json found — skipping');
    }

    await mongoose.disconnect();
    console.log('\n🎉 Migration complete!');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
