// ============================================================
// analytics.js  —  Exam statistics, persistence, UI
// Depends on: data.js (EXAMS constant)
// ============================================================

const STORAGE_KEY = 'biopsych_exam_stats_v1';   // own key: the national-exam app lives on the same origin

/* ── Storage helpers ────────────────────────────────────────────────────── */

function loadStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

function saveStats(stats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch (e) {
    console.warn('Could not save stats:', e);
  }
}

/* ── Record a completed session ─────────────────────────────────────────── */
// openAnswers: { [qId]: { typed: string, items: [{id, typed}] } }

function recordSession(examKey, mcqAnswers, openAnswers) {
  const exam = EXAMS[examKey];

  // MCQ results
  const mcqResults = exam.questions
    .filter(q => q.type === 'mcq')
    .map(q => ({
      qId:      q.id,
      num:      q.num,
      text:     q.text.slice(0, 120),
      selected: mcqAnswers[q.id] ?? null,
      correct:  q.answer ?? null,
      isRight:  q.answer ? mcqIsCorrect(mcqAnswers[q.id], q.answer) : null,
    }));

  // Open results
  const openResults = exam.questions
    .filter(q => q.type === 'open')
    .map(q => {
      const saved = openAnswers?.[q.id] ?? { typed: '', items: [] };
      const items = q.items || [];

      if (!items.length) {
        // Single-answer open question
        return {
          qId:   q.id,
          num:   q.num,
          text:  q.text.slice(0, 120),
          typed: saved.typed || '',
          modelAnswer: q.single_answer ?? null,
          items: [],
        };
      }

      // Sub-item open question
      return {
        qId:  q.id,
        num:  q.num,
        text: q.text.slice(0, 120),
        typed: '',
        modelAnswer: null,
        items: items.map(item => {
          const savedItem = (saved.items || []).find(si => String(si.id) === String(item.id));
          return {
            id:          item.id,
            text:        item.text,
            typed:       savedItem?.typed || '',
            modelAnswer: item.answer ?? null,
          };
        }),
      };
    });

  // Score
  const scored   = mcqResults.filter(r => r.correct !== null);
  const nCorrect = scored.filter(r => r.isRight).length;

  const session = {
    id:          Date.now(),
    examKey,
    year:        exam.year,
    variant:     exam.variant,
    label:       `${exam.year} · ${exam.variantLabel}`,
    date:        new Date().toISOString(),
    mcqResults,
    openResults,
    openGrades:  {},   // populated later when the student grades open answers
    score:       nCorrect,
    total:       scored.length,
    pct:         scored.length ? Math.round(nCorrect / scored.length * 100) : null,
    mcqScore:    nCorrect,
    mcqTotal:    scored.length,
  };

  const stats = loadStats();
  stats.sessions.push(session);
  saveStats(stats);

  if (document.getElementById('analytics-pane')?.classList.contains('active')) {
    renderAnalytics();
  }

  return session.id;
}

/* ── Aggregate stats ────────────────────────────────────────────────────── */

function computeStats() {
  const { sessions } = loadStats();
  if (!sessions.length) return null;

  // ── Whole-test aggregation over COMPLETE sessions only ──
  // A session counts toward stats only once every typed open answer is graded.
  // Per-year aggregation includes all years (so cards stay clickable to finish
  // grading), but only complete sessions contribute to the score.
  let totalAnswered = 0, totalCorrect = 0, totalSkipped = 0;
  let totalOpenCorrect = 0, totalOpenTotal = 0;
  let completeCount = 0, incompleteCount = 0;
  const byYear = {};

  sessions.forEach(s => {
    const exam = EXAMS[s.examKey];
    const t    = exam ? computeReviewTotals(s, exam) : null;
    if (!byYear[s.year]) byYear[s.year] = { sessions: 0, complete: 0, incomplete: 0, correct: 0, total: 0, openCorrect: 0, openTotal: 0 };
    byYear[s.year].sessions++;

    if (t && t.complete) {
      completeCount++;
      totalAnswered    += t.totalQ;
      totalCorrect     += t.totalRight;
      totalSkipped     += t.skipped;
      totalOpenCorrect += t.openCorrect;
      totalOpenTotal   += t.openUnits;
      byYear[s.year].complete++;
      byYear[s.year].correct     += t.totalRight;
      byYear[s.year].total       += t.totalQ;
      byYear[s.year].openCorrect += t.openCorrect;
      byYear[s.year].openTotal   += t.openUnits;
    } else {
      incompleteCount++;
      byYear[s.year].incomplete++;
    }
  });
  const totalWrong    = totalAnswered - totalCorrect - totalSkipped;
  const totalWrongAll = totalAnswered - totalCorrect;

  // Mistake map (MCQ + open wrong answers)
  const mistakeMap = {};
  sessions.forEach(s => {
    // MCQ mistakes
    s.mcqResults.forEach(r => {
      if (r.correct === null) return;
      if (!mistakeMap[r.qId]) {
        mistakeMap[r.qId] = {
          qId: r.qId, num: r.num, text: r.text,
          label: s.label, wrongCount: 0, total: 0, examples: [], wrongPicks: {}, isOpen: false
        };
      }
      mistakeMap[r.qId].total++;
      if (!r.isRight) {
        mistakeMap[r.qId].wrongCount++;
        const pick = r.selected || '—';   // '—' = left blank / skipped
        mistakeMap[r.qId].wrongPicks[pick] = (mistakeMap[r.qId].wrongPicks[pick] || 0) + 1;
        if (mistakeMap[r.qId].examples.length < 3)
          mistakeMap[r.qId].examples.push({ selected: r.selected, correct: r.correct, date: s.date });
      }
    });

    // Open mistakes (graded ✗)
    const grades = s.openGrades || {};
    (s.openResults || []).forEach(r => {
      if (!r.items.length) {
        const key = r.qId;
        if (grades[key] === undefined) return; // ungraded — skip
        if (!mistakeMap[key]) {
          mistakeMap[key] = {
            qId: key, num: r.num, text: r.text,
            label: s.label, wrongCount: 0, total: 0, examples: [], wrongTyped: {}, isOpen: true,
            modelAnswer: r.modelAnswer || null
          };
        }
        mistakeMap[key].total++;
        if (grades[key] === false) {
          mistakeMap[key].wrongCount++;
          const t = (r.typed || '').trim() || '—';
          mistakeMap[key].wrongTyped[t] = (mistakeMap[key].wrongTyped[t] || 0) + 1;
          if (mistakeMap[key].examples.length < 3)
            mistakeMap[key].examples.push({ typed: r.typed, modelAnswer: r.modelAnswer, date: s.date });
        }
      } else {
        r.items.forEach(item => {
          const key = r.qId + '_' + item.id;
          if (grades[key] === undefined) return;
          const mapKey = key;
          if (!mistakeMap[mapKey]) {
            mistakeMap[mapKey] = {
              qId: mapKey, num: r.num, text: r.text + ' [' + item.id + '] ' + item.text,
              label: s.label, wrongCount: 0, total: 0, examples: [], wrongTyped: {}, isOpen: true,
              modelAnswer: item.modelAnswer || null
            };
          }
          mistakeMap[mapKey].total++;
          if (grades[key] === false) {
            mistakeMap[mapKey].wrongCount++;
            const t = (item.typed || '').trim() || '—';
            mistakeMap[mapKey].wrongTyped[t] = (mistakeMap[mapKey].wrongTyped[t] || 0) + 1;
            if (mistakeMap[mapKey].examples.length < 3)
              mistakeMap[mapKey].examples.push({ typed: item.typed, modelAnswer: item.modelAnswer, date: s.date });
          }
        });
      }
    });
  });

  const mistakes = Object.values(mistakeMap)
    .filter(m => m.wrongCount > 0)
    .sort((a, b) => b.wrongCount - a.wrongCount);

  return { sessions, totalAnswered, totalCorrect, totalWrong, totalWrongAll, totalSkipped,
           totalOpenCorrect, totalOpenTotal, byYear, mistakes, completeCount, incompleteCount };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ka-GE', { day: '2-digit', month: '2-digit', year: 'numeric' })
       + ' ' + d.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' });
}

