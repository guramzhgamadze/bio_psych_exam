// ============================================================
// app.js  —  Exam logic: selection, test mode, results
// ============================================================

/* ── Global exam session ────────────────────────────────────────────────── */
let currentExamKey = null;   // active exam key
let currentQIndex  = 0;      // 0-based index into questions array
let answers        = {};     // { qId: choice }
let submitted      = false;

/* ── Multi-answer helper ─────────────────────────────────────────────────
   answer field supports either a single letter ("ა") or pipe-separated
   multiple correct answers ("ა|გ"). Both student selection and answer key
   are matched with this function everywhere in the app.                   */
function mcqIsCorrect(selected, answerKey) {
  if (!selected || !answerKey) return false;
  return answerKey.split('|').map(s => s.trim()).includes(selected.trim());
}
let timerInterval  = null;
let secondsLeft    = 150 * 60;  // reset properly in startExam()

/* ════════════════════════════════════════════════════════════
   SELECTION SCREEN — year/variant tabs + cover cards
═══════════════════════════════════════════════════════════════ */

/* Exam groups (exam.year = "შუალედური 1", …) and their papers come from EXAMS;
   the original app had years and variant bars hard-coded in index.html.       */
function examGroups() {
  const byYear = {};
  Object.entries(EXAMS).forEach(([key, exam]) => {
    if (!byYear[exam.year]) byYear[exam.year] = { year: exam.year, order: exam.order || 0, variants: [] };
    byYear[exam.year].variants.push({ key, exam });
  });
  const groups = Object.values(byYear).sort((a, b) => a.order - b.order);
  groups.forEach(g => g.variants.sort((a, b) => (a.exam.vorder || 0) - (b.exam.vorder || 0)));
  return groups;
}

// Groups with a single paper open its cover directly
var SINGLE_YEAR = (function () {
  const single = {};
  examGroups().forEach(g => { if (g.variants.length === 1) single[g.year] = g.variants[0].key; });
  return single;
})();

// Desktop tab bar, variant sub-bars and mobile drawer, built from EXAMS
function buildNav() {
  const groups = examGroups();
  const nav = document.getElementById('desktop-nav');
  const statsBtn = nav.querySelector('.analytics-tab');
  groups.forEach(g => {
    statsBtn.insertAdjacentHTML('beforebegin',
      `<button class="year-btn" data-year="${g.year}" onclick="setYear('${g.year}')">${g.year}</button>`);
  });
  let bars = '';
  groups.filter(g => g.variants.length > 1).forEach(g => {
    bars += `<div class="variant-bar" id="vbar-${g.year}">` + g.variants.map((v, i) =>
      `<button class="var-btn${i === 0 ? ' active' : ''}" data-exam="${v.key}" onclick="setVariant('${v.key}')">${v.exam.variantLabel}</button>`
    ).join('') + '</div>';
  });
  nav.insertAdjacentHTML('afterend', bars);

  const drawerYears = document.querySelector('.drawer-years');
  drawerYears.innerHTML = groups.map(g =>
    `<button class="drawer-year-btn" data-year="${g.year}" onclick="drawerSetYear('${g.year}')">${g.year}</button>`
  ).join('');
  let dv = '';
  groups.filter(g => g.variants.length > 1).forEach(g => {
    dv += `<div class="drawer-variants" id="drawer-vbar-${g.year}" style="display:none">
      <div class="drawer-section-label">ბუკლეტი</div>` + g.variants.map(v =>
      `<button class="drawer-var-btn" data-exam="${v.key}" onclick="drawerSetVariant('${v.key}')">${v.exam.variantLabel}</button>`
    ).join('') + '</div>';
  });
  drawerYears.insertAdjacentHTML('afterend', dv);
}

// Exam time limit from "N სთ M წთ" / "N წთ"
function examSeconds(exam) {
  const d = exam.duration || '';
  const h = /(\d+)\s*სთ/.exec(d);
  const m = /(\d+)\s*წთ/.exec(d);
  const total = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  return (total || 60) * 60;
}

function setYear(year) {
  document.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.year-btn[data-year="${year}"]`).classList.add('active');
  document.querySelectorAll('.variant-bar').forEach(b => b.classList.remove('visible'));
  const vbar = document.getElementById('vbar-' + year);
  if (vbar) vbar.classList.add('visible');
  document.querySelectorAll('.cover-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('analytics-pane').classList.remove('active');
  if (SINGLE_YEAR[year]) {
    showCover(SINGLE_YEAR[year]);
  } else {
    const ab = document.querySelector(`#vbar-${CSS.escape(year)} .var-btn.active`);
    if (ab) showCover(ab.dataset.exam);
  }
  // Sync desktop year-btn highlight
  document.querySelectorAll('.year-btn').forEach(b => b.classList.toggle('active', b.dataset.year === year));
  updateMobileLabel(year, null);
}

function setVariant(examKey) {
  const year = EXAMS[examKey].year;
  document.querySelectorAll(`#vbar-${CSS.escape(year)} .var-btn`).forEach(b => b.classList.remove('active'));
  document.querySelector(`.var-btn[data-exam="${examKey}"]`).classList.add('active');
  document.querySelectorAll('.cover-pane').forEach(p => p.classList.remove('active'));
  showCover(examKey);
  updateMobileLabel(EXAMS[examKey].year, EXAMS[examKey].variantLabel);
}

function showCover(examKey) {
  const el = document.getElementById('cover-' + examKey);
  if (el) el.classList.add('active');
}

function showAnalytics() {
  document.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.year-btn[data-year="analytics"]').classList.add('active');
  document.querySelectorAll('.variant-bar').forEach(b => b.classList.remove('visible'));
  document.querySelectorAll('.cover-pane').forEach(p => p.classList.remove('active'));
  const ap = document.getElementById('analytics-pane');
  ap.classList.add('active');
  renderAnalytics();
}

