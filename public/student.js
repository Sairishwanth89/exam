/**
 * student.js — Student dashboard logic
 * Handles: auth guard (blocks admins), tab switching,
 *           dynamic exam loading, exam attempt start, results display
 */

const STUDENT = {
    token: sessionStorage.getItem('token'),
    role:  sessionStorage.getItem('role'),
    name:  sessionStorage.getItem('username'),

    // ── Boot ──────────────────────────────────────────────────────────────
    init() {
        // Redirect if not logged in
        if (!this.token || !this.name) {
            window.location.href = '/login.html';
            return;
        }

        // Decode JWT to get the server-authoritative role (don't just trust sessionStorage)
        try {
            const payload = JSON.parse(atob(this.token.split('.')[1]));
            const jwtRole = payload.role;
            // Keep sessionStorage in sync with the actual JWT
            if (jwtRole) {
                sessionStorage.setItem('role', jwtRole);
                this.role = jwtRole;
            }
        } catch(e) {
            // If JWT is malformed, boot them out
            sessionStorage.clear();
            window.location.href = '/login.html';
            return;
        }

        // Redirect admins to the admin dashboard
        if (this.role === 'admin') {
            window.location.href = '/admin.html';
            return;
        }

        document.getElementById('student-name').textContent = '(' + this.name.toUpperCase() + ')';
        this.loadAssignments();
    },

    logout() {
        sessionStorage.clear();
        window.location.href = '/';
    },

    // ── Tab switching ─────────────────────────────────────────────────────
    switchTab(tab) {
        document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.s-panel').forEach(p => p.classList.remove('active'));
        document.querySelector(`.s-tab[data-tab="${tab}"]`).classList.add('active');
        document.getElementById('panel-' + tab).classList.add('active');
        if (tab === 'results') this.loadResults();
    },

    // ── Assignments (dynamic from server) ────────────────────────────────
    async loadAssignments() {
        const container = document.getElementById('assign-list');
        container.innerHTML = '<div class="loading-state"><span class="loader"></span><p>Loading assignments...</p></div>';

        try {
            const resp  = await fetch('/api/exams', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!resp.ok) throw new Error(`Server responded ${resp.status}`);
            const exams = await resp.json();

            if (!Array.isArray(exams) || exams.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">📭</div>
                        <p class="empty-title">No assignments yet</p>
                        <p class="empty-sub">Your instructor hasn't published any active exams.</p>
                    </div>`;
                return;
            }

            container.innerHTML = exams.map(e => this.renderCard(e)).join('');
        } catch (err) {
            console.error('Load assignments failed:', err);
            container.innerHTML = `
                <div class="empty-state err">
                    <div class="empty-icon">⚠️</div>
                    <p class="empty-title">Could not load assignments</p>
                    <p class="empty-sub">${err.message}. Make sure the server is running.</p>
                    <button class="btn-retry" onclick="STUDENT.loadAssignments()">Try Again</button>
                </div>`;
        }
    },

    renderCard(e) {
        const now  = new Date();
        const s    = e.startTime ? new Date(e.startTime) : null;
        const end  = e.endTime   ? new Date(e.endTime)   : null;
        const ended    = end && now > end;
        const upcoming = s   && now < s;

        const statusTxt = ended ? 'Ended' : upcoming ? 'Upcoming' : 'In Progress';
        const dotCls    = ended ? 'dot-ended' : upcoming ? 'dot-upcoming' : 'dot-active';
        const dueTxt    = end   ? `Due: ${end.toLocaleString()}`
                        : s     ? `Starts: ${s.toLocaleString()}`
                        :         'Open · No deadline';

        return `
        <div class="a-card">
            <div class="a-card-left">
                <span class="course-code">${e.courseCode || '—'}</span>
                <span class="badge-pill">${e.badge}</span>
            </div>
            <div class="a-card-body">
                <h3 class="a-card-title">${e.title}</h3>
                <div class="a-card-chips">
                    <span class="chip">⏱ ${e.duration} min</span>
                    <span class="chip">❓ ${e.questionCount} questions</span>
                </div>
                <div class="a-card-footer">
                    <div class="status-row">
                        <span class="dot ${dotCls}"></span>
                        <span class="status-text">${statusTxt}</span>
                    </div>
                    <span class="due-text">${dueTxt}</span>
                    <button
                        class="btn-attempt"
                        onclick="STUDENT.startExam('${e.id}')"
                        ${ended ? 'disabled' : ''}>
                        ATTEMPT
                    </button>
                </div>
            </div>
        </div>`;
    },

    startExam(examId) {
        sessionStorage.setItem('currentExamId', examId);
        window.location.href = '/exam.html';
    },

    // ── Results ───────────────────────────────────────────────────────────
    async loadResults() {
        const container = document.getElementById('results-body');
        container.innerHTML = '<div class="loading-state"><span class="loader"></span><p>Loading your results...</p></div>';

        try {
            const resp = await fetch('/api/student/results', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!resp.ok) throw new Error(`Server error ${resp.status}`);
            const data = await resp.json();
            this.renderResults(data, container);
        } catch (err) {
            container.innerHTML = `<div class="empty-state err"><div class="empty-icon">❌</div><p>${err.message}</p></div>`;
        }
    },

    renderResults(data, container) {
        if (!data.result) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📝</div>
                    <p class="empty-title">No results yet</p>
                    <p class="empty-sub">Submit an exam to see your score and proctoring report here.</p>
                </div>`;
            return;
        }

        const r = data.result;
        const p = data.proctoring || { flags: [], riskLevel: 'NONE' };
        const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
        const passedClass = r.passed ? 'verdict-pass' : 'verdict-fail';
        const passedLabel = r.passed ? '✅ PASSED' : '❌ FAILED';

        // Build proof section if there are violations
        const withPhotos = p.flags.filter(f => f.image);
        const withoutPhotos = p.flags.filter(f => !f.image);
        let proofHtml = '';

        if (withPhotos.length > 0) {
            proofHtml += `<div class="proof-section">
                <h4 class="proof-title">🚨 Fraud Evidence — ${withPhotos.length} violation(s) captured</h4>
                ${withPhotos.map(f => `
                    <div class="proof-item fraud">
                        <div class="proof-ts">🕒 ${new Date(f.timestamp).toLocaleString()}</div>
                        <p class="proof-msg">${f.issue}</p>
                        <img src="${f.image}" alt="Cheating evidence" class="proof-img">
                    </div>`).join('')}
            </div>`;
        }
        if (withoutPhotos.length > 0) {
            proofHtml += `<div class="proof-section">
                <h4 class="proof-title">⚠️ Other Flags — ${withoutPhotos.length} event(s)</h4>
                ${withoutPhotos.map(f => `
                    <div class="proof-item warning">
                        <div class="proof-ts">🕒 ${new Date(f.timestamp).toLocaleString()}</div>
                        <p class="proof-msg">${f.issue}</p>
                    </div>`).join('')}
            </div>`;
        }

        container.innerHTML = `
            <div class="result-card">
                <div class="result-header">
                    <div class="score-ring">
                        <span class="score-pct">${r.percentage}%</span>
                        <span class="score-sub">Score</span>
                    </div>
                    <div class="result-meta">
                        <h2 class="result-title">Exam Result</h2>
                        <p>Correct answers: <strong>${r.score} / ${r.totalMCQ}</strong></p>
                        <p>Submitted: ${ts}</p>
                        <div class="verdict-row">
                            <span class="verdict ${passedClass}">${passedLabel}</span>
                            <span class="risk-badge risk-${p.riskLevel}">Integrity: ${p.riskLevel}</span>
                        </div>
                    </div>
                </div>
                ${proofHtml}
            </div>`;
    }
};

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => STUDENT.init());