// Exam groups ("შუალედური 1" …) in course order, not alphabetical (ფ < შ).
function byGroupOrder([a], [b]) {
  const order = name => (Object.values(EXAMS).find(e => String(e.year) === String(name)) || {}).order ?? 99;
  return order(a) - order(b);
}

function pctColor(pct) {
  if (pct === null) return 'var(--muted)';
  if (pct >= 80) return 'var(--green)';
  if (pct >= 55) return '#e08800';
  return 'var(--red)';
}

function pctBar(pct, color) {
  return `<div class="an-bar-bg"><div class="an-bar-fill" style="width:${pct ?? 0}%;background:${color}"></div></div>`;
}

// Shows how many times each specific wrong answer was repeated (only when the
// question was missed more than once).
function renderRepeatBreakdown(m) {
  if (!m || m.wrongCount <= 1) return '';
  const tally = m.isOpen ? m.wrongTyped : m.wrongPicks;
  if (!tally) return '';
  const entries = Object.entries(tally).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const pills = entries.map(([k, n]) => {
    let label = k === '—' ? (m.isOpen ? 'ცარიელი' : 'გამოტოვა') : (typeof htmlToPlain === 'function' ? htmlToPlain(k) : k);
    if (label.length > 40) label = label.slice(0, 40) + '…';
    return `<span class="an-repeat-pill">${escHtml(label)} <strong>×${n}</strong></span>`;
  });
  return `<div class="an-mistake-repeat">🔁 ერთი და იგივე შეცდომა: ${pills.join(' ')}</div>`;
}


/* ── Render a full question visual inside a mistake card ─────────────────── */
function renderMistakeQuestion(m) {
  // Find the question data from EXAMS
  let q = null;
  for (const exam of Object.values(EXAMS)) {
    const found = exam.questions.find(x => x.id === m.qId);
    if (found) { q = found; break; }
  }
  if (!q) return `<div class="an-mq-text">${m.text}${m.text.length>=120?'…':''}</div>`;

  const lastEx    = m.examples[m.examples.length - 1];
  const selChoice = lastEx ? lastEx.selected : null;
  const correct   = lastEx ? lastEx.correct  : q.answer;

  let out = `<div class="an-mq-wrap">`;

  // Question text
  out += `<div class="an-mq-text">${q.text}</div>`;

  // Image
  if (q.img) {
    out += `<div class="an-mq-img-wrap"><img src="${q.img}" alt="ილუსტრაცია" loading="lazy"></div>`;
  }

  // Statements (roman numeral options)
  if (q.stmts && q.stmts.length) {
    out += '<div class="an-mq-stmts">';
    q.stmts.forEach(item => {
      const [k, v] = Array.isArray(item) ? item : ['', item];
      if (k || v) out += `<div class="an-mq-stmt-row"><span class="an-mq-stmt-k">${k}</span><span>${v}</span></div>`;
    });
    out += '</div>';
  }

  // Answer choices
  if (q.choices && q.choices.length) {
    out += '<div class="an-mq-choices">';
    q.choices.forEach(ch => {
      ch = ch.trim();
      let k = '', v = ch;
      if (ch.includes(')')) { const i = ch.indexOf(')'); k = ch.slice(0,i).trim(); v = ch.slice(i+1).trim(); }
      else if (ch && 'აბგდ'.includes(ch[0])) { k = ch[0]; v = ch.slice(1).replace(/^[)\s]+/,''); }

      const isCorrect = correct && k === correct;
      const isWrong   = k === selChoice && selChoice !== correct;
      const cls = isCorrect ? 'an-mq-opt-correct' : isWrong ? 'an-mq-opt-wrong' : '';
      const icon = isCorrect ? ' ✓' : isWrong ? ' ✗' : '';
      out += `<div class="an-mq-opt ${cls}">
        <span class="an-mq-opt-k">${k}</span>
        <span>${v}${icon ? `<strong class="an-mq-icon">${icon}</strong>` : ''}</span>
      </div>`;
    });
    out += '</div>';
  }

  // Table choices
  if (q.table) {
    const cols = q.table.cols || q.table.columns || [];
    out += '<table class="an-mq-tbl"><tr>';
    cols.forEach(c => out += `<th>${c}</th>`);
    out += '</tr>';
    (q.table.rows||[]).forEach(row => {
      const k = row[0];
      const isCorrect = correct && k === correct;
      const isWrong   = k === selChoice && selChoice !== correct;
      const cls = isCorrect ? 'an-mq-opt-correct' : isWrong ? 'an-mq-opt-wrong' : '';
      out += `<tr class="${cls}">`;
      row.forEach((cell, ci) => out += `<td${ci===0?' class="an-mq-tbl-k"':''}>${cell}</td>`);
      out += '</tr>';
    });
    out += '</table>';
  }

  // Summary line showing what student picked vs correct
  if (lastEx) {
    out += `<div class="an-mq-verdict">
      <span class="an-mq-wrong-pick">✗ არჩეული: <strong>${lastEx.selected ?? '—'}</strong></span>
      <span class="an-mq-arrow">→</span>
      <span class="an-mq-correct-pick">✓ სწორი: <strong>${correct ?? '—'}</strong></span>
    </div>`;
  }

  out += '</div>';
  return balanceHtml(out);   // contain any stray tags from the question bank
}


/* ── Open answer grading from analytics history ─────────────────────────── */
function analyticsGradeToggle(sessionId, key, val) {
  const stats = loadStats();
  const s = stats.sessions.find(x => x.id === sessionId);
  if (!s) return;
  if (!s.openGrades) s.openGrades = {};
  if (s.openGrades[key] === val) delete s.openGrades[key];   // click the active choice again → un-grade
  else s.openGrades[key] = val;
  syncSessionScore(s);
  saveStats(stats);

  // Full re-render keeps the whole-test score / completeness display consistent;
  // preserve which sessions are expanded, the mistakes panel, and scroll position.
  const openBodies = [];
  document.querySelectorAll('.an-sess-body').forEach(b => { if (b.style.display && b.style.display !== 'none') openBodies.push(b.id); });
  const mistakesOpen = document.querySelector('.an-mistakes-details')?.open;
  const sy = window.scrollY;

  renderAnalytics();

  openBodies.forEach(id => {
    const b = document.getElementById(id);
    const tog = document.getElementById('tog-' + id);
    if (b) { b.style.display = 'block'; if (tog) tog.textContent = '▼'; }
  });
  if (mistakesOpen) { const d = document.querySelector('.an-mistakes-details'); if (d) d.open = true; }
  window.scrollTo(0, sy);
}

function buildAnOpenGradeButtons(sessionId, key, savedGrades) {
  const saved = (savedGrades || {})[key];
  const okCls  = saved === true  ? ' active' : '';
  const errCls = saved === false ? ' active' : '';
  return `<div class="an-open-grade-wrap" data-sid="${sessionId}" data-key="${key}">
    <button class="an-open-grade-btn an-open-grade-ok${okCls}"  data-val="true"  onclick="analyticsGradeToggle(${sessionId}, '${key}', true)">✓ სწორი</button>
    <button class="an-open-grade-btn an-open-grade-err${errCls}" data-val="false" onclick="analyticsGradeToggle(${sessionId}, '${key}', false)">✗ არასწორი</button>
  </div>`;
}