/* ── Build selection screen covers ─────────────────────────────────────── */
function buildSelectionScreen() {
  buildNav();
  const app = document.getElementById('app');
  // Build welcome grid: one card per exam group, in exam.order
  const grid = document.getElementById('wlc-year-grid');
  if (grid) {
    examGroups().forEach(({ year, variants }) => {
      const hasVariants = variants.length > 1;
      const card = document.createElement('div');
      card.className = 'wlc-year-card';

      // Best % for this group — whole-test totals, COMPLETE attempts only
      // (consistent with the statistics page).
      const stats = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"sessions":[]}'); } catch { return {sessions:[]}; } })();
      const yearSessions = stats.sessions.filter(s => s.year === year);
      const completePcts = yearSessions
        .map(s => (EXAMS[s.examKey] && typeof computeReviewTotals === 'function') ? computeReviewTotals(s, EXAMS[s.examKey]) : null)
        .filter(t => t && t.complete && t.finalPct !== null)
        .map(t => t.finalPct);
      const bestPct = completePcts.length ? Math.max(...completePcts) : null;

      let innerHtml = `<div class="wlc-year-num">${year}</div>`;

      if (bestPct !== null) {
        const col = bestPct >= 80 ? 'var(--green)' : bestPct >= 55 ? '#e08800' : 'var(--red)';
        innerHtml += `<div class="wlc-year-best" style="color:${col}">${bestPct}%</div>`;
      } else {
        innerHtml += `<div class="wlc-year-best wlc-year-new">ახალი</div>`;
      }

      if (hasVariants) {
        innerHtml += '<div class="wlc-var-btns">';
        variants.forEach(({key, exam}) => {
          innerHtml += `<button class="wlc-var-btn" onclick="pickYear('${year}');setVariant('${key}')">${exam.variantLabel}</button>`;
        });
        innerHtml += '</div>';
        card.innerHTML = innerHtml;
        card.classList.add('wlc-has-variants');
      } else {
        card.innerHTML = innerHtml;
        card.onclick = () => pickYear(year);
        card.classList.add('wlc-clickable');
      }

      grid.appendChild(card);
    });
  }

  Object.entries(EXAMS).forEach(([key, exam]) => {
    const mcqs  = exam.questions.filter(q => q.type === 'mcq').length;
    const opens = exam.questions.filter(q => q.type === 'open').length;
    // Real point total from the questions (a few old papers have a stale maxScore field).
    const maxScore = exam.questions.reduce((a, q) => a + (q.score || 0), 0) || exam.maxScore;
    const div   = document.createElement('div');
    div.className = 'cover-pane';
    div.id = 'cover-' + key;
    div.innerHTML = `
      <div class="naec-cover">
        <!-- Top strip -->
        <div class="naec-cover-top">
          <div class="naec-cover-org">
<span>ბიოლოგიური ფსიქოლოგია<br>სავარჯიშო ტესტები</span>
          </div>
          <div class="naec-cover-meta-right">
            <span>${exam.year}</span>
            <span class="naec-date">${exam.date}</span>
          </div>
        </div>

        <!-- Big title -->
        <div class="naec-title-wrap">
          <h1 class="naec-title">${exam.title}</h1>
          ${exam.variantLabel !== 'ვარიანტი I' || Object.keys(EXAMS).filter(k=>EXAMS[k].year===exam.year).length>1
            ? `<div class="naec-variant-label">${exam.variantLabel}</div>` : ''}
        </div>

        <!-- Instruction box -->
        <div class="naec-instr-box">
          <div class="naec-instr-title">ი ნ ს ტ რ უ ქ ც ი ა</div>
          <div class="naec-instr-body">
            <p>თქვენ წინაშეა წინა წლების საგამოცდო კითხვების ბუკლეტი.</p>
            <p>ტესტები ავტომატურად შემოწმდება. ღია კითხვებზე პასუხს დასრულების შემდეგ სამოდელო პასუხს შეადარებთ და თავად შეაფასებთ.</p>
            <div class="naec-instr-stats">
              <p><strong>ტესტის მაქსიმალური ქულაა - ${maxScore}.</strong></p>
              <p><strong>ტესტის შესასრულებლად გეძლევათ ${exam.duration}.</strong></p>
              <p><strong>თითოეული დავალების ნომრის წინ ფრჩხილებში მითითებულია დავალების ქულა.</strong></p>
              <p class="naec-good-luck"><strong>გისურვებთ წარმატებას!</strong></p>
            </div>
          </div>
        </div>

        <!-- Bottom nav hint + start -->
        <div class="naec-cover-bottom">
          <div class="naec-key-hints">
            <div class="naec-key-hint-text">შემდეგ გვერდზე გადასასვლელად და უკან დასაბრუნებლად<br>შეგიძლიათ გამოიყენოთ კლავიატურაზე არსებული ღილაკები</div>
            <div class="naec-keys">
              <div class="naec-key naec-key-arrow">↑</div>
              <div class="naec-keys-col">
                <div class="naec-key naec-key-wide">←</div>
                <div class="naec-key naec-key-wide naec-key-active">↓</div>
                <div class="naec-key naec-key-wide">→</div>
              </div>
            </div>
          </div>
          <button class="naec-start-btn" onclick="startExam('${key}')">
            ▶&nbsp;&nbsp;გამოცდის დაწყება
          </button>
        </div>
      </div>`;
    app.appendChild(div);
  });
}

/* ════════════════════════════════════════════════════════════
   AUTOSAVE — persist in-progress exam so it survives a reload
═══════════════════════════════════════════════════════════════ */
const PROGRESS_KEY = 'biopsych_exam_progress_v1';   // own key: the national-exam app lives on the same origin

function saveProgress() {
  if (!currentExamKey || submitted) return;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({
      examKey:     currentExamKey,
      qIndex:      currentQIndex,
      answers,
      secondsLeft,
      savedAt:     Date.now(),
    }));
  } catch (e) {
    console.warn('Could not save progress:', e);
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch {}
}

function resumeExam() {
  const p = loadProgress();
  if (!p || !EXAMS[p.examKey]) { clearProgress(); renderResumeBanner(); return; }

  const exam = EXAMS[p.examKey];
  currentExamKey = p.examKey;
  currentQIndex  = Math.min(Math.max(p.qIndex || 0, 0), exam.questions.length - 1);
  answers        = p.answers || {};
  submitted      = false;
  secondsLeft    = (typeof p.secondsLeft === 'number' && p.secondsLeft > 0)
    ? p.secondsLeft
    : examSeconds(exam);

  document.getElementById('exam-topbar-date').textContent = exam.date;
  document.getElementById('exam-title-bar').textContent   = exam.title;

  const welcome = document.getElementById('welcome-screen');
  if (welcome) welcome.style.display = 'none';
  document.getElementById('selection-screen').style.display = 'none';
  document.getElementById('results-screen').style.display   = 'none';
  document.getElementById('exam-screen').style.display      = 'flex';

  startTimer();
  renderQuestion();
  document.addEventListener('keydown', handleKey);
}

function discardProgress() {
  if (!confirm('დაუსრულებელი გამოცდის წაშლა?')) return;
  clearProgress();
  renderResumeBanner();
}

