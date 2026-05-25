/**
 * admin.js — Admin dashboard logic
 * Handles: auth guard, tab navigation, dashboard stats,
 *           exam creation (visual builder), exam management, student monitoring
 */

// ── Interactive Question Builder ─────────────────────────────────────────────
const BUILDER = {
    questions: [], // [{id, type, text, options:[], correctAnswer}]
    nextId: 1,

    init() {
        // Badge picker
        document.querySelectorAll('.badge-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.badge-opt').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('f-badge').value = btn.dataset.val;
                this.updatePreview();
            });
        });
        // Live preview on title/code change
        ['f-title','f-code'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => this.updatePreview());
        });
    },

    addQ(type) {
        const q = { id: this.nextId++, type, text: '', options: type === 'mcq' ? ['','','',''] : [], correctAnswer: 0 };
        this.questions.push(q);
        this._renderAll();
        // Scroll to new card
        setTimeout(() => {
            const cards = document.querySelectorAll('.q-card');
            if (cards.length) cards[cards.length-1].scrollIntoView({ behavior:'smooth', block:'nearest' });
        }, 50);
    },

    removeQ(id) {
        this.questions = this.questions.filter(q => q.id !== id);
        this._renderAll();
    },

    addOption(qId) {
        const q = this.questions.find(q => q.id === qId);
        if (q) { q.options.push(''); this._renderCard(q); }
    },

    removeOption(qId, optIdx) {
        const q = this.questions.find(q => q.id === qId);
        if (!q) return;
        q.options.splice(optIdx, 1);
        if (q.correctAnswer >= q.options.length) q.correctAnswer = Math.max(0, q.options.length - 1);
        this._renderCard(q);
    },

    setCorrect(qId, idx) {
        const q = this.questions.find(q => q.id === qId);
        if (q) q.correctAnswer = idx;
    },

    updateText(qId, val) {
        const q = this.questions.find(q => q.id === qId);
        if (q) { q.text = val; this.updatePreview(); }
    },

    updateOption(qId, idx, val) {
        const q = this.questions.find(q => q.id === qId);
        if (q && q.options) q.options[idx] = val;
    },

    loadExample() {
        this.questions = [
            { id: this.nextId++, type:'mcq',   text:'What does OS stand for?',                    options:['Open Source','Operating System','Output Signal','None'], correctAnswer:1 },
            { id: this.nextId++, type:'mcq',   text:'Which is a process scheduling algorithm?',  options:['BIOS','FIFO','HTML','CSS'],                              correctAnswer:1 },
            { id: this.nextId++, type:'short', text:'Briefly explain the role of RAM.',            options:[], correctAnswer:null },
        ];
        this._renderAll();
    },

    getJSON() {
        return this.questions.map((q, i) => ({
            id: i + 1, type: q.type, question: q.text,
            ...(q.type === 'mcq' ? { options: q.options, correctAnswer: q.correctAnswer } : { correctAnswer: null })
        }));
    },

    showJSON() {
        const json = JSON.stringify(this.getJSON(), null, 2);
        document.getElementById('json-view-content').textContent = json;
        const ov = document.getElementById('json-view-overlay');
        ov.style.display = 'flex';
    },

    updatePreview() {
        const title = (document.getElementById('f-title') || {}).value || '(untitled)';
        const code  = (document.getElementById('f-code')  || {}).value || '';
        const badge = (document.getElementById('f-badge') || {}).value || 'EXAM';
        const dur   = (document.getElementById('f-duration') || {}).value || '?';
        const qCount = this.questions.length;
        const el = document.getElementById('exam-preview');
        if (!el) return;
        el.innerHTML = qCount === 0
            ? '<span style="color:#64748b">Add questions to see the preview.</span>'
            : `<strong style="color:#f1f5f9">${title}</strong>${code ? ` · <span style="color:#94a3b8">${code}</span>` : ''}
               <span style="background:rgba(99,102,241,.2);color:#a5b4fc;padding:.1rem .45rem;border-radius:5px;font-size:.72rem;margin-left:.4rem;">${badge}</span>
               <br><span style="font-size:.8rem;color:#94a3b8;">${qCount} question${qCount!==1?'s':''} · ${dur} min</span>`;
    },

    _renderAll() {
        const list = document.getElementById('q-builder-list');
        const empty = document.getElementById('q-empty-state');
        if (!list) return;
        // Remove all q-card elements
        list.querySelectorAll('.q-card').forEach(c => c.remove());
        if (this.questions.length === 0) {
            if (empty) empty.style.display = '';
        } else {
            if (empty) empty.style.display = 'none';
            this.questions.forEach(q => { const card = this._buildCard(q); list.appendChild(card); });
        }
        // Update badge counter
        const badge = document.getElementById('q-count-badge');
        if (badge) badge.textContent = `${this.questions.length} question${this.questions.length!==1?'s':''}`;
        this.updatePreview();
    },

    _renderCard(q) {
        const old = document.getElementById(`qcard-${q.id}`);
        if (old) old.replaceWith(this._buildCard(q));
    },

    _buildCard(q) {
        const idx = this.questions.indexOf(q) + 1;
        const div = document.createElement('div');
        div.className = 'q-card'; div.id = `qcard-${q.id}`;

        let inner = `<button class="btn-del-q" onclick="BUILDER.removeQ(${q.id})">✕ Remove</button>
            <div class="q-card-header">
                <div class="q-num">${idx}</div>
                <span class="q-type-badge q-type-${q.type}">${q.type === 'mcq' ? 'MCQ' : 'Short Answer'}</span>
            </div>
            <input class="q-input" placeholder="Question text..." value="${q.text.replace(/"/g,'&quot;')}"
                oninput="BUILDER.updateText(${q.id},this.value)">\n`;

        if (q.type === 'mcq') {
            inner += `<div style="margin-top:.5rem;font-size:.75rem;color:#94a3b8;margin-bottom:.2rem;">Options — click ● to mark correct answer</div>`;
            q.options.forEach((opt, oi) => {
                const isCorrect = q.correctAnswer === oi;
                inner += `<div class="opt-row">
                    <input type="radio" class="opt-radio" name="correct-${q.id}" ${isCorrect?'checked':''}
                        onchange="BUILDER.setCorrect(${q.id},${oi})" title="Mark as correct">
                    <input class="q-input" style="flex:1" placeholder="Option ${oi+1}" value="${opt.replace(/"/g,'&quot;')}"
                        oninput="BUILDER.updateOption(${q.id},${oi},this.value)">
                    <button class="opt-del" onclick="BUILDER.removeOption(${q.id},${oi})" title="Remove option">✕</button>
                </div>`;
            });
            inner += `<button class="btn-add-opt" onclick="BUILDER.addOption(${q.id})">+ Add Option</button>`;
        } else {
            inner += `<div style="margin-top:.35rem;font-size:.75rem;color:#94a3b8;">📝 Students type a free-text answer (manually graded)</div>`;
        }
        div.innerHTML = inner;
        return div;
    }
};