/* ── Main render ────────────────────────────────────────────────────────── */

function renderAnalytics() {
  const pane = document.getElementById('analytics-pane');
  if (!pane) return;

  const stats = computeStats();

  if (!stats) {
    pane.innerHTML = `
      <div class="an-topbar">
        <button class="an-back-btn" onclick="showWelcome()">← მთავარი</button>
      </div>
      <div class="an-empty">
        <div class="an-empty-icon">📊</div>
        <div class="an-empty-title">სტატისტიკა ჯერ არ არის</div>
        <div class="an-empty-sub">გაიარეთ ერთი გამოცდა მაინც, შემდეგ სტატისტიკა გამოჩნდება.</div>
        <div class="an-transfer-wrap" style="margin-top:16px;justify-content:center">
          <button class="an-import-btn" onclick="document.getElementById('an-import-input').click()">📥 სტატისტიკის იმპორტი</button>
          <input id="an-import-input" type="file" accept=".json" style="display:none" onchange="importStats(event)">
        </div>
      </div>`;
    return;
  }

  const { sessions, totalAnswered, totalCorrect, totalWrong, totalWrongAll, totalSkipped, totalOpenCorrect, totalOpenTotal, byYear, mistakes, incompleteCount } = stats;
  const overallPct   = totalAnswered ? Math.round(totalCorrect / totalAnswered * 100) : null;
  const overallColor = pctColor(overallPct);
  const incompleteNote = incompleteCount > 0
    ? `<div class="an-incomplete-note">⚠️ ${incompleteCount} გამოცდა ჯერ არ არის სრულად შეფასებული — სანამ ყველა ღია პასუხს არ შეამოწმებთ, ის არ ჩაითვლება სტატისტიკაში.</div>`
    : '';

  // ── Overview ──
  let html = `
<div class="an-topbar">
  <button class="an-back-btn" onclick="showWelcome()">← მთავარი</button>
</div>
<div class="an-section-title">📊 საერთო სტატისტიკა</div>
<div class="an-overview-grid">
  <div class="an-card an-card-accent">
    <div class="an-big-num" style="color:${overallColor}">${overallPct ?? '—'}%</div>
    <div class="an-card-lbl">სწორი პასუხების</div>
    ${pctBar(overallPct, overallColor)}
  </div>
  <div class="an-card"><div class="an-big-num">${sessions.length}</div><div class="an-card-lbl">გავლილი გამოცდა</div></div>
  <div class="an-card"><div class="an-big-num" style="color:var(--green)">${totalCorrect}</div><div class="an-card-lbl">მიღებული ქულა</div></div>
  <div class="an-card"><div class="an-big-num" style="color:var(--red)">${totalWrongAll}</div><div class="an-card-lbl">დაკარგული ქულა</div></div>
  <div class="an-card"><div class="an-big-num" style="color:var(--muted)">${totalSkipped}</div><div class="an-card-lbl">გამოტოვ. ტესტური</div></div>
  <div class="an-card"><div class="an-big-num">${totalAnswered}</div><div class="an-card-lbl">სულ ქულა</div></div>
  ${totalOpenTotal > 0 ? `<div class="an-card"><div class="an-big-num" style="color:var(--accent)">${totalOpenCorrect}/${totalOpenTotal}</div><div class="an-card-lbl">ღია პასუხი (სწორი)</div></div>` : ''}
</div>
${incompleteNote}`;

  // ── Per-group ──
  html += `<div class="an-section-title" style="margin-top:28px">📅 გამოცდების მიხედვით</div><div class="an-year-grid">`;
  Object.entries(byYear).sort(byGroupOrder).forEach(([yr, d]) => {
    // d.correct / d.total are whole-test totals over COMPLETE attempts only.
    const hasComplete = d.complete > 0;
    const p   = hasComplete && d.total ? Math.round(d.correct / d.total * 100) : null;
    const col = pctColor(p);
    const openStr  = d.openTotal > 0 ? ` · ღია: ${d.openCorrect}/${d.openTotal}` : '';
    const incStr   = d.incomplete > 0 ? ` · ⚠️${d.incomplete} შეუმოწმებელი` : '';
    const multi    = d.sessions > 1;
    const hint     = multi ? `👁 ${d.sessions} მცდელობა` : '👁 ნახვა';
    const tip      = multi ? 'დააჭირეთ მცდელობის ასარჩევად' : 'დააჭირეთ სრული ტესტის სანახავად';
    const pctHtml  = hasComplete
      ? `<div class="an-year-pct" style="color:${col}">${p ?? '—'}%</div>${pctBar(p, col)}`
      : `<div class="an-year-pct an-year-unchecked">⚠️ შეუმოწმებელი</div>`;
    const metaHtml = hasComplete
      ? `${d.complete} გამოცდა · ${d.correct}/${d.total}${openStr}${incStr}`
      : `${d.sessions} გამოცდა${incStr}`;
    html += `<div class="an-year-card an-year-clickable" onclick="reviewYear('${yr}')" title="${tip}">
      <div class="an-year-label">${yr}</div>
      ${pctHtml}
      <div class="an-year-meta">${metaHtml}</div>
      <div class="an-year-open-hint">${hint}</div>
    </div>`;
  });
  html += '</div>';

  // ── Session history (with expandable open answers) ──
  html += `<div class="an-section-title" style="margin-top:28px">🕓 გამოცდების ისტორია</div>`;

  [...sessions].reverse().forEach((s, idx) => {
    const sid   = `sess-${s.id}`;
    const exam  = EXAMS[s.examKey];
    const t     = exam ? computeReviewTotals(s, exam) : null;
    const openCorrect = t ? t.openCorrect : Object.values(s.openGrades||{}).filter(v=>v===true).length;
    const openUnits   = t ? t.openUnits   : Object.keys(s.openGrades||{}).length;
    const combinedCorrect = t ? t.totalRight : ((s.mcqScore ?? s.score) + openCorrect);
    const combinedTotal   = t ? t.totalQ     : ((s.mcqTotal ?? s.total) + openUnits);
    const complete = t ? t.complete : true;
    const p = complete && combinedTotal ? Math.round(combinedCorrect / combinedTotal * 100) : null;
    const col   = pctColor(p);
    const hasOpen = s.openResults && s.openResults.some(r =>
      (r.items.length ? r.items.some(it => it.typed) : r.typed)
    );

    const scoreDelta = s.rechecked && s.originalScore !== undefined && s.originalScore !== s.score
      ? `<span class="an-sess-delta" title="განახლებამდე: ${s.originalScore}/${s.originalTotal}">(ადრე: ${s.originalScore}/${s.originalTotal})</span>`
      : '';
    const recheckBadge = s.rechecked
      ? `<span class="an-recheck-badge" title="შედეგი განახლდა ახალი მონაცემებით">🔄</span>`
      : `<span class="an-needs-recheck" title="ეს შედეგი ჯერ არ არის განახლებული">⚠️</span>`;

    html += `
<div class="an-sess-card">
  <div class="an-sess-head" onclick="toggleSession('${sid}')">
    <span class="an-exam-tag">${s.label}</span>
    <span class="an-date">${fmtDate(s.date)}</span>
    <span class="an-sess-score" id="an-sess-score-${s.id}">${combinedCorrect} / ${combinedTotal}</span>
    ${scoreDelta}
    ${complete
      ? `<span class="an-sess-pct" id="an-sess-pct-${s.id}" style="color:${col}">${p ?? '—'}%</span>`
      : `<span class="an-sess-pct an-sess-unchecked" id="an-sess-pct-${s.id}" title="ზოგი ღია პასუხი ჯერ არ არის შემოწმებული">⚠️ შეუმოწმებელი</span>`}
    ${recheckBadge}
    ${s.openResults && s.openResults.length ? `<span class="an-open-score-badge" id="an-open-score-${s.id}">📝 ღია: ${openCorrect} / ${openUnits}</span>` : ''}
    <span class="an-sess-toggle" id="tog-${sid}">▶</span>
  </div>
  <div class="an-sess-body" id="${sid}" style="display:none">`;

    // MCQ wrong answers — full question visual
    const wrong = s.mcqResults.filter(r => r.correct && !r.isRight);
    if (wrong.length) {
      html += `<div class="an-sess-sub-title">❌ არასწორი MCQ პასუხები (${wrong.length})</div>
<div class="an-wrong-list">`;
      wrong.forEach(r => {
        // Build a fake "mistake" object so renderMistakeQuestion can work
        const fakeM = {
          qId:      r.qId,
          num:      r.num,
          text:     r.text,
          examples: [{ selected: r.selected, correct: r.correct, date: s.date }]
        };
        html += `<div class="an-wrong-card">
          <div class="an-wrong-card-head">
            <span class="an-wrong-num">კ.${r.num}</span>
            <span class="an-wrong-card-label">${s.label}</span>
          </div>
          ${renderMistakeQuestion(fakeM)}
        </div>`;
      });
      html += '</div>';
    } else if (s.mcqResults.some(r => r.correct)) {
      html += `<div class="an-sess-perfect">✅ ყველა MCQ სწორად!</div>`;
    }

    // Open answers
    if (s.openResults && s.openResults.length) {
      html += `<div class="an-sess-sub-title">📝 ღია კითხვების პასუხები</div>
<div class="an-open-list">`;
      s.openResults.forEach(r => {
        if (!r.items.length) {
          // Single open answer
          const hasTyped = r.typed && r.typed.trim();
          const gradeKey0 = r.qId;
          const savedGrade0 = (s.openGrades || {})[gradeKey0];
          const gradeCls0 = savedGrade0 === true ? 'an-open-card-ok' : savedGrade0 === false ? 'an-open-card-err' : '';
          html += `<div class="an-open-card ${gradeCls0}">
            <div class="an-open-q"><strong>კ.${r.num}</strong> ${r.text}${r.text.length >= 120 ? '…' : ''}</div>
            <div class="an-open-row">
              <div class="an-open-col">
                <div class="an-open-lbl">თქვენი პასუხი</div>
                <div class="an-open-typed ${hasTyped ? '' : 'an-open-empty'}">${hasTyped ? escHtml(r.typed) : '— არ შეგიყვანიათ —'}</div>
              </div>
              ${r.modelAnswer ? `<div class="an-open-col">
                <div class="an-open-lbl">სწორი პასუხი</div>
                <div class="an-open-model">${r.modelAnswer}</div>
              </div>` : ''}
            </div>
            ${buildAnOpenGradeButtons(s.id, gradeKey0, s.openGrades)}
          </div>`;
        } else {
          // Sub-item open answers
          html += `<div class="an-open-card">
            <div class="an-open-q"><strong>კ.${r.num}</strong> ${r.text}${r.text.length >= 120 ? '…' : ''}</div>`;
          const examQ = exam && exam.questions.find(qq => qq.id === r.qId);
          r.items.forEach(item => {
            const fullItem = ((examQ && examQ.items) || []).find(x => String(x.id) === String(item.id)) || {};
            // Worked example — given, read-only, not graded.
            if (fullItem.example) {
              html += `<div class="an-open-item">
                <div class="an-open-item-id">${item.id}</div>
                <div class="an-open-item-q">${item.text} <span class="an-open-tag">ნიმუში</span></div>
                ${item.modelAnswer ? `<div class="an-open-model">${item.modelAnswer}</div>` : ''}
              </div>`;
              return;
            }
            const hasTyped = item.typed && item.typed.trim();
            const gradeKeyI = r.qId + '_' + item.id;
            const savedGradeI = (s.openGrades || {})[gradeKeyI];
            const gradeCls = savedGradeI === true ? 'an-open-item-ok' : savedGradeI === false ? 'an-open-item-err' : '';
            html += `<div class="an-open-item ${gradeCls}">
              <div class="an-open-item-id">${item.id}</div>
              <div class="an-open-item-q">${item.text}</div>
              <div class="an-open-row">
                <div class="an-open-col">
                  <div class="an-open-lbl">თქვენი პასუხი</div>
                  <div class="an-open-typed ${hasTyped ? '' : 'an-open-empty'}">${hasTyped ? escHtml(item.typed) : '— არ შეგიყვანიათ —'}</div>
                </div>
                ${item.modelAnswer ? `<div class="an-open-col">
                  <div class="an-open-lbl">სწორი პასუხი</div>
                  <div class="an-open-model">${item.modelAnswer}</div>
                </div>` : ''}
              </div>
              ${buildAnOpenGradeButtons(s.id, gradeKeyI, s.openGrades)}
            </div>`;
          });
          html += '</div>';
        }
      });
      html += '</div>';
    }

    html += `</div></div>`;  // close sess-body + sess-card
  });

  // ── MCQ Mistakes (collapsible, full list) ──
  if (mistakes.length) {
    html += `<details class="an-mistakes-details">
      <summary class="an-section-title an-mistakes-summary" style="margin-top:28px">❌ ყველაზე ხშირი შეცდომები (${mistakes.length})</summary>
      <div class="an-mistakes-list">`;
    mistakes.forEach((m, i) => {
      const errPct = Math.round(m.wrongCount / m.total * 100);
      const col    = pctColor(100 - errPct);
      const body   = m.isOpen
        ? `<div class="an-mistake-open-body">
            <div class="an-open-lbl">კითხვა</div>
            <div class="an-open-q-text">${m.text}</div>
            ${m.modelAnswer ? `<div class="an-open-lbl" style="margin-top:8px">სწორი პასუხი</div><div class="an-open-model">${m.modelAnswer}</div>` : ''}
            ${m.examples.length ? `<div class="an-open-lbl" style="margin-top:8px">თქვენი პასუხები</div>${m.examples.map(e => `<div class="an-open-typed">${escHtml(e.typed||'—')}</div>`).join('')}` : ''}
          </div>`
        : renderMistakeQuestion(m);
      html += balanceHtml(`<div class="an-mistake-card">
        <div class="an-mistake-head">
          <span class="an-mistake-rank">#${i + 1}</span>
          <span class="an-mistake-ref">${m.label} · კ.${m.num}${m.isOpen ? ' <span class="an-open-tag">ღია</span>' : ''}</span>
          <span class="an-mistake-count" style="color:var(--red)">${m.wrongCount}× შეცდომა</span>
          <span class="an-bar-inline-wrap" style="flex:1;max-width:120px">${pctBar(100 - errPct, col)}</span>
          <span class="an-mistake-stat">${m.total - m.wrongCount}/${m.total} სწორი</span>
        </div>
        ${renderRepeatBreakdown(m)}
        ${body}
      </div>`);
    });
    html += '</div></details>';
  }

  // ── Recheck + Reset ──
  const anyUnrechecked = sessions.some(s => !s.rechecked);
  html += `
<div class="an-reset-wrap">
  ${anyUnrechecked ? `<button class="an-recheck-btn" onclick="recheckAllSessions()">🔄 ძველი შედეგების განახლება</button>` : `<span class="an-recheck-done">✅ ყველა შედეგი განახლებულია</span>`}
  <div class="an-transfer-wrap">
    <button class="an-export-btn" onclick="exportForAI()">🤖 AI ანალიზისთვის</button>
    <button class="an-export-btn" onclick="exportStats()">📤 სტატისტიკის ექსპორტი</button>
    <button class="an-import-btn" onclick="document.getElementById('an-import-input').click()">📥 სტატისტიკის იმპორტი</button>
    <input id="an-import-input" type="file" accept=".json" style="display:none" onchange="importStats(event)">
  </div>
  <button class="an-reset-btn" onclick="confirmReset()">🗑 სტატისტიკის გასუფთავება</button>
</div>`;

  pane.innerHTML = html;
}