// Resume banner shown on the welcome screen when a saved exam exists
function renderResumeBanner() {
  const card = document.querySelector('.wlc-card');
  if (!card) return;
  const old = document.getElementById('wlc-resume-banner');
  if (old) old.remove();

  const p = loadProgress();
  if (!p || !EXAMS[p.examKey]) return;

  const exam   = EXAMS[p.examKey];
  const mcqs   = exam.questions.filter(q => q.type === 'mcq');
  const done   = mcqs.filter(q => (p.answers || {})[q.id] !== undefined).length;

  const banner = document.createElement('div');
  banner.id = 'wlc-resume-banner';
  banner.className = 'wlc-resume-banner';
  banner.innerHTML = `
    <div class="wlc-resume-info">
      <span class="wlc-resume-icon">⏳</span>
      <div class="wlc-resume-text">
        <div class="wlc-resume-title">დაუსრულებელი გამოცდა — ${exam.year} · ${exam.variantLabel}</div>
        <div class="wlc-resume-sub">გაგრძელება იქიდან, სადაც გაჩერდით · ${done}/${mcqs.length} ტესტური შევსებული</div>
      </div>
    </div>
    <div class="wlc-resume-actions">
      <button class="wlc-resume-btn" onclick="resumeExam()">▶ გაგრძელება</button>
      <button class="wlc-resume-discard" onclick="discardProgress()">წაშლა</button>
    </div>`;
  card.insertBefore(banner, card.firstChild);
}

/* ════════════════════════════════════════════════════════════
   EXAM MODE
═══════════════════════════════════════════════════════════════ */

function startExam(examKey) {
  currentExamKey = examKey;
  currentQIndex  = 0;
  answers        = {};
  submitted      = false;
  const exam = EXAMS[examKey];
  secondsLeft    = examSeconds(exam);
  document.getElementById('exam-topbar-date').textContent  = exam.date;
  document.getElementById('exam-title-bar').textContent    = exam.title;

  document.getElementById('selection-screen').style.display = 'none';
  document.getElementById('results-screen').style.display   = 'none';
  document.getElementById('exam-screen').style.display      = 'flex';

  startTimer();
  renderQuestion();
  saveProgress();
  document.addEventListener('keydown', handleKey);
}

function exitExam() {
  if (!confirm('გასვლა? პროგრესი შეინახება.')) return;
  saveProgress();
  stopTimer();
  document.removeEventListener('keydown', handleKey);
  document.getElementById('exam-screen').style.display    = 'none';
  document.getElementById('selection-screen').style.display = 'flex';
  showWelcome();
}

/* ── Timer ──────────────────────────────────────────────────────────────── */
function startTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft % 5 === 0) saveProgress();   // persist remaining time periodically
    if (secondsLeft <= 0) { clearInterval(timerInterval); submitExam(true); }
  }, 1000);
}

function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

function updateTimerDisplay() {
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  const str = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const el  = document.getElementById('exam-timer');
  if (!el) return;
  el.textContent = str;
  el.className   = 'exam-timer' + (secondsLeft < 300 ? ' timer-warning' : secondsLeft < 600 ? ' timer-caution' : '');
}

/* ── Navigation ─────────────────────────────────────────────────────────── */
function navigate(dir) {
  const exam = EXAMS[currentExamKey];
  const next = currentQIndex + dir;
  if (next < 0 || next >= exam.questions.length) return;
  currentQIndex = next;
  renderQuestion();
  saveProgress();
}

function goToQuestion(idx) {
  const exam = EXAMS[currentExamKey];
  if (idx < 0 || idx >= exam.questions.length) return;
  currentQIndex = idx;
  renderQuestion();
  saveProgress();
}

function handleKey(e) {
  if (submitted) return;
  if (e.target.tagName === 'TEXTAREA') return; // don't hijack textarea
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
  if (e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  { e.preventDefault(); navigate(-1); }
}

/* ── Render single question ─────────────────────────────────────────────── */
function renderQuestion() {
  const exam = EXAMS[currentExamKey];
  const q    = exam.questions[currentQIndex];
  const total = exam.questions.length;
  const card  = document.getElementById('exam-card');

  // Progress
  document.getElementById('q-counter').textContent = `${currentQIndex + 1} / ${total}`;
  const pct = Math.round((currentQIndex + 1) / total * 100);
  document.getElementById('exam-mini-fill').style.width = pct + '%';

  // Prev/next buttons
  document.getElementById('btn-prev').disabled = (currentQIndex === 0);
  document.getElementById('btn-next').disabled = (currentQIndex === total - 1);

  // Section banner when first question of each part
  let sectionBanner = '';
  if (currentQIndex === 0) {
    const mcqCount = exam.questions.filter(q2 => q2.type === 'mcq').length;
    sectionBanner = `<div class="q-section-banner">ნაწილი I — ტესტური დავალებები (1–${mcqCount})</div>`;
  }
  const firstOpenIdx = exam.questions.findIndex(q2 => q2.type === 'open');
  if (currentQIndex === firstOpenIdx) {
    const opens = exam.questions.filter(q2 => q2.type === 'open');
    sectionBanner = `<div class="q-section-banner open-banner">ნაწილი II — ღია დავალებები (${opens[0].num}–${opens[opens.length-1].num})</div>
      <div class="open-instr">📋 ყურადღებით გაეცანით დავალების პირობას და გაეცით კონკრეტული, ამომწურავი პასუხი.</div>`;
  }

  const isOpen = q.type === 'open';
  const imgHtml = q.img ? `<div class="q-img-wrap"><img src="${q.img}" alt="ილუსტრაცია" loading="lazy"></div>` : '';
  const noteHtml = q.note ? `<div class="q-note">⚠️ ${q.note}</div>` : '';

  // Status dot row for MCQs answered
  const dotRow = buildDotRow(exam);

  card.innerHTML = `
    ${sectionBanner}
    <div class="q-top">
      <div class="q-num-badge ${isOpen ? 'open-badge' : ''}">${q.num}</div>
      <div class="q-pts-badge">${q.score} ქ.</div>
      <div class="q-type-tag ${isOpen ? 'tag-open' : 'tag-mc'}">${isOpen ? 'ღია' : 'ტესტური'}</div>
    </div>
    ${noteHtml}
    <div class="q-text">${q.text}</div>
    ${imgHtml}
    ${isOpen && q.sub_type ? '' : renderStmts(q.stmts)}
    ${isOpen ? renderOpenItems(q) : renderChoices(q)}
    ${dotRow}`;

  // Re-apply selected state for MCQ
  if (!isOpen && answers[q.id]) {
    const sel = card.querySelector(`.opt[data-choice="${answers[q.id]}"]`) ||
                card.querySelector(`.tbl-row-opt[data-choice="${answers[q.id]}"]`);
    if (sel) sel.classList.add('selected');
  }

  // Animate in
  card.classList.remove('slide-in');
  void card.offsetWidth;
  card.classList.add('slide-in');
}

/* ── Dot navigation row ─────────────────────────────────────────────────── */
function buildDotRow(exam) {
  const qs = exam.questions;
  if (!qs.length) return '';

  const dots = qs.map((q, idx) => {
    const isMcq  = q.type === 'mcq';
    const isOpen = q.type === 'open';
    const curr   = idx === currentQIndex;

    // MCQ: blue when answered, open: gold outline always
    let cls = '';
    if (curr)        cls += ' dot-curr';
    if (isMcq && answers[q.id] !== undefined) cls += ' dot-done';
    if (isOpen)      cls += ' dot-open';

    return `<span class="q-dot${cls}" onclick="goToQuestion(${idx})" title="კ.${q.num}"></span>`;
  }).join('');

  return `<div class="dot-row">${dots}</div>`;
}

/* ── Render helpers ─────────────────────────────────────────────────────── */
function renderStmts(stmts) {
  if (!stmts || !stmts.length) return '';
  let out = '<div class="stmts-box">';
  stmts.forEach(item => {
    const [k, v] = Array.isArray(item) ? item : ['', item];
    out += `<div class="stmt-row"><span class="stmt-k">${k}</span><span>${v}</span></div>`;
  });
  return out + '</div>';
}

function renderChoices(q) {
  const ek = currentExamKey;
  if (q.table) {
    const cols = q.table.cols || q.table.columns || [];
    let out = '<table class="tbl-opts"><tr>';
    cols.forEach(c => out += `<th>${c}</th>`);
    out += '</tr>';
    (q.table.rows || []).forEach(row => {
      const k = row[0];
      out += `<tr class="tbl-row-opt" data-choice="${k}" onclick="pickTableRow('${q.id}','${k}',this)">`;
      row.forEach((cell, i) => out += `<td${i===0?' class="tbl-k"':''}>${cell}</td>`);
      out += '</tr>';
    });
    return out + '</table>';
  }
  if (q.choices) {
    let out = '<div class="opts-grid">';
    q.choices.forEach(ch => {
      ch = ch.trim();
      let k = '', v = ch;
      if (ch.includes(')')) { const i=ch.indexOf(')'); k=ch.slice(0,i).trim(); v=ch.slice(i+1).trim(); }
      else if (ch && 'აბგდ'.includes(ch[0])) { k=ch[0]; v=ch.slice(1).replace(/^[)\s]+/,''); }
      out += `<div class="opt" data-choice="${k}" onclick="pickOpt('${q.id}','${k}',this)">
        <span class="opt-k">${k}</span><span>${v}</span></div>`;
    });
    return out + '</div>';
  }
  return '';
}