const ADMIN = {
    token: sessionStorage.getItem('token'),
    role:  sessionStorage.getItem('role'),
    name:  sessionStorage.getItem('username'),

    // ── Boot ────────────────────────────────────────────────────────────────
    init() {
        if (!this.token) { window.location.href = '/login.html'; return; }
        try {
            const payload = JSON.parse(atob(this.token.split('.')[1]));
            const jwtRole = payload.role;
            if (jwtRole) { sessionStorage.setItem('role', jwtRole); this.role = jwtRole; }
        } catch(e) { sessionStorage.clear(); window.location.href = '/login.html'; return; }
        if (this.role !== 'admin') { window.location.href = '/dashboard.html'; return; }
        document.getElementById('adminName').textContent = this.name || 'Admin';
        this.loadStats();
        BUILDER.init();
        setInterval(() => {
            if (document.getElementById('page-students').classList.contains('active'))
                this.loadStudents();
        }, 8000);
    },

    logout() {
        sessionStorage.clear();
        window.location.href = '/';
    },

    // ── Navigation ────────────────────────────────────────────────────────
    go(pageId) {
        document.querySelectorAll('.a-page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.a-tab').forEach(t => t.classList.remove('active'));
        document.getElementById('page-' + pageId).classList.add('active');
        document.querySelector(`.a-tab[data-page="${pageId}"]`).classList.add('active');

        if (pageId === 'manageExams') this.loadExams();
        if (pageId === 'students')    this.loadStudents();
        if (pageId === 'dashboard')   this.loadStats();
    },

    // ── HTTP helper ───────────────────────────────────────────────────────
    async http(method, url, body) {
        const resp = await fetch(url, {
            method,
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: body ? JSON.stringify(body) : undefined
        });
        return resp.json();
    },

    // ── Dashboard Stats ───────────────────────────────────────────────────
    async loadStats() {
        try {
            const [students, exams] = await Promise.all([
                this.http('GET', '/api/admin/users'),
                this.http('GET', '/api/admin/exams')
            ]);
            document.getElementById('s-students').textContent = Array.isArray(students) ? students.length : '—';
            document.getElementById('s-active').textContent   = Array.isArray(students) ? students.filter(s => s.status === 'active').length : '—';
            document.getElementById('s-sessions').textContent = Array.isArray(exams)    ? exams.length : '—';
            document.getElementById('s-term').textContent     = Array.isArray(students) ? students.filter(s => s.status === 'terminated').length : '—';
        } catch (e) {
            console.error('Stats load failed', e);
        }
    },

    // ── Create Exam ───────────────────────────────────────────────────────
    fillExample() {
        document.getElementById('f-questions').value = JSON.stringify([
            { id: 1, type: 'mcq', question: 'What does OS stand for?', options: ['Open Source', 'Operating System', 'Output Signal', 'None'], correctAnswer: 1 },
            { id: 2, type: 'mcq', question: 'Which is a process scheduling algorithm?', options: ['BIOS', 'FIFO', 'HTML', 'CSS'], correctAnswer: 1 },
            { id: 3, type: 'short', question: 'Briefly explain the role of RAM.', correctAnswer: null }
        ], null, 2);
    },

    validateQ() { /* Legacy — builder replaces manual JSON */ },

    async publishExam() {
        const title    = document.getElementById('f-title').value.trim();
        const code     = document.getElementById('f-code').value.trim();
        const badge    = document.getElementById('f-badge').value;
        const duration = parseInt(document.getElementById('f-duration').value) || 30;
        const startRaw = document.getElementById('f-start').value;
        const endRaw   = document.getElementById('f-end').value;

        if (!title) { this.setMsg('create-msg', '❌ Exam title is required', 'err'); return; }

        // Use visual builder questions
        const questions = BUILDER.getJSON();
        if (!questions || questions.length === 0) {
            this.setMsg('create-msg', '❌ Add at least one question using the builder above', 'err'); return;
        }
        // Validate MCQ options
        for (const q of questions) {
            if (!q.question.trim()) { this.setMsg('create-msg', `❌ Question ${q.id} has no text`, 'err'); return; }
            if (q.type === 'mcq' && (!q.options || q.options.length < 2)) {
                this.setMsg('create-msg', `❌ MCQ ${q.id} needs at least 2 options`, 'err'); return;
            }
        }

        this.setMsg('create-msg', '⏳ Publishing...', '');
        try {
            const data = await this.http('POST', '/api/admin/exams', {
                title, courseCode: code, badge, duration, questions,
                startTime: startRaw ? new Date(startRaw).toISOString() : null,
                endTime:   endRaw   ? new Date(endRaw).toISOString()   : null
            });
            if (data.success) {
                const now = new Date();
                const startDt = startRaw ? new Date(startRaw) : null;
                const isFuture = startDt && startDt > now;
                const msg = isFuture
                    ? `✅ "${title}" saved! ⚠️ Opens at ${startDt.toLocaleString()}`
                    : `✅ "${title}" published! Students can attempt it now.`;
                this.setMsg('create-msg', msg, 'ok');
                this.clearForm();
            } else {
                this.setMsg('create-msg', `❌ ${data.error || 'Server error'}`, 'err');
            }
        } catch (e) {
            this.setMsg('create-msg', '❌ Could not reach server.', 'err');
        }
    },

    clearForm() {
        ['f-title','f-code'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
        document.getElementById('f-duration').value = '30';
        document.getElementById('dur-display') && (document.getElementById('dur-display').textContent = '30 min');
        document.getElementById('f-badge').value = 'EXAM';
        document.querySelectorAll('.badge-opt').forEach(b => b.classList.toggle('active', b.dataset.val === 'EXAM'));
        document.getElementById('f-start').value = '';
        document.getElementById('f-end').value   = '';
        BUILDER.questions = []; BUILDER.nextId = 1; BUILDER._renderAll();
        this.hideMsg('create-msg');
    },

    // ── Manage Exams ──────────────────────────────────────────────────────
    async loadExams() {
        const c = document.getElementById('exam-list');
        c.innerHTML = '<p class="loading-text">Loading exams...</p>';
        try {
            const exams = await this.http('GET', '/api/admin/exams');
            if (!Array.isArray(exams) || exams.length === 0) {
                c.innerHTML = `<div class="empty-state">
                    <div class="empty-icon">📭</div>
                    <p>No exams created yet.</p>
                    <button class="btn-primary-sm" onclick="ADMIN.go('createExam')">Create First Exam →</button>
                </div>`;
                return;
            }
            const now = new Date();
            c.innerHTML = exams.map(e => {
                const active = (!e.startTime || new Date(e.startTime) <= now) && (!e.endTime || new Date(e.endTime) >= now);
                const sTime  = e.startTime ? new Date(e.startTime).toLocaleString() : 'Open immediately';
                const eTime  = e.endTime   ? new Date(e.endTime).toLocaleString()   : 'No deadline';
                return `
                <div class="exam-row">
                    <div class="exam-bdg">${e.badge}</div>
                    <div class="exam-info">
                        <div class="exam-title">${e.title}</div>
                        <div class="exam-meta">${e.courseCode || 'No course code'} · ${e.questions.length} questions · ${e.duration} min</div>
                        <div class="exam-meta">🕐 ${sTime} → ⏰ ${eTime}</div>
                    </div>
                    <span class="status-chip ${active ? 'chip-active' : 'chip-inactive'}">${active ? '🟢 Active' : '⏸ Inactive'}</span>
                    <button class="btn-delete" onclick="ADMIN.deleteExam('${e.id}', '${e.title.replace(/'/g, '')}')">🗑 Delete</button>
                </div>`;
            }).join('');
        } catch (e) {
            c.innerHTML = '<p class="err-text">❌ Could not load exams. Is the server running?</p>';
        }
    },

    async deleteExam(id, title) {
        if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
        await this.http('DELETE', `/api/admin/exams/${id}`);
        this.loadExams();
    },

    // ── Students ──────────────────────────────────────────────────────────
    async loadStudents() {
        const tbody = document.getElementById('student-tbody');
        try {
            const users = await this.http('GET', '/api/admin/users');
            if (!Array.isArray(users) || users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No students registered yet.</td></tr>';
                return;
            }
            tbody.innerHTML = users.map(u => {
                const cs      = u.cheatScore ?? 100;
                const csCls   = cs >= 90 ? 'safe' : cs >= 70 ? 'warn' : 'danger';
                const csLabel = cs >= 90 ? 'Safe' : cs >= 70 ? 'Suspicious' : 'Cheating';
                return `
                <tr>
                    <td><strong>${u.username}</strong></td>
                    <td><span class="pill pill-${u.status}">${u.status}</span></td>
                    <td>${u.score != null ? u.score + '%' : '—'}</td>
                    <td>
                        <span class="cs-pill cs-pill-${csCls}">${cs}% — ${csLabel}</span>
                    </td>
                    <td style="color:${u.violationCount > 5 ? '#fca5a5' : 'inherit'}">${u.violationCount}</td>
                    <td class="muted-text">${new Date(u.lastActive).toLocaleTimeString()}</td>
                    <td>
                        <button class="btn-xs btn-xs-blue" onclick="ADMIN.viewLogs('${u.username}')">Logs</button>
                        ${u.status === 'terminated' ? `<button class="btn-xs btn-xs-warn" onclick="ADMIN.resetUser('${u.username}')">Reset</button>` : ''}
                    </td>
                </tr>`;
            }).join('');
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="6" class="err-text">Failed to load students.</td></tr>';
        }
    },

    async viewLogs(username) {
        const data  = await this.http('GET', `/api/proctor/report/${username}`);
        document.getElementById('modal-student').textContent = username;
        const body  = document.getElementById('modal-body');

        // Deduction map (mirrors server CHEAT_DEDUCTIONS)
        const DEDUCTIONS = {
            tab_switch: 1, eyes_away: 2, absent_short: 3, absent_long: 5,
            multiple_faces: 10, face_mismatch: 20, device_detected: 10,
            device_phone: 10, device_earbud: 10,
        };
        const VIOLATION_META = {
            tab_switch:      { icon: '🗂️', label: 'Tab Switch',       color: '#f59e0b', pts: 1  },
            eyes_away:       { icon: '👁️', label: 'Eyes Away',        color: '#f59e0b', pts: 2  },
            absent_short:    { icon: '👤', label: 'Face Absent',       color: '#ef4444', pts: 3  },
            absent_long:     { icon: '🚪', label: 'Long Absence',      color: '#ef4444', pts: 5  },
            multiple_faces:  { icon: '👥', label: 'Multiple People',   color: '#a855f7', pts: 10 },
            face_mismatch:   { icon: '🎭', label: 'Identity Mismatch', color: '#ef4444', pts: 20 },
            device_phone:    { icon: '📱', label: 'Phone Detected',    color: '#ef4444', pts: 10 },
            device_earbud:   { icon: '🎧', label: 'Earbuds Detected',  color: '#f97316', pts: 10 },
            device_detected: { icon: '📱', label: 'Device Detected',   color: '#ef4444', pts: 10 },
        };

        // ── Integrity score block ──────────────────────────────────────────
        const cs     = data.cheatScore ?? 100;
        const csCls  = cs >= 90 ? '#10b981' : cs >= 70 ? '#f59e0b' : '#ef4444';
        const csLbl  = cs >= 90 ? '✅ Safe' : cs >= 70 ? '⚠️ Suspicious' : '🚨 Cheating Detected';

        let html = `
        <div style="background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(236,72,153,.1));border:1px solid rgba(99,102,241,.25);border-radius:14px;padding:1.1rem 1.25rem;margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;">
                <span style="font-weight:700;font-size:.95rem;">🛡️ Integrity Score</span>
                <span style="font-size:1.4rem;font-weight:800;color:${csCls}">${cs}%</span>
            </div>
            <div style="height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin-bottom:.4rem;">
                <div style="height:100%;width:${cs}%;background:${csCls};border-radius:999px;transition:width .5s;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:.78rem;color:#94a3b8;">
                <span>Classification</span><strong style="color:${csCls}">${csLbl}</strong>
            </div>
        </div>`;

        // ── Exam result ────────────────────────────────────────────────────
        if (data.examResult) {
            const r = data.examResult;
            const pCls = r.passed ? '#10b981' : '#ef4444';
            html += `<div style="background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:.875rem 1rem;margin-bottom:1rem;">
                <div style="font-weight:700;margin-bottom:.3rem;">📊 Exam Result</div>
                <div style="font-size:.83rem;color:#94a3b8;">Score: <strong style="color:#f1f5f9">${r.score}/${r.totalMCQ} (${r.percentage}%)</strong>
                    &nbsp;·&nbsp; <strong style="color:${pCls}">${r.passed ? '✅ PASSED' : '❌ FAILED'}</strong>
                    &nbsp;·&nbsp; Risk: <strong style="color:#fcd34d">${data.riskLevel}</strong>
                </div>
                <div style="font-size:.75rem;color:#64748b;margin-top:.2rem;">Submitted: ${new Date(r.timestamp).toLocaleString()}</div>
            </div>`;
        }

        // ── Score history (deduction log) ──────────────────────────────────
        const scoreHist = data.scoreHistory || [];
        if (scoreHist.length > 0) {
            html += `<div style="margin-bottom:1rem;">
                <div style="font-weight:700;font-size:.88rem;margin-bottom:.5rem;">📉 Score Deductions</div>
                <div style="display:flex;flex-direction:column;gap:.3rem;">`;
            scoreHist.slice().reverse().forEach(h => {
                const vkey = Object.keys(VIOLATION_META).find(k => h.reason && h.reason.toLowerCase().includes(k.replace('_',' '))) || 'absent_short';
                const meta = VIOLATION_META[vkey] || { icon: '⚠️', color: '#f59e0b' };
                html += `<div style="display:flex;align-items:center;gap:.6rem;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.12);border-radius:8px;padding:.4rem .75rem;">
                    <span style="font-size:1rem;">${meta.icon}</span>
                    <span style="flex:1;font-size:.78rem;color:#cbd5e1;">${h.reason}</span>
                    <span style="font-size:.72rem;color:#94a3b8;">${new Date(h.timestamp).toLocaleTimeString()}</span>
                    <span style="background:rgba(239,68,68,.2);color:#fca5a5;font-weight:700;font-size:.72rem;padding:.1rem .45rem;border-radius:5px;">−${h.deduction}%</span>
                    <span style="font-size:.72rem;color:#64748b;">${h.scoreAfter}%</span>
                </div>`;
            });
            html += `</div></div>`;
        }

        // ── Violation flags ────────────────────────────────────────────────
        const flags = data.flags || [];
        if (flags.length === 0) {
            html += '<p style="color:#94a3b8;text-align:center;padding:1rem;">✅ No violations detected.</p>';
        } else {
            html += `<div style="font-size:.78rem;color:#94a3b8;margin-bottom:.6rem;">${flags.length} violation event(s) recorded</div>`;
            html += `<div style="display:flex;flex-direction:column;gap:.5rem;">`;
            flags.forEach(f => {
                const vkey  = Object.keys(VIOLATION_META).find(k => (f.issue||'').toLowerCase().includes(k.replace(/_/g,' '))) || 'absent_short';
                const meta  = VIOLATION_META[vkey] || { icon: '⚠️', label: 'Violation', color: '#f59e0b', pts: 0 };
                const srcBadge = f.source === 'ai_confirmed'
                    ? `<span style="font-size:.62rem;background:rgba(99,102,241,.18);color:#a5b4fc;border-radius:4px;padding:.1rem .3rem;">AI</span>`
                    : `<span style="font-size:.62rem;background:rgba(245,158,11,.12);color:#fcd34d;border-radius:4px;padding:.1rem .3rem;">captured</span>`;
                const ptsHtml = meta.pts > 0
                    ? `<span style="background:rgba(239,68,68,.2);color:#fca5a5;font-weight:700;font-size:.7rem;padding:.1rem .4rem;border-radius:5px;flex-shrink:0;">−${meta.pts}%</span>`
                    : '';
                const metricsStr = f.metrics && Object.keys(f.metrics).length > 0
                    ? '(' + Object.entries(f.metrics).map(([k,v]) => `${k}: ${v}`).join(', ') + ')'
                    : '';

                html += `<div style="border-left:3px solid ${meta.color};background:rgba(${meta.color === '#ef4444' ? '239,68,68' : meta.color === '#a855f7' ? '168,85,247' : '245,158,11'},.06);border-radius:0 10px 10px 0;padding:.65rem .875rem;">
                    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem;">
                        <span style="font-size:1.1rem;">${meta.icon}</span>
                        <span style="font-weight:700;color:${meta.color};font-size:.82rem;">${meta.label}</span>
                        ${srcBadge} ${ptsHtml}
                        <span style="margin-left:auto;font-size:.7rem;color:#64748b;">${new Date(f.timestamp).toLocaleString()}</span>
                    </div>
                    <div style="font-size:.8rem;color:#cbd5e1;">${f.issue} <span style="color:#64748b;font-size:.75rem;">${metricsStr}</span></div>
                    ${f.image ? `<img src="${f.image}" alt="Evidence" style="max-width:100%;border-radius:8px;margin-top:.5rem;border:1px solid rgba(255,255,255,.08);cursor:pointer;" onclick="this.style.maxWidth=this.style.maxWidth==='100%'?'200px':'100%'">` : ''}
                </div>`;
            });
            html += `</div>`;
        }

        body.innerHTML = html;
        document.getElementById('logs-modal').classList.add('open');
    },

    closeModal() {
        document.getElementById('logs-modal').classList.remove('open');
    },

    async resetUser(username) {
        if (!confirm(`Reset exam for ${username}?`)) return;
        await this.http('POST', `/api/admin/reset/${username}`);
        this.loadStudents();
    },

    // ── Helpers ───────────────────────────────────────────────────────────
    setMsg(id, text, cls) {
        const el = document.getElementById(id);
        el.textContent = text;
        el.className = 'form-msg ' + cls;
        el.style.display = 'inline-block';
    },
    hideMsg(id) {
        document.getElementById(id).style.display = 'none';
    }
};

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => ADMIN.init());