/* ── Toggle session detail ──────────────────────────────────────────────── */

function toggleSession(sid) {
  const body = document.getElementById(sid);
  const tog  = document.getElementById('tog-' + sid);
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display  = open ? 'block' : 'none';
  if (tog) tog.textContent = open ? '▼' : '▶';
}

/* ── Recheck past sessions ───────────────────────────────────────────────── */

function recheckAllSessions() {
  const stats = loadStats();
  let changed = 0;

  stats.sessions.forEach(session => {
    const exam = EXAMS[session.examKey];
    if (!exam) return;

    // ── 1. Re-evaluate MCQ scores with current answer keys ──
    const mcqAnswers = {};
    session.mcqResults.forEach(r => { mcqAnswers[r.qId] = r.selected; });

    const newMcqResults = exam.questions
      .filter(q => q.type === 'mcq')
      .map(q => ({
        qId:      q.id,
        num:      q.num,
        text:     q.text.slice(0, 120),
        selected: mcqAnswers[q.id] ?? null,
        correct:  q.answer ?? null,
        isRight:  q.answer ? q.answer.split('|').map(s=>s.trim()).includes(mcqAnswers[q.id]?.trim() ?? '') : null,
      }));

    const scored   = newMcqResults.filter(r => r.correct !== null);
    const nCorrect = scored.filter(r => r.isRight).length;
    const newScore = nCorrect;
    const newTotal = scored.length;
    const newPct   = newTotal ? Math.round(nCorrect / newTotal * 100) : null;

    // ── 2. Rebuild open results with current model answers ──
    // Collect what the student typed (keyed by qId + itemId)
    const prevOpenMap = {};
    (session.openResults || []).forEach(r => {
      prevOpenMap[r.qId] = r;
    });

    const newOpenResults = exam.questions
      .filter(q => q.type === 'open')
      .map(q => {
        const prev  = prevOpenMap[q.id] || { typed: '', items: [] };
        const items = q.items || [];

        if (!items.length) {
          return {
            qId:         q.id,
            num:         q.num,
            text:        q.text.slice(0, 120),
            typed:       prev.typed || '',
            modelAnswer: q.single_answer ?? null,
            items:       [],
          };
        }

        return {
          qId:         q.id,
          num:         q.num,
          text:        q.text.slice(0, 120),
          typed:       '',
          modelAnswer: null,
          items: items.map(item => {
            const prevItem = (prev.items || []).find(si => String(si.id) === String(item.id));
            return {
              id:          item.id,
              text:        item.text,
              typed:       prevItem?.typed || '',
              modelAnswer: item.answer ?? null,
            };
          }),
        };
      });

    // ── 3. Save original score (only once) ──
    if (!session.rechecked) {
      session.originalScore = session.score;
      session.originalTotal = session.total;
      session.originalPct   = session.pct;
    }

    const prevMcqScore = session.mcqScore ?? session.score;
    const prevMcqTotal = session.mcqTotal ?? session.total;
    if (prevMcqScore !== newScore || prevMcqTotal !== newTotal) changed++;

    session.mcqResults  = newMcqResults;
    session.openResults = newOpenResults;
    session.mcqScore    = newScore;     // keep the canonical MCQ fields in sync
    session.mcqTotal    = newTotal;
    syncSessionScore(session);          // recompute combined score/total/pct, preserving open grades
    session.rechecked   = true;
    session.recheckedAt = new Date().toISOString();
  });

  saveStats(stats);

  const msg = changed > 0
    ? `განახლდა ${stats.sessions.length} გამოცდა. ${changed} შემთხვევაში ქულა შეიცვალა.`
    : `განახლდა ${stats.sessions.length} გამოცდა. ქულები არ შეცვლილა.`;
  alert(msg);
  renderAnalytics();
}