function renderOpenItems(q) {
  const st = q.sub_type;
  if (st === 'matching')    return renderMatchingGrid(q);
  if (st === 'selection')   return renderSelectionGrid(q);
  if (st === 'select_three') return renderSelectThree(q);
  if (st === 'fill_in')     return renderFillIn(q);
  // Fallback detection even if sub_type missing
  const items0 = (q.items || []);
  if (!st && items0.length && items0[0].id && /\.[xyz]$/.test(String(items0[0].id))) return renderFillIn(q);
  if (!st && q.table_columns && q.table_columns.length && items0.length && items0[0].text && !'XYZ'.includes(items0[0].text)) return renderMatchingGrid(q);

  const items = q.items || [];
  const ek    = currentExamKey;

  if (!items.length) {
    const val = answers['open_' + q.id] || '';
    return `<textarea class="single-ta" id="ta-${ek}-${q.num}"
      placeholder="ჩაწერეთ პასუხი..."
      oninput="saveText('${q.id}',this.value)">${val}</textarea>`;
  }

  return '<div class="sub-qs">' + items.map(item => {
    const safe    = String(item.id).replace(/\./g, '-');

    // Worked example — answer is given in the exam: show it read-only, don't grade.
    if (item.example) {
      return `<div class="sub-q-wrap">
        <div class="sub-q-label"><span class="sub-q-num">${item.id}</span><span>${item.text}</span></div>
        <div class="open-example">${item.answer || ''} <span class="open-example-tag">ნიმუში</span></div>
      </div>`;
    }

    const val     = answers['open_' + q.id + '_' + item.id] || '';
    const revHtml = item.answer
      ? `<div class="answer-reveal" id="irev-${ek}-${q.num}-${safe}" style="display:none">` +
        `<strong>სწორი პასუხი</strong>${item.answer}</div>`
      : '';
    return `<div class="sub-q-wrap">
      <div class="sub-q-label"><span class="sub-q-num">${item.id}</span><span>${item.text}</span></div>
      <textarea class="open-ta" id="ta-${ek}-${q.num}-${safe}"
        placeholder="ჩაწერეთ პასუხი..."
        oninput="saveItemText('${q.id}','${item.id}',this.value)">${val}</textarea>
      ${revHtml}</div>`;
  }).join('') + '</div>';
}

/* ── MATCHING GRID ──────────────────────────────────────────────────────── */
// Layout: [numbered rows | lettered options] side by side, clickable grid below
function renderMatchingGrid(q) {
  const ek   = currentExamKey;
  const cols = q.table_columns || [];
  const rows = q.items || [];
  const opts = q.stmts || [];

  // Left: numbered row labels  |  Right: lettered options
  let leftList = '<div class="match-left">';
  rows.forEach((row, ri) =>
    leftList += `<div class="match-left-item"><span class="match-left-num">${ri+1}.</span>${row.text}</div>`);
  leftList += '</div>';

  let rightList = '<div class="match-right">';
  opts.forEach(s => {
    const [k, v] = Array.isArray(s) ? s : ['', s];
    rightList += `<div class="match-right-item"><span class="match-right-k">${k}.</span>${v}</div>`;
  });
  rightList += '</div>';

  let out = `<div class="match-header">${leftList}${rightList}</div>`;

  // Clickable grid
  out += '<div class="match-grid-wrap"><table class="match-grid"><thead><tr>';
  out += '<th class="match-th-empty"></th>';
  cols.forEach(c => out += `<th class="match-col-head">${c}</th>`);
  out += '</tr></thead><tbody>';
  const matchState = answers['match_' + q.id] || {};
  rows.forEach((row, ri) => {
    out += `<tr><td class="match-row-num">${ri+1}</td>`;
    cols.forEach((col, ci) => {
      const cid = `mcell_${ek}_${q.num}_r${ri}_c${ci}`;
      const active = (matchState[ri] || []).includes(col) ? ' match-cell-active' : '';
      out += `<td class="match-cell${active}" id="${cid}" onclick="toggleMatchCell('${cid}','${q.id}',${ri},'${col}')">` +
             `<span class="match-x">&#x2715;</span></td>`;
    });
    out += '</tr>';
  });
  out += '</tbody></table></div>';

  rows.forEach(row => {
    const safe = String(row.id).replace(/\./g, '-');
    if (row.answer)
      out += `<div class="answer-reveal" id="irev-${ek}-${q.num}-${safe}" style="display:none">` +
             `<strong>სწორი</strong> ${row.text}: <strong>${row.answer}</strong></div>`;
  });
  return out;
}

function toggleMatchCell(cellId, qId, rowIdx, col) {
  if (submitted) return;
  const cell = document.getElementById(cellId);
  if (!cell) return;
  cell.classList.toggle('match-cell-active');
  const key = 'match_' + qId;
  if (!answers[key]) answers[key] = {};
  const cur = new Set(answers[key][rowIdx] || []);
  if (cell.classList.contains('match-cell-active')) cur.add(col); else cur.delete(col);
  answers[key][rowIdx] = [...cur];
  saveProgress();
}

/* ── SELECT-THREE ─────────────────────────────────────────────────────── */
// 6 numbered options on left, 3 blank answer boxes on right
function renderSelectThree(q) {
  const ek    = currentExamKey;
  const stmts = q.stmts || [];
  const items = q.items || [];

  let numList = '<div class="sel-num-list">';
  stmts.forEach(s => {
    const [k, v] = Array.isArray(s) ? s : ['', s];
    numList += `<div class="sel-list-item"><span class="sel-list-num">${k}.</span>${v}</div>`;
  });
  numList += '</div>';

  let boxes = '<table class="s3-tbl"><thead><tr>';
  items.forEach(item => boxes += `<th class="s3-head">&nbsp;</th>`);
  boxes += '</tr></thead><tbody><tr>';
  items.forEach(item => {
    const safe = String(item.id).replace(/\./g, '-');
    const val  = answers['open_' + q.id + '_' + item.id] || '';
    boxes += `<td class="s3-cell"><input type="text" class="s3-input" id="ta-${ek}-${q.num}-${safe}"
      maxlength="2" placeholder="—"
      oninput="saveItemText('${q.id}','${item.id}',this.value)" value="${val}"></td>`;
  });
  boxes += '</tr></tbody></table>';

  let out = `<div class="sel-layout">${numList}<div class="s3-wrap">${boxes}</div></div>`;

  items.forEach(item => {
    const safe = String(item.id).replace(/\./g, '-');
    if (item.answer)
      out += `<div class="answer-reveal" id="irev-${ek}-${q.num}-${safe}" style="display:none">` +
             `<strong>სწორი:</strong> ${item.answer}</div>`;
  });
  return out;
}

/* ── SELECTION ───────────────────────────────────────────────────────────── */
// Layout: numbered list (left) + single-row clickable grid (right)
function renderSelectionGrid(q) {
  const ek   = currentExamKey;
  const stmts = q.stmts || [];
  const item0 = (q.items || [])[0];
  const cols  = stmts.map(s => Array.isArray(s) ? s[0] : '');

  let numList = '<div class="sel-num-list">';
  stmts.forEach(s => {
    const [k, v] = Array.isArray(s) ? s : ['', s];
    numList += `<div class="sel-list-item"><span class="sel-list-num">${k}.</span>${v}</div>`;
  });
  numList += '</div>';

  const selState = answers['sel_' + q.id] || [];
  let grid = '<table class="sel-grid-tbl"><thead><tr>';
  cols.forEach(c => grid += `<th class="sel-grid-head">${c}</th>`);
  grid += '</tr></thead><tbody><tr>';
  cols.forEach(c => {
    const cid = `scell_${ek}_${q.num}_${c}`;
    const active = selState.includes(c) ? ' sel-cell-active' : '';
    grid += `<td class="sel-cell${active}" id="${cid}" onclick="toggleSelItem('${cid}','${q.id}','${c}')">` +
            `<span class="sel-x">&#x2715;</span></td>`;
  });
  grid += '</tr></tbody></table>';

  let out = `<div class="sel-layout">${numList}<div class="sel-grid-wrap">${grid}</div></div>`;

  if (item0 && item0.answer) {
    const safe = String(item0.id).replace(/\./g, '-');
    out += `<div class="answer-reveal" id="irev-${ek}-${q.num}-${safe}" style="display:none">` +
           `<strong>სწორი ნომრები:</strong> ${item0.answer}</div>`;
  }
  return out;
}

function toggleSelItem(cellId, qId, num) {
  if (submitted) return;
  const cell = document.getElementById(cellId);
  if (!cell) return;
  cell.classList.toggle('sel-cell-active');
  const key = 'sel_' + qId;
  if (!answers[key]) answers[key] = [];
  if (cell.classList.contains('sel-cell-active')) answers[key].push(num);
  else answers[key] = answers[key].filter(n => n !== num);
  saveProgress();
}

/* ── FILL-IN ─────────────────────────────────────────────────────────────── */
// Layout: numbered term list (left) + x|y|z column grid (right)
function renderFillIn(q) {
  const ek    = currentExamKey;
  const stmts = q.stmts || [];
  const items = q.items || [];

  let numList = '<div class="fillin-num-list">';
  stmts.forEach(s => {
    const [k, v] = Array.isArray(s) ? s : ['', s];
    numList += `<div class="fillin-list-item"><span class="fillin-list-num">${k}.</span>${v}</div>`;
  });
  numList += '</div>';

  let grid = '<table class="fillin-grid-tbl"><thead><tr>';
  items.forEach(item => {
    grid += `<th class="fillin-grid-head">${String(item.id).split('.').pop().toUpperCase()}</th>`;
  });
  grid += '</tr></thead><tbody><tr>';
  items.forEach(item => {
    const safe = String(item.id).replace(/\./g, '-');
    const val  = answers['open_' + q.id + '_' + item.id] || '';
    grid += `<td class="fillin-grid-cell"><input type="text" class="fillin-grid-input"
      id="ta-${ek}-${q.num}-${safe}" placeholder="№" maxlength="2"
      oninput="saveItemText('${q.id}','${item.id}',this.value)" value="${val}"></td>`;
  });
  grid += '</tr></tbody></table>';

  let out = `<div class="fillin-layout">${numList}<div class="fillin-grid-wrap">${grid}</div></div>`;

  items.forEach(item => {
    const safe = String(item.id).replace(/\./g, '-');
    if (item.answer)
      out += `<div class="answer-reveal" id="irev-${ek}-${q.num}-${safe}" style="display:none">` +
             `<strong>${String(item.id).split('.').pop().toUpperCase()} =</strong> ${item.answer}</div>`;
  });
  return out;
}