/* ── Export / Import ────────────────────────────────────────────────────── */

function exportStats() {
  try {
    const stats = loadStats();
    const json  = JSON.stringify(stats, null, 2);
    const blob  = new Blob([json], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    const date  = new Date().toISOString().slice(0, 10);
    a.href      = url;
    a.download  = `biology_stats_${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('ექსპორტი ვერ მოხერხდა: ' + e.message);
  }
}

/* ── AI-friendly report export ──────────────────────────────────────────── */
// Converts the data-bank HTML (sub/sup/strong/u/br) into plain readable text
// so chemical formulas etc. stay meaningful for an LLM.
function htmlToPlain(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<sup>(.*?)<\/sup>/gi, '^$1')
    .replace(/<sub>(.*?)<\/sub>/gi, '_$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChoiceKV(ch) {
  ch = String(ch).trim();
  let k = '', v = ch;
  if (ch.includes(')')) { const i = ch.indexOf(')'); k = ch.slice(0, i).trim(); v = ch.slice(i + 1).trim(); }
  else if (ch && 'აბგდ'.includes(ch[0])) { k = ch[0]; v = ch.slice(1).replace(/^[)\s]+/, ''); }
  return { k, v };
}

function exportForAI() {
  const raw = loadStats();
  if (!raw.sessions || !raw.sessions.length) { alert('ჯერ არ არის სტატისტიკა ექსპორტისთვის'); return; }
  const agg = computeStats();

  const L = [];
  const P = (s = '') => L.push(s);

  P('# ბიოლოგიური ფსიქოლოგია — გამოცდების სტატისტიკის ანალიზი');
  P();
  P(`გენერირების თარიღი: ${new Date().toLocaleString('ka-GE')}`);
  P(`გავლილი გამოცდები: ${raw.sessions.length}`);
  P();
  P('> ეს ფაილი შეიცავს მოსწავლის ყველა ნაპასუხებ კითხვას სრული ტექსტით, ' +
    'არჩეულ და სწორ პასუხებთან ერთად — გადაეცი AI-ს ანალიზისთვის ' +
    '(სუსტი თემები, შეცდომების ნიმუშები, რჩევები).');
  P();

  // ── Overall ──
  const overallPct = agg.totalAnswered ? Math.round(agg.totalCorrect / agg.totalAnswered * 100) : 0;
  P('## საერთო შედეგები (მხოლოდ სრულად შეფასებული გამოცდები)');
  P(`- სწორი პასუხები: ${agg.totalCorrect} / ${agg.totalAnswered} (${overallPct}%)`);
  P(`- არასწორი: ${agg.totalWrongAll}`);
  if (agg.totalOpenTotal) P(`- ღია კითხვები: ${agg.totalOpenCorrect} / ${agg.totalOpenTotal}`);
  if (agg.incompleteCount) P(`- ⚠️ შეუმოწმებელი გამოცდა (არ ითვლება): ${agg.incompleteCount}`);
  P();

  // ── Per-group ── (whole-test totals over complete attempts)
  P('## გამოცდების მიხედვით');
  Object.entries(agg.byYear).sort(byGroupOrder).forEach(([yr, d]) => {
    if (d.complete > 0) {
      const p = d.total ? Math.round(d.correct / d.total * 100) : 0;
      P(`- ${yr}: ${p}% (${d.correct}/${d.total}, ${d.complete} გამოცდა)${d.incomplete ? ` · ${d.incomplete} შეუმოწმებელი` : ''}`);
    } else {
      P(`- ${yr}: შეუმოწმებელი (${d.incomplete} გამოცდა ჯერ არ არის შეფასებული)`);
    }
  });
  P();

  // ── Top mistakes ──
  if (agg.mistakes && agg.mistakes.length) {
    P('## ყველაზე ხშირი შეცდომები');
    agg.mistakes.slice(0, 20).forEach((m, i) => {
      P(`${i + 1}. [${m.isOpen ? 'ღია' : 'ტესტური'}] კ.${m.num} — ${m.wrongCount}/${m.total} შეცდომა — ${htmlToPlain(m.text)}`);
    });
    P();
  }

  // ── Detailed per session ──
  P('## დეტალური მიმოხილვა (კითხვა-პასუხი)');
  [...raw.sessions].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(s => {
    const exam = EXAMS[s.examKey];
    P();
    P(`### ${s.label} — ${fmtDate(s.date)}`);
    if (!exam) { P('_(ამ გამოცდის სრული მონაცემები ვერ მოიძებნა)_'); return; }

    const mcqByQ = {}; (s.mcqResults  || []).forEach(r => { mcqByQ[r.qId]  = r; });
    const openByQ = {}; (s.openResults || []).forEach(r => { openByQ[r.qId] = r; });
    const grades = s.openGrades || {};

    exam.questions.forEach(q => {
      if (q.type === 'mcq') {
        const r   = mcqByQ[q.id] || {};
        const sel = r.selected;
        const ans = q.answer;
        const ok  = ans ? mcqIsCorrect(sel, ans) : null;
        const mark = ok === null ? '•' : ok ? '✓ სწორი' : sel ? '✗ არასწორი' : '— გამოტოვებული';
        const choices = (q.choices || []).map(parseChoiceKV);
        const findText = (key) => {
          if (!key) return '—';
          const ch = choices.find(c => c.k === key);
          return ch ? `${key}) ${htmlToPlain(ch.v)}` : key;
        };
        P(`**კ.${q.num} [${mark}]** ${htmlToPlain(q.text)}`);
        P(`  - არჩეული: ${sel ? findText(sel) : '— (არ უპასუხია)'}`);
        if (ans) P(`  - სწორი: ${ans.split('|').map(findText).join(' / ')}`);
      } else {
        const r = openByQ[q.id] || { items: [] };
        P(`**კ.${q.num} [ღია]** ${htmlToPlain(q.text)}`);
        if (!(r.items || []).length) {
          const g     = grades[q.id];
          const model = r.modelAnswer || q.single_answer;
          P(`  - თქვენი პასუხი: ${htmlToPlain(r.typed) || '— (არ უპასუხია)'}`);
          if (model) P(`  - სწორი პასუხი: ${htmlToPlain(model)}`);
          if (g !== undefined) P(`  - შეფასება: ${g ? 'სწორი' : 'არასწორი'}`);
        } else {
          r.items.forEach(item => {
            const key   = q.id + '_' + item.id;
            const g     = grades[key];
            const full  = (q.items || []).find(it => String(it.id) === String(item.id)) || {};
            const model = item.modelAnswer || full.answer;
            P(`  - (${item.id}) ${htmlToPlain(item.text || full.text)}`);
            P(`     - თქვენი პასუხი: ${htmlToPlain(item.typed) || '—'}`);
            if (model) P(`     - სწორი: ${htmlToPlain(model)}`);
            if (g !== undefined) P(`     - შეფასება: ${g ? 'სწორი' : 'არასწორი'}`);
          });
        }
      }
    });
  });

  try {
    const md   = L.join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `biology_stats_AI_${date}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('ექსპორტი ვერ მოხერხდა: ' + e.message);
  }
}

function importStats(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);

      // Basic validation
      if (!imported || !Array.isArray(imported.sessions)) {
        throw new Error('ფაილის ფორმატი არასწორია');
      }

      const existing = loadStats();
      const existingIds = new Set(existing.sessions.map(s => s.id));

      // Merge: add only sessions not already present (by id)
      let added = 0;
      imported.sessions.forEach(s => {
        if (!existingIds.has(s.id)) {
          existing.sessions.push(s);
          added++;
        }
      });

      saveStats(existing);
      alert(`იმპორტი დასრულდა. დამატებულია ${added} ახალი სესია.`);
      renderAnalytics();
    } catch (err) {
      alert('იმპორტი ვერ მოხერხდა: ' + err.message);
    } finally {
      // Reset input so the same file can be re-imported if needed
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

/* ── Reset ──────────────────────────────────────────────────────────────── */

function confirmReset() {
  if (!confirm('გსურთ მთელი სტატისტიკის წაშლა? ეს ქმედება შეუქცევადია.')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderAnalytics();
}

/* ── Analytics tab ──────────────────────────────────────────────────────── */

function showAnalytics() {
  document.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.year-btn[data-year="analytics"]').classList.add('active');
  document.querySelectorAll('.variant-bar').forEach(b => b.classList.remove('visible'));
  document.querySelectorAll('.exam-pane').forEach(e => e.classList.remove('active'));
  const pane = document.getElementById('analytics-pane');
  if (pane) {
    pane.classList.add('active');
    renderAnalytics();
  }
}

/* ── Full session review (opened from a year card) ──────────────────────── */

// A year card may aggregate several attempts. One attempt → open it directly;
// several → let the student pick which one to review.
function reviewYear(year) {
  const { sessions } = loadStats();
  const ys = sessions.filter(s => String(s.year) === String(year))
    .sort((a, b) => new Date(b.date) - new Date(a.date));   // newest first
  if (!ys.length) return;
  if (ys.length === 1) { reviewSession(ys[0].id); return; }
  showAttemptPicker(year, ys);
}

function showAttemptPicker(year, ys) {
  closeAttemptPicker();
  const rows = ys.map((s, i) => {
    const exam = EXAMS[s.examKey];
    let mark, pct;
    if (exam) { const t = computeReviewTotals(s, exam); mark = `${t.totalRight} / ${t.totalQ}`; pct = t.finalPct; }
    else      { mark = `${s.score ?? '—'} / ${s.total ?? '—'}`; pct = s.pct; }
    const col = pctColor(pct);
    return `<div class="attempt-row">
      <button class="attempt-item" onclick="openAttempt(${s.id})">
        <span class="attempt-no">#${ys.length - i}</span>
        <span class="attempt-date">${fmtDate(s.date)}</span>
        <span class="attempt-variant">${s.variant ? 'ვარიანტი ' + s.variant : ''}</span>
        <span class="attempt-mark">${mark}</span>
        <span class="attempt-pct" style="color:${col}">${pct ?? '—'}%</span>
      </button>
      <button class="attempt-del" onclick="deleteAttempt(${s.id}, '${year}')" title="ამ მცდელობის წაშლა" aria-label="წაშლა">🗑</button>
    </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'attempt-modal-overlay';
  overlay.id = 'attempt-modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeAttemptPicker(); };
  overlay.innerHTML = `
    <div class="attempt-modal">
      <div class="attempt-modal-head">
        <span>${year} — აირჩიეთ მცდელობა (${ys.length})</span>
        <button class="attempt-modal-close" onclick="closeAttemptPicker()" aria-label="დახურვა">✕</button>
      </div>
      <div class="attempt-modal-list">${rows}</div>
    </div>`;
  document.body.appendChild(overlay);
  document.addEventListener('keydown', attemptPickerEsc);
}

function attemptPickerEsc(e) { if (e.key === 'Escape') closeAttemptPicker(); }

function openAttempt(id) { closeAttemptPicker(); reviewSession(id); }

function closeAttemptPicker() {
  const o = document.getElementById('attempt-modal-overlay');
  if (o) o.remove();
  document.removeEventListener('keydown', attemptPickerEsc);
}

function deleteAttempt(id, year) {
  if (!confirm('ამ მცდელობის წაშლა? ეს ქმედება შეუქცევადია.')) return;
  const stats = loadStats();
  stats.sessions = stats.sessions.filter(s => s.id !== id);
  saveStats(stats);
  renderAnalytics();   // refresh the statistics page underneath

  // Refresh the picker with what's left for this year
  const ys = stats.sessions.filter(s => String(s.year) === String(year))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (ys.length >= 2) showAttemptPicker(year, ys);
  else closeAttemptPicker();   // 0 or 1 left → no picker needed
}

// Year-card / history entry → review (most recent session for that year handled by reviewYear)
function reviewSession(sessionId) { renderResultReview(sessionId, false, false); }

// Score a saved session against the full question bank, in POINTS (q.score),
// so the denominator equals the exam's real point total (e.g. 70) rather than
// the number of answers — some questions carry several answers for one point.
// Open questions are graded per answer; a question's earned points scale with
// the share of its answers marked correct. Worked examples are not scored.
// Untyped+ungraded answers count as wrong; typed+ungraded ones drive the notice.
function computeReviewTotals(s, exam) {
  const mcqByQ = {}; (s.mcqResults || []).forEach(r => { mcqByQ[r.qId] = r; });
  const openByQ = {}; (s.openResults || []).forEach(r => { openByQ[r.qId] = r; });
  const grades = s.openGrades || {};

  let correct = 0, wrong = 0, skipped = 0;
  let mcqPoints = 0, mcqEarned = 0;
  exam.questions.filter(q => q.type === 'mcq' && q.answer).forEach(q => {
    const sc = q.score || 1;
    mcqPoints += sc;
    const sel = (mcqByQ[q.id] || {}).selected;
    if (mcqIsCorrect(sel, q.answer)) { correct++; mcqEarned += sc; }
    else if (sel) wrong++;
    else skipped++;
  });

  let openPoints = 0, openEarned = 0, openUnits = 0, openGraded = 0, openCorrect = 0, ungradedTyped = 0;
  exam.questions.filter(q => q.type === 'open').forEach(q => {
    const sc = q.score || 0;
    openPoints += sc;
    const r = openByQ[q.id] || { items: [] };
    const rawUnits = (!r.items || !r.items.length)
      ? [{ key: q.id, typed: (r.typed || '').trim(), example: false }]
      : r.items.map(it => {
          const full = (q.items || []).find(x => String(x.id) === String(it.id)) || {};
          return { key: q.id + '_' + it.id, typed: (it.typed || '').trim(), example: !!full.example };
        });
    const units = rawUnits.filter(u => !u.example);   // worked examples are given, not scored
    let qCorrect = 0;
    units.forEach(u => {
      openUnits++;
      const g = grades[u.key];
      if (g !== undefined) { openGraded++; if (g === true) { openCorrect++; qCorrect++; } }
      else if (u.typed) ungradedTyped++;
    });
    if (units.length) openEarned += (qCorrect / units.length) * sc;
  });

  const totalQ     = mcqPoints + openPoints;            // exam point total (== sum of q.score)
  const totalRight = Math.round((mcqEarned + openEarned) * 2) / 2;   // NAEC uses half-point steps
  const totalWrong = Math.round((totalQ - totalRight) * 2) / 2;
  const finalPct   = totalQ ? Math.round(totalRight / totalQ * 100) : null;
  // "complete" = every typed open answer has been graded (empty answers are
  // treated as wrong automatically, so they don't block completion).
  const complete   = ungradedTyped === 0;
  return { correct, wrong, skipped, openUnits, openGraded, openCorrect,
           ungradedTyped, totalRight, totalQ, totalWrong, finalPct, complete };
}

// Keep the session's stored score fields in sync (used by the analytics history list).
function syncSessionScore(s) {
  const grades = s.openGrades || {};
  const oc = Object.values(grades).filter(v => v === true).length;
  const ot = Object.keys(grades).length;
  const mcqC = s.mcqScore !== undefined ? s.mcqScore : ((s.score || 0) - oc);
  const mcqT = s.mcqTotal !== undefined ? s.mcqTotal : ((s.total || 0) - ot);
  s.mcqScore = mcqC; s.mcqTotal = mcqT;
  s.score = mcqC + oc; s.total = mcqT + ot;
  s.pct = s.total ? Math.round(s.score / s.total * 100) : null;
}

// Unified results / review screen. isLive=true → just-finished exam.
function renderResultReview(sessionId, isLive, keepView) {
  const { sessions } = loadStats();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) { alert('სესია ვერ მოიძებნა'); return; }
  const exam = EXAMS[s.examKey];
  if (!exam) { alert('ამ გამოცდის მონაცემები ვერ მოიძებნა'); return; }

  window._reviewState = { sessionId, isLive };

  const mcqByQ = {};  (s.mcqResults  || []).forEach(r => { mcqByQ[r.qId]  = r; });
  const openByQ = {}; (s.openResults || []).forEach(r => { openByQ[r.qId] = r; });
  const grades = s.openGrades || {};

  const cards = exam.questions.map(q => {
    let card;
    if (q.type === 'mcq') {
      const sel = (mcqByQ[q.id] || {}).selected ?? null;
      const ans = q.answer;
      let status = 'skipped';
      if (ans) status = mcqIsCorrect(sel, ans) ? 'correct' : sel ? 'wrong' : 'skipped';
      card = buildMCQResultCard(q, sel, ans, status);
    } else {
      card = buildOpenReviewCard(q, openByQ[q.id] || { items: [] }, grades, sessionId, isLive);
    }
    return balanceHtml(card);   // contain stray tags to this one card (no bleed)
  }).join('');

  const t   = computeReviewTotals(s, exam);
  const col = pctColor(t.finalPct);

  const notice = `<div class="res-rev-notice" id="res-rev-notice" style="${t.complete ? 'display:none' : ''}">
    ⚠️ <strong>${t.ungradedTyped}</strong> ღია პასუხი ჯერ არ არის შემოწმებული — საბოლოო ქულა არ ჩაითვლება, სანამ ქვემოთ თითოეულ ღია პასუხს არ მონიშნავთ ✓ სწორად ან ✗ არასწორად.
  </div>`;

  // The final mark is shown only once every open answer is graded.
  const markCell = t.complete
    ? `<div class="res-num res-num-mark" style="color:${col}" id="res-rev-mark">${t.totalRight} / ${t.totalQ}</div><div class="res-lbl">საბოლოო ქულა · <span id="res-rev-pct" style="color:${col}">${t.finalPct ?? '—'}%</span></div>`
    : `<div class="res-num res-num-mark res-mark-pending" id="res-rev-mark">⚠️</div><div class="res-lbl">შეუმოწმებელი</div>`;

  const summaryHtml = `
    <div class="res-summary-grid">
      <div class="res-stat"><div class="res-num" id="res-rev-total">${t.totalQ}</div><div class="res-lbl">სულ ქულა</div></div>
      <div class="res-stat"><div class="res-num" style="color:var(--green)" id="res-rev-right">${t.totalRight}</div><div class="res-lbl">მიღებული</div></div>
      <div class="res-stat"><div class="res-num" style="color:var(--red)" id="res-rev-wrong">${t.totalWrong}</div><div class="res-lbl">${t.complete ? 'დაკარგული' : 'დაკარგ. / შეუმოწმ.'}</div></div>
      <div class="res-stat">${markCell}</div>
    </div>
    <div class="res-score-bar"><div class="res-score-fill" style="width:0;background:${col}" id="rev-fill"></div></div>
    ${notice}`;

  const backBtn = isLive
    ? `<button class="res-back-btn" onclick="backToSelection()">← მთავარი გვერდი</button>`
    : `<button class="res-back-btn" onclick="closeReview()">← სტატისტიკა</button>`;
  const subText = isLive ? 'გამოცდა დასრულდა' : fmtDate(s.date);
  const title   = isLive ? '🎓 გამოცდის შედეგები' : `📋 ${s.label} — სრული მიმოხილვა`;

  const rs = document.getElementById('results-screen');
  rs.innerHTML = `
    <div class="res-topbar">
      <div class="res-topbar-title">
        <span>${exam.title} — ${exam.variantLabel}</span>
        <span class="res-topbar-sub">${exam.date} · ${subText}</span>
      </div>
      ${backBtn}
    </div>
    <div class="res-summary-card">
      <div class="res-summary-title">${title}</div>
      ${summaryHtml}
    </div>
    <div class="res-questions-list">${cards}</div>`;

  const welcome = document.getElementById('welcome-screen');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('selection-screen').style.display = 'none';
  rs.style.display = 'flex';
  if (!keepView) window.scrollTo(0, 0);
  setTimeout(() => { const f = document.getElementById('rev-fill'); if (f) f.style.width = (t.finalPct ?? 0) + '%'; }, 200);
}