/* ── Reveal open answers after submit ───────────────────────────────────── */
function revealOpenAnswers(examKey, q) {
  const ek = examKey;
  const st = q.sub_type;

  if (st === 'matching') {
    const cols = q.table_columns || [];
    (q.items || []).forEach((row, ri) => {
      const correct = (row.answer || '').split(',').map(s => s.trim());
      cols.forEach((col, ci) => {
        const cell = document.getElementById(`mcell_${ek}_${q.num}_r${ri}_c${ci}`);
        if (!cell) return;
        cell.onclick = null;
        if (correct.includes(col)) {
          cell.classList.add(cell.classList.contains('match-cell-active') ? 'match-correct' : 'match-show-correct');
        } else if (cell.classList.contains('match-cell-active')) {
          cell.classList.add('match-wrong');
        }
      });
    });
  }

  if (st === 'selection') {
    const correctNums = (((q.items || [])[0] || {}).answer || '').split(',').map(s => s.trim());
    document.querySelectorAll(`[id^="scell_${ek}_${q.num}_"]`).forEach(el => {
      el.onclick = null;
      const num = el.id.split('_').pop();
      if (correctNums.includes(num)) {
        el.classList.add(el.classList.contains('sel-cell-active') ? 'sel-correct' : 'sel-show-correct');
      } else if (el.classList.contains('sel-cell-active')) {
        el.classList.add('sel-wrong');
      }
    });
  }

  // Disable fill_in inputs
  if (st === 'fill_in') {
    document.querySelectorAll(`[id^="ta-${ek}-${q.num}-"]`).forEach(el => {
      el.setAttribute('disabled', '');
    });
  }

  // Show all answer reveal boxes
  if (q.single_answer) {
    const el = document.getElementById(`srev-${ek}-${q.num}`);
    if (el) el.style.display = 'block';
  }
  (q.items || []).forEach(item => {
    if (!item.answer) return;
    const safe = String(item.id).replace(/\./g, '-');
    const el   = document.getElementById(`irev-${ek}-${q.num}-${safe}`);
    if (el) el.style.display = 'block';
  });
}


/* ── Answer picking ─────────────────────────────────────────────────────── */
function pickOpt(qId, choice, el) {
  if (submitted) return;
  answers[qId] = choice;
  el.closest('.opts-grid').querySelectorAll('.opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  updateDots();
  saveProgress();
}

function pickTableRow(qId, choice, rowEl) {
  if (submitted) return;
  answers[qId] = choice;
  rowEl.closest('.tbl-opts').querySelectorAll('.tbl-row-opt').forEach(r => r.classList.remove('selected'));
  rowEl.classList.add('selected');
  updateDots();
  saveProgress();
}

function saveText(qId, val)                   { answers['open_' + qId] = val; saveProgress(); }
function saveItemText(qId, itemId, val)        { answers['open_' + qId + '_' + itemId] = val; saveProgress(); }

function updateDots() {
  const exam = EXAMS[currentExamKey];
  document.querySelectorAll('.q-dot').forEach((dot, i) => {
    if (i >= exam.questions.length) return;
    const q = exam.questions[i];
    if (q.type === 'mcq') {
      dot.classList.toggle('dot-done', answers[q.id] !== undefined);
    }
    dot.classList.toggle('dot-curr', i === currentQIndex);
  });
}

/* ── Collect open answers from DOM ──────────────────────────────────────── */
function collectOpenAnswers() {
  const exam = EXAMS[currentExamKey];
  const out  = {};
  exam.questions.filter(q => q.type === 'open').forEach(q => {
    const items = q.items || [];
    const st    = q.sub_type;

    if (st === 'matching') {
      const state = answers[`match_${q.id}`] || {};
      out[q.id] = { typed: '', items: items.map((item, ri) => ({
        id:    item.id,
        typed: (state[ri] || []).join(', ') || ''
      }))};
    } else if (st === 'selection') {
      const selected = answers[`sel_${q.id}`] || [];
      const item0 = items[0];
      out[q.id] = item0
        ? { typed: '', items: [{ id: item0.id, typed: selected.join(', ') }] }
        : { typed: selected.join(', '), items: [] };
    } else if (!items.length) {
      out[q.id] = { typed: answers['open_' + q.id] || '', items: [] };
    } else {
      out[q.id] = { typed: '', items: items.map(item => ({
        id:    item.id,
        typed: answers['open_' + q.id + '_' + item.id] || ''
      }))};
    }
  });
  return out;
}

/* ── Submit ─────────────────────────────────────────────────────────────── */
function submitExam(auto = false) {
  if (submitted) return;
  const exam  = EXAMS[currentExamKey];
  const mcqs  = exam.questions.filter(q => q.type === 'mcq');
  const done  = mcqs.filter(q => answers[q.id] !== undefined).length;

  if (!auto && done < mcqs.length) {
    if (!confirm(`${mcqs.length - done} ტესტური კითხვა გაუცემელია. დაასრულოთ?`)) return;
  }

  submitted = true;
  stopTimer();
  clearProgress();   // exam finished — drop the autosave
  document.removeEventListener('keydown', handleKey);

  const openAnswers = collectOpenAnswers();
  let sessionId = null;
  if (typeof recordSession === 'function') sessionId = recordSession(currentExamKey, answers, openAnswers);

  // Reveal open answers on screen before switching to results
  EXAMS[currentExamKey].questions.filter(q => q.type === 'open').forEach(q => {
    revealOpenAnswers(currentExamKey, q);
  });

  // Unified results screen with inline open-answer grading; fall back to the
  // legacy MCQ-only screen if recording failed.
  if (sessionId != null && typeof renderResultReview === 'function') {
    renderResultReview(sessionId, true, false);
  } else {
    buildResultsScreen();
  }
  document.getElementById('exam-screen').style.display    = 'none';
  document.getElementById('results-screen').style.display = 'flex';
}

/* ════════════════════════════════════════════════════════════
   RESULTS SCREEN
═══════════════════════════════════════════════════════════════ */
function buildResultsScreen() {
  const exam  = EXAMS[currentExamKey];
  const mcqs  = exam.questions.filter(q => q.type === 'mcq');
  const hasKey = mcqs.some(q => q.answer);
  let correct = 0, wrong = 0, skipped = 0;

  const qCards = exam.questions.map(q => {
    if (q.type !== 'mcq') return buildOpenResultCard(q);
    const sel = answers[q.id];
    const ans = q.answer;
    let status = 'skipped';
    if (ans) {
      if (mcqIsCorrect(sel, ans)) { status = 'correct'; correct++; }
      else if (sel)               { status = 'wrong';   wrong++; }
      else                        { status = 'skipped'; skipped++; }
    }
    return buildMCQResultCard(q, sel, ans, status);
  }).join('');

  const pct = mcqs.length ? Math.round(correct / mcqs.length * 100) : null;
  const col = pct === null ? 'var(--muted)' : pct >= 80 ? 'var(--green)' : pct >= 55 ? '#e08800' : 'var(--red)';

  const summaryHtml = hasKey ? `
    <div class="res-summary-grid">
      <div class="res-stat"><div class="res-num" style="color:var(--green)">${correct}</div><div class="res-lbl">სწორი</div></div>
      <div class="res-stat"><div class="res-num" style="color:var(--red)">${wrong}</div><div class="res-lbl">არასწორი</div></div>
      <div class="res-stat"><div class="res-num" style="color:var(--muted)">${skipped}</div><div class="res-lbl">გამოტოვ.</div></div>
      <div class="res-stat"><div class="res-num" style="color:${col}">${pct ?? '—'}%</div><div class="res-lbl">შედეგი</div></div>
    </div>
    <div class="res-score-bar"><div class="res-score-fill" style="width:0;background:${col}" id="res-fill"></div></div>` :
    `<div class="res-no-key">გამოცდა დასრულდა.</div>`;

  document.getElementById('results-screen').innerHTML = `
    <div class="res-topbar">
      <div class="res-topbar-title">
        <span>${exam.title} — ${exam.variantLabel}</span>
        <span class="res-topbar-sub">${exam.date} · გამოცდა დასრულდა</span>
      </div>
      <button class="res-back-btn" onclick="backToSelection()">← მთავარი გვერდი</button>
    </div>
    <div class="res-summary-card">
      <div class="res-summary-title">🎓 გამოცდის შედეგები</div>
      ${summaryHtml}
    </div>
    <div class="res-questions-list">${qCards}</div>`;

  if (hasKey) setTimeout(() => {
    const fill = document.getElementById('res-fill');
    if (fill) fill.style.width = pct + '%';
  }, 200);
}

function buildMCQResultCard(q, sel, ans, status) {
  const opts = (q.choices || []).map(ch => {
    ch = ch.trim();
    let k='', v=ch;
    if (ch.includes(')')) { const i=ch.indexOf(')'); k=ch.slice(0,i).trim(); v=ch.slice(i+1).trim(); }
    else if (ch && 'აბგდ'.includes(ch[0])) { k=ch[0]; v=ch.slice(1).replace(/^[)\s]+/,''); }
    const isCorrect = ans && mcqIsCorrect(k, ans);
    const isWrong   = k === sel && !mcqIsCorrect(sel, ans);
    const cls = isCorrect ? 'res-opt-correct' : isWrong ? 'res-opt-wrong' : '';
    const icon = isCorrect ? '✓ ' : isWrong ? '✗ ' : '';
    return `<div class="res-opt ${cls}"><span class="res-opt-k">${k}</span><span>${icon}${v}</span></div>`;
  }).join('');
  const tbl = q.table ? buildTableResult(q, sel, ans) : '';
  const imgHtml = q.img ? `<div class="q-img-wrap"><img src="${q.img}" alt="ილუსტრაცია" loading="lazy"></div>` : '';
  const statusCls = {correct:'res-card-correct', wrong:'res-card-wrong', skipped:'res-card-skipped'}[status] || '';
  const badge = {correct:'✓ სწორი', wrong:'✗ არასწორი', skipped:'— გამოტოვებული'}[status] || '';
  const badgeCls = {correct:'res-badge-ok', wrong:'res-badge-err', skipped:'res-badge-skip'}[status] || '';
  return `
    <div class="res-q-card ${statusCls}">
      <div class="res-q-head">
        <span class="res-q-num">${q.num}</span>
        <span class="res-q-text-short">${q.text.slice(0,80)}${q.text.length>80?'…':''}</span>
        ${ans ? `<span class="res-badge ${badgeCls}">${badge}</span>` : ''}
      </div>
      <details class="res-details">
        <summary>დეტალების ნახვა</summary>
        <div class="res-q-full">
          <div class="q-text">${q.text}</div>
          ${imgHtml}
          ${(q.sub_type) ? '' : renderStmts(q.stmts)}
          ${opts || tbl}
          ${q.explain ? `<div class="q-explain">📖 ${q.explain}</div>` : ''}
        </div>
      </details>
    </div>`;
}

function buildTableResult(q, sel, ans) {
  const cols = q.table.cols || q.table.columns || [];
  let out = '<table class="tbl-opts res-tbl"><tr>';
  cols.forEach(c => out += `<th>${c}</th>`);
  out += '</tr>';
  (q.table.rows||[]).forEach(row => {
    const k = row[0];
    const isCorrect = ans && mcqIsCorrect(k, ans);
    const isWrong   = k === sel && !mcqIsCorrect(sel, ans);
    const cls = isCorrect ? 'show-correct' : isWrong ? 'wrong-opt' : '';
    out += `<tr class="tbl-row-opt ${cls}">`;
    row.forEach((cell,i) => out += `<td${i===0?' class="tbl-k"':''}>${cell}</td>`);
    out += '</tr>';
  });
  return out + '</table>';
}