// Grade an open answer from the results/review screen, then re-render in place
// (preserving scroll position and which questions are expanded).
function gradeOpenResult(sessionId, key, val) {
  const stats = loadStats();
  const s = stats.sessions.find(x => x.id === sessionId);
  if (!s) return;
  if (!s.openGrades) s.openGrades = {};
  if (s.openGrades[key] === val) delete s.openGrades[key];   // click active again → un-grade
  else s.openGrades[key] = val;
  syncSessionScore(s);
  saveStats(stats);

  // Preserve view across the re-render
  const isLive = !!(window._reviewState && window._reviewState.isLive);
  const openIdx = [];
  document.querySelectorAll('#results-screen details').forEach((d, i) => { if (d.open) openIdx.push(i); });
  const sy = window.scrollY;

  renderResultReview(sessionId, isLive, true);

  const dets = document.querySelectorAll('#results-screen details');
  openIdx.forEach(i => { if (dets[i]) dets[i].open = true; });
  window.scrollTo(0, sy);
}

function buildResultGradeButtons(sessionId, key, grades) {
  const saved  = (grades || {})[key];
  const okCls  = saved === true  ? ' active' : '';
  const errCls = saved === false ? ' active' : '';
  return `<div class="res-grade-wrap" data-sid="${sessionId}" data-key="${key}">
    <span class="res-grade-q">შეფასება:</span>
    <button class="res-grade-btn res-grade-ok${okCls}"  onclick="gradeOpenResult(${sessionId}, '${key}', true)">✓ სწორი</button>
    <button class="res-grade-btn res-grade-err${errCls}" onclick="gradeOpenResult(${sessionId}, '${key}', false)">✗ არასწორი</button>
  </div>`;
}