function buildOpenResultCard(q) {
  const items = q.items || [];
  let body = '';
  if (!items.length) {
    const typed = answers['open_' + q.id] || '';
    body = `<div class="res-open-row">
      <div class="res-open-col"><div class="res-open-lbl">თქვენი პასუხი</div>
        <div class="res-open-typed ${typed ? '' : 'res-open-empty'}">${typed || '— არ შეგიყვანიათ —'}</div></div>
      ${q.single_answer ? `<div class="res-open-col"><div class="res-open-lbl">სწორი პასუხი</div>
        <div class="res-open-model">${q.single_answer}</div></div>` : ''}
    </div>`;
  } else {
    body = items.map(item => {
      const typed = answers['open_' + q.id + '_' + item.id] || '';
      return `<div class="res-open-item">
        <div class="res-open-item-id">${item.id}</div>
        <div class="res-open-item-q">${item.text}</div>
        <div class="res-open-row">
          <div class="res-open-col"><div class="res-open-lbl">თქვენი პასუხი</div>
            <div class="res-open-typed ${typed?'':'res-open-empty'}">${typed||'— არ შეგიყვანიათ —'}</div></div>
          ${item.answer ? `<div class="res-open-col"><div class="res-open-lbl">სწორი პასუხი</div>
            <div class="res-open-model">${item.answer}</div></div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  return `
    <div class="res-q-card res-q-open">
      <div class="res-q-head">
        <span class="res-q-num open-num">${q.num}</span>
        <span class="res-q-text-short">${q.text.slice(0,80)}${q.text.length>80?'…':''}</span>
        <span class="res-badge res-badge-open">ღია</span>
      </div>
      <details class="res-details">
        <summary>პასუხების ნახვა</summary>
        <div class="res-q-full"><div class="q-text">${q.text}</div>${body}${q.explain ? `<div class="q-explain">📖 ${q.explain}</div>` : ''}</div>
      </details>
    </div>`;
}

function backToSelection() {
  // Warn if the just-finished exam still has ungraded open answers (score won't count).
  try {
    const st = window._reviewState;
    if (st && st.isLive && typeof computeReviewTotals === 'function' && typeof loadStats === 'function') {
      const s = loadStats().sessions.find(x => x.id === st.sessionId);
      const exam = s && EXAMS[s.examKey];
      if (s && exam) {
        const t = computeReviewTotals(s, exam);
        if (!t.complete && !confirm(`${t.ungradedTyped} ღია პასუხი ჯერ არ არის შემოწმებული. სანამ ყველას არ შეამოწმებთ, ქულა არ ჩაითვლება სტატისტიკაში. დატოვებთ მაინც?`)) return;
      }
    }
  } catch (e) { /* non-fatal */ }

  document.getElementById('results-screen').style.display   = 'none';
  document.getElementById('selection-screen').style.display = 'flex';
  showWelcome();
  const yr = EXAMS[currentExamKey].year;
  setYear(yr);
  // Restore drawer year highlight
  document.querySelectorAll('.drawer-year-btn').forEach(b => b.classList.toggle('active', b.dataset.year === yr));
}


/* ════════════════════════════════════════════════════════════
   MOBILE DRAWER MENU
════════════════════════════════════════════════════════════ */

function openMobileMenu() {
  document.getElementById('mobile-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  document.getElementById('mobile-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function drawerSetYear(year) {
  hideWelcome();
  setYear(year);
  // Show/hide variant sub-menus inside drawer
  document.querySelectorAll('.drawer-variants').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.drawer-var-btn').forEach(b => b.classList.remove('active'));
  const dv = document.getElementById('drawer-vbar-' + year);
  if (dv) dv.style.display = 'flex';
  // Highlight active year in drawer
  document.querySelectorAll('.drawer-year-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.year === year);
  });
  // Update mobile topbar label
  updateMobileLabel(year, null);
  // Don't close yet if year has variants — let user pick
  if (!dv) closeMobileMenu();
}

function drawerSetVariant(examKey) {
  hideWelcome();
  setVariant(examKey);
  document.querySelectorAll('.drawer-var-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.exam === examKey);
  });
  const exam = EXAMS[examKey];
  updateMobileLabel(exam.year, exam.variantLabel);
  closeMobileMenu();
}

function drawerShowAnalytics() {
  hideWelcome();
  showAnalytics();
  document.querySelectorAll('.drawer-year-btn').forEach(b => b.classList.remove('active'));
  updateMobileLabel('სტატისტიკა', null);
  closeMobileMenu();
}

function updateMobileLabel(year, variant) {
  const yl = document.getElementById('mobile-active-label');
  const vl = document.getElementById('mobile-active-variant');
  if (yl) yl.textContent = year;
  if (vl) vl.textContent = variant || '';
}


/* ════════════════════════════════════════════════════════════
   WELCOME PAGE
════════════════════════════════════════════════════════════ */

function showWelcome() {
  // Hide the whole selection screen (it has min-height:100vh and would
  // otherwise stack below the welcome screen on mobile, adding empty scroll).
  const sel = document.getElementById('selection-screen');
  if (sel) sel.style.display = 'none';
  document.getElementById('app').style.display              = 'none';
  document.getElementById('desktop-nav').style.display      = 'none';
  const mobileTopbar = document.getElementById('mobile-topbar');
  if (mobileTopbar) mobileTopbar.style.display              = 'none';
  document.querySelectorAll('.variant-bar').forEach(b => b.style.display = 'none');

  const welcome = document.getElementById('welcome-screen');
  if (welcome) welcome.style.display = 'flex';

  renderResumeBanner();
}

function hideWelcome() {
  const welcome = document.getElementById('welcome-screen');
  if (welcome) welcome.style.display = 'none';

  const sel = document.getElementById('selection-screen');
  if (sel) sel.style.display = '';   // restore stylesheet flex
  document.getElementById('app').style.display         = '';
  document.getElementById('desktop-nav').style.display = '';
  const mobileTopbar = document.getElementById('mobile-topbar');
  if (mobileTopbar) mobileTopbar.style.display         = '';
  // showWelcome() hides the variant bars inline; give control back to the .visible class
  document.querySelectorAll('.variant-bar').forEach(b => b.style.display = '');
}

function pickYear(year) {
  hideWelcome();
  setYear(year);
}

function pickAnalytics() {
  hideWelcome();
  showAnalytics();
}

function goHome() {
  closeMobileMenu();   // harmless on desktop; closes the drawer on mobile
  showWelcome();
}

/* ════════════════════════════════════════════════════════════
   SWIPE GESTURES  (mobile touch support)
════════════════════════════════════════════════════════════ */
(function initSwipe() {
  let tx = 0, ty = 0;
  const MIN = 40, MAX_CROSS = 80;

  document.addEventListener('touchstart', function(e) {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    // Exam screen: swipe up/down/left/right → navigate
    const examScreen = document.getElementById('exam-screen');
    if (examScreen && examScreen.style.display !== 'none') {
      if (e.target.closest('textarea')) return;
      if (adx > MIN && adx > ady && ady < MAX_CROSS) {
        dx < 0 ? navigate(1) : navigate(-1);
      }
      return;
    }

    // Drawer open: swipe left to close
    const drawer = document.getElementById('mobile-drawer');
    if (drawer && drawer.classList.contains('open')) {
      if (dx < -MIN && ady < MAX_CROSS) closeMobileMenu();
      return;
    }

    // Welcome/selection: edge swipe right to open drawer
    const ham = document.getElementById('hamburger-btn');
    if (ham && getComputedStyle(ham).display !== 'none' && tx < 40) {
      if (dx > MIN && ady < MAX_CROSS) openMobileMenu();
    }
  }, { passive: true });
})();

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  buildSelectionScreen();
  showWelcome();   // renders the resume banner if a saved exam exists
});

// Final safety net: persist the moment the tab is closed/refreshed/backgrounded
window.addEventListener('beforeunload', saveProgress);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
});