function closeReview() {
  document.getElementById('results-screen').style.display = 'none';
  document.getElementById('selection-screen').style.display = 'flex';
  hideWelcome();      // make sure nav + app are visible
  showAnalytics();    // return to the statistics pane
  window.scrollTo(0, 0);
}

// Open-question card for the results/review screen — reads typed answers from the
// saved session (works for matching/selection too) and lets the student grade
// each unit ✓/✗. autoOpen expands cards that still need grading (live screen).
function buildOpenReviewCard(q, r, grades, sessionId, autoOpen) {
  const items = r.items || [];
  let body = '', anyToGrade = false;

  if (!items.length) {
    const typed = r.typed || '';
    const model = r.modelAnswer || q.single_answer || '';
    const key   = q.id;
    if (typed.trim() && grades[key] === undefined) anyToGrade = true;
    body = `<div class="res-open-row">
        <div class="res-open-col"><div class="res-open-lbl">თქვენი პასუხი</div>
          <div class="res-open-typed ${typed ? '' : 'res-open-empty'}">${typed ? escHtml(typed) : '— არ შეგიყვანიათ —'}</div></div>
        ${model ? `<div class="res-open-col"><div class="res-open-lbl">სწორი პასუხი</div>
          <div class="res-open-model">${model}</div></div>` : ''}
      </div>
      ${buildResultGradeButtons(sessionId, key, grades)}`;
  } else {
    body = items.map(item => {
      const typed    = item.typed || '';
      const fullItem = (q.items || []).find(it => String(it.id) === String(item.id)) || {};
      const model    = item.modelAnswer || fullItem.answer || '';
      const itemText = item.text || fullItem.text || '';
      const key      = q.id + '_' + item.id;

      // Worked example — given in the exam, shown read-only, not graded/counted.
      if (fullItem.example) {
        return `<div class="res-open-item">
          <div class="res-open-item-id">${item.id}</div>
          <div class="res-open-item-q">${itemText} <span class="res-badge res-badge-open">ნიმუში</span></div>
          ${model ? `<div class="res-open-model">${model}</div>` : ''}
        </div>`;
      }

      if (typed.trim() && grades[key] === undefined) anyToGrade = true;
      return `<div class="res-open-item">
        <div class="res-open-item-id">${item.id}</div>
        <div class="res-open-item-q">${itemText}</div>
        <div class="res-open-row">
          <div class="res-open-col"><div class="res-open-lbl">თქვენი პასუხი</div>
            <div class="res-open-typed ${typed ? '' : 'res-open-empty'}">${typed ? escHtml(typed) : '— არ შეგიყვანიათ —'}</div></div>
          ${model ? `<div class="res-open-col"><div class="res-open-lbl">სწორი პასუხი</div>
            <div class="res-open-model">${model}</div></div>` : ''}
        </div>
        ${buildResultGradeButtons(sessionId, key, grades)}
      </div>`;
    }).join('');
  }

  const toGradeTag = anyToGrade ? '<span class="res-badge res-badge-tograde">⚠ შესაფასებელი</span>' : '';
  const openAttr   = (autoOpen && anyToGrade) ? ' open' : '';

  return `
    <div class="res-q-card res-q-open">
      <div class="res-q-head">
        <span class="res-q-num open-num">${q.num}</span>
        <span class="res-q-text-short">${q.text.slice(0, 80)}${q.text.length > 80 ? '…' : ''}</span>
        <span class="res-badge res-badge-open">ღია</span>
        ${toGradeTag}
      </div>
      <details class="res-details"${openAttr}>
        <summary>პასუხის ნახვა და შეფასება</summary>
        <div class="res-q-full">
          <div class="q-text">${q.text}</div>
          ${q.note ? `<div class="q-note">⚠️ ${q.note}</div>` : ''}
          ${q.img ? `<div class="q-img-wrap"><img src="${q.img}" alt="ილუსტრაცია" loading="lazy"></div>` : ''}
          ${(typeof renderStmts === 'function') ? renderStmts(q.stmts) : ''}
          ${body}
          ${q.explain ? `<div class="q-explain">📖 ${q.explain}</div>` : ''}
        </div>
      </details>
    </div>`;
}

/* ── Utility ────────────────────────────────────────────────────────────── */

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Auto-balance/close any stray inline tags (<u>, <strong>, <sub>…) in a HTML
// fragment so a malformed tag in the question bank can't bleed its formatting
// into the rest of a multi-question list. The browser closes tags on round-trip.
function balanceHtml(s) {
  try {
    const d = document.createElement('div');
    d.innerHTML = String(s);
    return d.innerHTML;
  } catch {
    return String(s);
  }
}
