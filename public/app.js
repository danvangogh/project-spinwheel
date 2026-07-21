// The wheel is canvas-drawn, so its colours can't come from CSS directly.
// styles.css defines --seg-* / --wheel-* / --hub-* custom properties and we
// read them here once, cached — restyle the wheel by editing those variables.
let themePalette = null;

function themeColors() {
  if (themePalette) return themePalette;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  themePalette = {
    segments: Array.from({ length: 8 }, (_, i) => v(`--seg-${i + 1}`, '#888')),
    label: v('--wheel-label', '#12131a'),
    labelWeight: v('--wheel-label-weight', '600'),
    stroke: v('--wheel-stroke', '#12131a'),
    strokeW: parseFloat(v('--wheel-stroke-w', '2')),
    hover: v('--wheel-hover', 'rgba(255,255,255,0.25)'),
    emptyFill: v('--wheel-empty', '#1b1d27'),
    emptyStroke: v('--wheel-empty-stroke', '#2c2f3d'),
    hubFill: v('--hub-fill', '#12131a'),
    hubStroke: v('--hub-stroke', '#2c2f3d'),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
  return themePalette;
}

const UNCATEGORIZED = 'Uncategorized';
const HUB_RADIUS = 30;
const LABEL_INSET = 16;   // gap between the rim and the start of a label

const DEFAULT_SETTINGS = {
  noRepeatToday: false,       // exclude tasks already logged today from the wheel
  selection: 'random',        // 'random' | 'cycle' (even split — no repeats until all seen)
};

// selectedCategories empty means "all" — no filtering.
const state = {
  slots: [],
  tasks: [],
  selectedSlotId: null,
  selectedCategories: [],
  settings: { ...DEFAULT_SETTINGS },
  spinCycle: [],              // task ids landed on in the current even-split round
};
let log = [];

let rotation = 0;          // current wheel rotation, radians
let spinning = false;
let hoverIndex = null;     // segment under the cursor, for click affordance
const openGroups = new Set(); // slot ids whose task accordion is expanded
let pending = null;        // the task awaiting a Success/Fail verdict
let timerHandle = null;

const $ = (sel) => document.querySelector(sel);
const canvas = $('#wheel');
const ctx = canvas.getContext('2d');

/* ---------- data ---------- */

// Two storage backends, chosen automatically. The local Node server persists
// to real files via /api/*; the static deployment (Vercel) has no backend, so
// the same app falls back to localStorage — each visitor's data lives only in
// their own browser. Detection happens once, on the first getState().
let useLocalStorage = false;

const LS_STATE = 'spinwheel-state';
const LS_LOG = 'spinwheel-log';

const lsRead = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const lsWrite = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// Mirrors the server's DEFAULT_STATE for first-run visitors with no backend.
const FALLBACK_STATE = {
  slots: [
    { id: 's20', label: '20 min', minutes: 20 },
    { id: 's45', label: '45 min', minutes: 45 },
    { id: 's60', label: '1 hour', minutes: 60 },
  ],
  tasks: [],
};

const api = {
  async getState() {
    if (!useLocalStorage) {
      try {
        const res = await fetch('/api/state');
        if (res.ok) return await res.json();
      } catch { /* no backend reachable */ }
      useLocalStorage = true;
    }
    return lsRead(LS_STATE, FALLBACK_STATE);
  },
  async putState() {
    const body = {
      slots: state.slots,
      tasks: state.tasks,
      settings: state.settings,
      spinCycle: state.spinCycle,
    };
    if (useLocalStorage) return lsWrite(LS_STATE, body);
    await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  async getLog() {
    if (useLocalStorage) return lsRead(LS_LOG, []);
    return (await fetch('/api/log')).json();
  },
  async appendLog(entry) {
    if (useLocalStorage) {
      const entries = lsRead(LS_LOG, []);
      entries.push(entry);
      return lsWrite(LS_LOG, entries);
    }
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  },
};

/* ---------- auth ---------- */

// Non-null when signed in to a backend that has accounts (the cloud deploy).
// The local dev server has no auth and the pure-static build has no backend —
// both run without an account.
let auth = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth');
    if (res.ok) {
      auth = await res.json();
      return 'authed';
    }
    if (res.status === 401) return 'login';
  } catch { /* no backend at all */ }
  return 'open';
}

function showAuthGate() {
  $('#auth-gate').classList.remove('hidden');
  $('#auth-email').focus();
}

let authGateMode = 'login';

$('#auth-mode-toggle').onclick = (e) => {
  e.preventDefault();
  authGateMode = authGateMode === 'login' ? 'signup' : 'login';
  $('#auth-submit').textContent = authGateMode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-mode-toggle').textContent = authGateMode === 'login' ? 'Create one' : 'Sign in';
  $('.auth-toggle').firstChild.textContent = authGateMode === 'login' ? 'No account? ' : 'Have an account? ';
  $('#auth-password').autocomplete = authGateMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').classList.add('hidden');
};

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = $('#auth-error');
  errEl.classList.add('hidden');
  $('#auth-submit').disabled = true;
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: authGateMode,
        email: $('#auth-email').value,
        password: $('#auth-password').value,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      errEl.textContent = body.error || 'Something went wrong — try again.';
      errEl.classList.remove('hidden');
      return;
    }
    auth = body;
    $('#auth-gate').classList.add('hidden');
    await loadApp();
  } finally {
    $('#auth-submit').disabled = false;
  }
};

$('#btn-logout').onclick = async () => {
  await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  });
  location.reload();
};

const uid = () => Math.random().toString(36).slice(2, 9);
const tasksForSlot = (slotId) => state.tasks.filter((t) => t.slotId === slotId);
const slotById = (id) => state.slots.find((s) => s.id === id);

// Tasks predate categories, so fall back rather than dropping them off the wheel.
const categoryOf = (task) => task.category || UNCATEGORIZED;

// Local calendar date, not UTC — an evening session should belong to the day
// you experienced it, and "today" should roll over at your midnight.
const pad2 = (n) => String(n).padStart(2, '0');
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => localDateStr();

// Tasks with any log entry today — spun-and-skipped or completed both count.
const doneTodayIds = () => new Set(
  log.filter((e) => e.date === todayStr()).map((e) => e.taskId)
);

// Slot + category filters only — the pool before daily-repeat rules.
const filteredTasks = () => tasksForSlot(state.selectedSlotId).filter(
  (t) => state.selectedCategories.length === 0 || state.selectedCategories.includes(categoryOf(t))
);

// What the wheel shows and can land on. With "once per day" on, tasks already
// logged today drop off the wheel entirely until tomorrow.
const currentTasks = () => {
  if (!state.settings.noRepeatToday) return filteredTasks();
  const done = doneTodayIds();
  return filteredTasks().filter((t) => !done.has(t.id));
};

// Drop selections that don't exist in the current slot; if nothing survives,
// fall back to "all" rather than showing an empty wheel.
function pruneSelectedCategories() {
  const available = categoriesInSlot();
  state.selectedCategories = state.selectedCategories.filter((c) => available.includes(c));
}

// Categories present in the selected slot — a category with no tasks in this
// slot would just yield an empty wheel, so it isn't offered.
function categoriesInSlot() {
  return [...new Set(tasksForSlot(state.selectedSlotId).map(categoryOf))].sort();
}

function allCategories() {
  return [...new Set(state.tasks.map(categoryOf))].sort();
}

/* ---------- wheel ---------- */

// Match the canvas's backing store to the display's actual pixel density.
// It's declared 440×440 but shown at ~460 CSS px — on a 2x display that
// stretches 440 rendered pixels across ~920 physical ones, blurring the wheel
// and its text. Render at cssSize × dpr and scale the context so all drawing
// code keeps working in logical (CSS) pixels.
let wheelCssSize = 440;

function sizeCanvas() {
  const rectW = canvas.getBoundingClientRect().width;
  if (rectW > 0) wheelCssSize = rectW; // 0 when the Spin view is hidden — keep the last real size
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(wheelCssSize * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return wheelCssSize;
}

function drawWheel() {
  const tasks = currentTasks();
  const theme = themeColors();
  const size = sizeCanvas();
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;

  ctx.clearRect(0, 0, size, size);

  if (tasks.length === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.emptyFill;
    ctx.fill();
    ctx.strokeStyle = theme.emptyStroke;
    ctx.lineWidth = theme.strokeW;
    ctx.stroke();
    return;
  }

  // A lone task isn't a wheel — there's no seam to draw, no hub to anchor
  // slices, and nothing to read radially. Show it as a plain disc.
  if (tasks.length === 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = theme.segments[0];
    ctx.fill();
    if (hoverIndex === 0) {
      ctx.fillStyle = theme.hover;
      ctx.fill();
    }

    ctx.fillStyle = theme.label;
    ctx.font = `${theme.labelWeight} 20px ${theme.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    wrapText(tasks[0].name, cx, cy, r * 1.4, 26);
    return;
  }

  const seg = (Math.PI * 2) / tasks.length;

  tasks.forEach((task, i) => {
    const start = i * seg + rotation;
    const end = start + seg;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = theme.segments[i % theme.segments.length];
    ctx.fill();
    ctx.strokeStyle = theme.stroke;
    ctx.lineWidth = theme.strokeW;
    ctx.stroke();

    if (i === hoverIndex) {
      ctx.fillStyle = theme.hover;
      ctx.fill();
    }

    // Label runs along the segment's midline, reading outward from the hub.
    // Every label is oriented the same way relative to the wheel, so they
    // rotate as one rigid piece — like a physical prize wheel.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + seg / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.label;
    // Thin slices get a slightly smaller face so more of the name survives.
    ctx.font = `${theme.labelWeight} ${tasks.length > 9 ? 13 : 15}px ${theme.fontFamily}`;
    // The label runs inward from the rim and must stop clear of the hub.
    ctx.fillText(fitText(task.name, r - LABEL_INSET - HUB_RADIUS - 6), r - LABEL_INSET, 0);
    ctx.restore();
  });

  // Hub
  ctx.beginPath();
  ctx.arc(cx, cy, HUB_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = theme.hubFill;
  ctx.fill();
  ctx.strokeStyle = theme.hubStroke;
  ctx.lineWidth = theme.strokeW;
  ctx.stroke();
}

// Word-wrap centred text into as many lines as it needs, vertically centred
// on (cx, cy). Used only for the single-task disc, which has room to breathe.
function wrapText(text, cx, cy, maxWidth, lineHeight) {
  const lines = [];
  let line = '';

  text.split(' ').forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);

  const top = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lineHeight));
}

// Trim to the space actually available rather than a guessed character count —
// "Hips physio" and "Wart treatment" are the same length in characters but not
// in pixels. Assumes ctx.font is already set.
function fitText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// Rotate so `index` ends up under the pointer at 12 o'clock, then show it.
// Shared by the random spin and a manual click, so the wheel always agrees
// with the announced task.
function landOn(index, tasks, { turns, jitter, duration, chosen }) {
  spinning = true;
  $('#spin-btn').disabled = true;
  hoverIndex = null;
  hideResult();

  const seg = (Math.PI * 2) / tasks.length;
  const target = -Math.PI / 2 - (index * seg + seg / 2) + jitter + Math.PI * 2 * turns;

  const from = rotation % (Math.PI * 2);
  rotation = from;
  const delta = target - from;
  const start = performance.now();

  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    rotation = from + delta * easeOut(t);
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      spinning = false;
      $('#spin-btn').disabled = false;
      showResult(tasks[index], chosen);
    }
  }
  requestAnimationFrame(frame);
}

function spin() {
  const tasks = currentTasks();
  if (spinning || tasks.length === 0) return;

  // A one-task disc looks identical at every angle, so a long spin would just
  // read as a frozen wheel. The outcome isn't in doubt either — go straight there.
  if (tasks.length === 1) {
    landOn(0, tasks, { turns: 0, jitter: 0, duration: 250, chosen: 'spin' });
    return;
  }

  // Even split: draw only from tasks not yet landed on this round. The wheel
  // still displays everything — the cycle paces the landings, it doesn't
  // remove slices.
  let pool = tasks;
  if (state.settings.selection === 'cycle') {
    let remaining = tasks.filter((t) => !state.spinCycle.includes(t.id));
    if (remaining.length === 0) {
      // Round complete — clear this wheel's tasks from the cycle and restart.
      const ids = new Set(tasks.map((t) => t.id));
      state.spinCycle = state.spinCycle.filter((id) => !ids.has(id));
      api.putState();
      remaining = tasks;
    }
    pool = remaining;
  }

  const winner = pool[Math.floor(Math.random() * pool.length)];
  const index = tasks.findIndex((t) => t.id === winner.id);

  const seg = (Math.PI * 2) / tasks.length;
  landOn(index, tasks, {
    turns: 5 + Math.floor(Math.random() * 3),
    // A little jitter so it doesn't stop dead-centre every time.
    jitter: (Math.random() - 0.5) * seg * 0.7,
    duration: 4200,
    chosen: 'spin',
  });
}

// A deliberate pick doesn't need suspense — just a short turn to bring the
// slice under the pointer.
function pickManually(index) {
  const tasks = currentTasks();
  if (spinning || index == null || index >= tasks.length) return;
  landOn(index, tasks, { turns: 0, jitter: 0, duration: 550, chosen: 'manual' });
}

// Which segment is under a point, or null if outside the ring / on the hub.
function segmentAt(clientX, clientY) {
  const tasks = currentTasks();
  if (tasks.length === 0) return null;

  // The canvas renders in logical (CSS) pixels — see sizeCanvas() — so the
  // hit-test works directly in CSS coordinates, no scaling needed.
  const rect = canvas.getBoundingClientRect();
  const half = rect.width / 2;
  const dx = clientX - rect.left - half;
  const dy = clientY - rect.top - half;
  const dist = Math.hypot(dx, dy);
  // No hub is drawn on the single-task disc, so the centre is clickable there.
  const inner = tasks.length === 1 ? 0 : HUB_RADIUS;
  if (dist > half - 10 || dist < inner) return null;

  const seg = (Math.PI * 2) / tasks.length;
  const TAU = Math.PI * 2;
  const angle = ((Math.atan2(dy, dx) - rotation) % TAU + TAU) % TAU;
  return Math.floor(angle / seg);
}

/* ---------- result + timer ---------- */

function showResult(task, chosen = 'spin') {
  const slot = slotById(state.selectedSlotId);
  pending = { task, slot, chosen, timerStartedAt: null };

  // A landed spin counts toward the even-split round regardless of outcome.
  if (chosen === 'spin' && state.settings.selection === 'cycle' && !state.spinCycle.includes(task.id)) {
    state.spinCycle.push(task.id);
    api.putState(); // fire-and-forget; nothing visible depends on it
  }

  $('#result-task').textContent = task.name;
  $('.result-label').textContent = chosen === 'manual' ? 'You picked' : 'Work on';
  $('#result').classList.remove('hidden');

  // Show the full duration, but wait for an explicit start.
  stopTimer();
  showTime(slot.minutes * 60);
  $('#timer').classList.remove('overtime');
  $('#timer').classList.add('idle');
  $('#timer-start').classList.remove('hidden');
  $('#btn-skip').classList.remove('hidden');
  $('#timer-note').classList.add('hidden');
}

function showTime(seconds) {
  const over = seconds < 0;
  const abs = Math.abs(seconds);
  const mm = String(Math.floor(abs / 60)).padStart(2, '0');
  const ss = String(abs % 60).padStart(2, '0');
  $('#timer').textContent = `${over ? '+' : ''}${mm}:${ss}`;
  $('#timer').classList.toggle('overtime', over);
}

function hideResult() {
  $('#result').classList.add('hidden');
  stopTimer();
  pending = null;
}

function startTimer(totalSeconds) {
  stopTimer();
  const deadline = Date.now() + totalSeconds * 1000;

  const tick = () => {
    const remaining = Math.round((deadline - Date.now()) / 1000);
    showTime(Math.max(remaining, 0));
    // Running the clock out is the success signal — there are no outcome buttons.
    if (remaining <= 0) {
      stopTimer();
      celebrate();
    }
  };

  tick();
  timerHandle = setInterval(tick, 250);
}

/* ---------- celebration ---------- */

// Browsers only allow audio that traces back to a user gesture, so the
// context is created/resumed on the Start-timer click and reused at 00:00.
let audioCtx = null;

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio support — celebration is silent */ }
}

// A short ascending chime (C5–E5–G5–C6), synthesised so there's no audio
// file to load or ship.
function playChime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const t = t0 + i * 0.12;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

// Full-screen confetti burst on a throwaway canvas, in the wheel's palette.
function confettiBurst(duration = 2400) {
  const c = document.createElement('canvas');
  c.className = 'confetti';
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const cc = c.getContext('2d');
  cc.scale(dpr, dpr);

  const colors = themeColors().segments;
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -6 - Math.random() * 9,
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 4,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    cc.clearRect(0, 0, innerWidth, innerHeight);
    parts.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.25;   // gravity
      p.vx *= 0.99;
      p.rot += p.vr;
      cc.save();
      cc.translate(p.x, p.y);
      cc.rotate(p.rot);
      cc.globalAlpha = Math.max(0, 1 - t / duration);
      cc.fillStyle = p.color;
      cc.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cc.restore();
    });
    if (t < duration) requestAnimationFrame(frame);
    else c.remove();
  })(start);
}

function celebrate() {
  playChime();
  confettiBurst();
  const el = $('#timer');
  el.textContent = 'Done!';
  el.classList.add('celebrate');
  $('#timer-note').classList.add('hidden');
  // Let the moment land, then log the success — record() clears the panel
  // and refreshes the stats and today list.
  setTimeout(() => {
    el.classList.remove('celebrate');
    record('success');
  }, 2600);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

async function record(outcome) {
  if (!pending) return;
  const now = new Date();
  await api.appendLog({
    timestamp: now.toISOString(),
    date: localDateStr(now),
    slotId: pending.slot.id,
    slotLabel: pending.slot.label,
    slotMinutes: pending.slot.minutes,
    taskId: pending.task.id,
    task: pending.task.name,
    category: categoryOf(pending.task),
    chosen: pending.chosen,
    // A skip is declining the task you were given — for the stats that's a
    // fail. The `skipped` flag preserves the distinction in the history.
    outcome: outcome === 'skip' ? 'fail' : outcome,
    skipped: outcome === 'skip' || undefined,
    // Time actually on the clock — 0 if the timer was never started.
    elapsedSeconds: pending.timerStartedAt
      ? Math.round((Date.now() - pending.timerStartedAt) / 1000)
      : 0,
  });

  log = await api.getLog();
  renderStats();
  renderDoneToday();
  // With "once per day" on, the task just logged has to drop off the wheel.
  renderWheelArea();
  hideResult();
  if (outcome === 'skip') spin();
}

/* ---------- rendering ---------- */

function renderSlotPicker() {
  const host = $('#slot-picker');
  host.innerHTML = '';
  state.slots.forEach((slot) => {
    const btn = document.createElement('button');
    btn.textContent = slot.label;
    btn.className = slot.id === state.selectedSlotId ? 'selected' : '';
    btn.onclick = () => {
      if (spinning) return;
      state.selectedSlotId = slot.id;
      pruneSelectedCategories();
      hideResult();
      renderSlotPicker();
      renderCategoryPicker();
      renderWheelArea();
    };
    host.appendChild(btn);
  });
}

function renderCategoryPicker() {
  const host = $('#category-picker');
  host.innerHTML = '';
  // Counts respect the "once per day" rule so a chip's number always matches
  // how many slices selecting it would put on the wheel.
  const done = state.settings.noRepeatToday ? doneTodayIds() : new Set();
  const slotTasks = tasksForSlot(state.selectedSlotId).filter((t) => !done.has(t.id));
  const showingAll = state.selectedCategories.length === 0;

  const all = document.createElement('button');
  all.textContent = `All categories (${slotTasks.length})`;
  all.className = showingAll ? 'selected' : '';
  all.onclick = () => {
    if (spinning) return;
    state.selectedCategories = [];
    hideResult();
    renderCategoryPicker();
    renderWheelArea();
  };
  host.appendChild(all);

  categoriesInSlot().forEach((category) => {
    const count = slotTasks.filter((t) => categoryOf(t) === category).length;
    const active = state.selectedCategories.includes(category);

    const btn = document.createElement('button');
    btn.textContent = `${active ? '✓ ' : ''}${category} (${count})`;
    btn.className = active ? 'selected' : '';
    btn.onclick = () => {
      if (spinning) return;
      // Toggle. Deselecting the last one falls back to "all".
      state.selectedCategories = active
        ? state.selectedCategories.filter((c) => c !== category)
        : [...state.selectedCategories, category];
      hideResult();
      renderCategoryPicker();
      renderWheelArea();
    };
    host.appendChild(btn);
  });
}

function renderWheelArea() {
  const empty = currentTasks().length === 0;
  // Distinguish "no tasks exist here" from "everything's already done today".
  const allDone = empty && filteredTasks().length > 0;
  const emptyEl = $('#wheel-empty');
  emptyEl.classList.toggle('hidden', !empty);
  emptyEl.innerHTML = allDone
    ? 'Everything on this wheel is done for today 🎉'
    : 'No tasks in this slot yet — add some under <strong>Manage</strong>.';
  $('#pick-hint').classList.toggle('hidden', empty);
  $('#spin-btn').disabled = empty || spinning;
  drawWheel();
}

function renderManage() {
  // Slots
  $('#slot-summary').textContent = `${state.slots.length} slot${state.slots.length === 1 ? '' : 's'}`;
  const slotList = $('#slot-list');
  slotList.innerHTML = '';
  state.slots.forEach((slot) => {
    const count = tasksForSlot(slot.id).length;
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(slot.label)} <span class="meta">${slot.minutes} min · ${count} task${count === 1 ? '' : 's'}</span></span>`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Remove';
    del.onclick = () => removeSlot(slot.id);
    li.appendChild(del);
    slotList.appendChild(li);
  });

  // Tasks, grouped by slot
  const groups = $('#task-groups');
  groups.innerHTML = '';
  state.slots.forEach((slot) => {
    const tasks = tasksForSlot(slot.id);
    const group = document.createElement('details');
    group.className = 'group accordion';
    // Re-rendering rebuilds these nodes, so open/closed lives outside the DOM.
    group.open = openGroups.has(slot.id);
    group.ontoggle = () => {
      if (group.open) openGroups.add(slot.id);
      else openGroups.delete(slot.id);
    };

    const heading = document.createElement('summary');
    heading.innerHTML = `<h4>${escapeHtml(slot.label)}</h4><span class="count">${
      tasks.length} task${tasks.length === 1 ? '' : 's'}</span>`;
    group.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'accordion-body';
    group.appendChild(body);

    if (tasks.length === 0) {
      const p = document.createElement('p');
      p.className = 'meta';
      p.textContent = 'No tasks yet.';
      body.appendChild(p);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'list';
      tasks.forEach((task) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${escapeHtml(task.name)}</span>`;

        // Editable in place, so existing tasks can be categorised without
        // deleting and re-adding them.
        const cat = document.createElement('input');
        cat.type = 'text';
        cat.className = 'cat-edit';
        cat.value = task.category || '';
        cat.placeholder = UNCATEGORIZED;
        cat.setAttribute('list', 'category-options');
        // Save without re-rendering this list — rebuilding the row mid-edit
        // would clobber the input the user is still typing in.
        cat.onchange = async () => {
          const value = cat.value.trim();
          task.category = value || undefined;
          await persistQuietly();
        };
        li.appendChild(cat);

        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = 'Remove';
        del.onclick = () => removeTask(task.id);
        li.appendChild(del);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    groups.appendChild(group);
  });

  // Slot dropdown on the task form
  const select = $('#task-slot');
  const previous = select.value;
  select.innerHTML = '';
  state.slots.forEach((slot) => {
    const opt = document.createElement('option');
    opt.value = slot.id;
    opt.textContent = slot.label;
    select.appendChild(opt);
  });
  if (state.slots.some((s) => s.id === previous)) select.value = previous;
  else if (state.selectedSlotId) select.value = state.selectedSlotId;

  // Autocomplete for categories already in use, so they stay consistent.
  $('#category-options').innerHTML = allCategories()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
}

// What's been accomplished today — successes only, shown under the wheel.
function renderDoneToday() {
  const host = $('#done-today');
  const today = todayStr();
  const done = log.filter((e) => e.date === today && e.outcome === 'success');
  host.innerHTML = done.length === 0 ? '' : `<span class="done-label">Done today</span>${
    done.map((e) => `<span class="done-chip">✓ ${escapeHtml(e.task)}</span>`).join('')
  }`;
}

function renderStats() {
  const scored = log.filter((e) => e.outcome === 'success' || e.outcome === 'fail');
  const successes = scored.filter((e) => e.outcome === 'success').length;
  // An em dash for "no data" — 0% would read as "you failed everything".
  const pct = (hits, total) => (total ? `${Math.round((hits / total) * 100)}%` : '—');
  const rate = pct(successes, scored.length);
  const days = new Set(log.map((e) => e.date)).size;

  $('#stats-summary').innerHTML = `
    <div class="stat"><div class="value">${scored.length}</div><div class="label">Sessions logged</div></div>
    <div class="stat"><div class="value">${rate}</div><div class="label">Success rate</div></div>
    <div class="stat"><div class="value">${log.filter((e) => e.skipped || e.outcome === 'skip').length}</div><div class="label">Skipped</div></div>
    <div class="stat"><div class="value">${days}</div><div class="label">Days active</div></div>
  `;

  // Per category
  const byCat = new Map();
  scored.forEach((e) => {
    const key = e.category || UNCATEGORIZED;
    const row = byCat.get(key) || { category: key, success: 0, fail: 0 };
    row[e.outcome] += 1;
    byCat.set(key, row);
  });

  const catRows = [...byCat.values()].sort((a, b) => (b.success + b.fail) - (a.success + a.fail));
  const catTable = $('#stats-categories');
  catTable.innerHTML = catRows.length === 0
    ? '<tr><td class="meta">Nothing logged yet.</td></tr>'
    : `<tr><th>Category</th><th class="num">Success</th><th class="num">Fail</th><th class="num rate">Rate</th></tr>
       ${catRows.map((r) => {
         const total = r.success + r.fail;
         return `<tr>
           <td>${escapeHtml(r.category)}</td>
           <td class="num">${r.success}</td>
           <td class="num">${r.fail}</td>
           <td class="num rate">${Math.round((r.success / total) * 100)}%</td>
         </tr>`;
       }).join('')}`;

  // Per task, keyed by name so renamed/removed tasks still show their history.
  const byTask = new Map();
  scored.forEach((e) => {
    const row = byTask.get(e.task) || { task: e.task, success: 0, fail: 0 };
    row[e.outcome] += 1;
    byTask.set(e.task, row);
  });

  const rows = [...byTask.values()].sort((a, b) => (b.success + b.fail) - (a.success + a.fail));
  const table = $('#stats-table');
  if (rows.length === 0) {
    table.innerHTML = '<tr><td class="meta">Nothing logged yet.</td></tr>';
  } else {
    table.innerHTML = `
      <tr><th>Task</th><th class="num">Success</th><th class="num">Fail</th><th class="num rate">Rate</th></tr>
      ${rows.map((r) => {
        const total = r.success + r.fail;
        return `<tr>
          <td>${escapeHtml(r.task)}</td>
          <td class="num">${r.success}</td>
          <td class="num">${r.fail}</td>
          <td class="num rate">${Math.round((r.success / total) * 100)}%</td>
        </tr>`;
      }).join('')}
    `;
  }

  const recent = $('#stats-recent');
  const latest = log.slice(-15).reverse();
  recent.innerHTML = latest.length === 0
    ? '<li class="meta">Nothing logged yet.</li>'
    : latest.map((e) => `
      <li>
        <span>${escapeHtml(e.task)} <span class="meta">${e.date} · ${escapeHtml(e.slotLabel)} · ${escapeHtml(e.category || UNCATEGORIZED)} · ${
          (e.chosen || 'spin') === 'manual' ? 'picked' : 'spun'}${e.skipped ? ' · skipped' : ''}</span></span>
        <span class="badge ${e.outcome}">${e.outcome}</span>
      </li>`).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- mutations ---------- */

// Persist and refresh everything except the Manage task list, so an in-place
// edit keeps its focus and caret.
async function persistQuietly() {
  await api.putState();
  pruneSelectedCategories();
  renderCategoryPicker();
  renderWheelArea();
  $('#category-options').innerHTML = allCategories()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
}

async function persist() {
  await api.putState();
  pruneSelectedCategories();
  renderSlotPicker();
  renderCategoryPicker();
  renderWheelArea();
  renderManage();
}

async function removeSlot(id) {
  state.slots = state.slots.filter((s) => s.id !== id);
  state.tasks = state.tasks.filter((t) => t.slotId !== id);
  if (state.selectedSlotId === id) {
    state.selectedSlotId = state.slots[0]?.id || null;
    hideResult();
  }
  await persist();
}

async function removeTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  await persist();
}

/* ---------- wiring ---------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $(`#view-${tab.dataset.view}`).classList.add('active');
    // The canvas measures 0 while its view is hidden; redraw now that it has size.
    if (tab.dataset.view === 'spin') drawWheel();
  };
});

window.addEventListener('resize', () => drawWheel());

/* Settings modal */

function renderSettings() {
  $('#set-norepeat').checked = state.settings.noRepeatToday;
  $('#sel-random').classList.toggle('active', state.settings.selection === 'random');
  $('#sel-cycle').classList.toggle('active', state.settings.selection === 'cycle');
}

const settingsModal = $('#settings-modal');

$('#settings-btn').onclick = () => {
  renderSettings();
  settingsModal.classList.remove('hidden');
};
$('#settings-close').onclick = () => settingsModal.classList.add('hidden');
settingsModal.onclick = (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') settingsModal.classList.add('hidden');
});

$('#set-norepeat').onchange = async (e) => {
  state.settings.noRepeatToday = e.target.checked;
  await persist();
};

async function setSelectionMode(mode) {
  state.settings.selection = mode;
  renderSettings();
  await persist();
}
$('#sel-random').onclick = () => setSelectionMode('random');
$('#sel-cycle').onclick = () => setSelectionMode('cycle');

$('#spin-btn').onclick = spin;

canvas.onclick = (e) => pickManually(segmentAt(e.clientX, e.clientY));

canvas.onmousemove = (e) => {
  if (spinning) return;
  const index = segmentAt(e.clientX, e.clientY);
  if (index === hoverIndex) return;
  hoverIndex = index;
  canvas.style.cursor = index === null ? 'default' : 'pointer';
  drawWheel();
};

canvas.onmouseleave = () => {
  if (spinning || hoverIndex === null) return;
  hoverIndex = null;
  drawWheel();
};
$('#timer-start').onclick = () => {
  if (!pending || pending.timerStartedAt) return;
  ensureAudio(); // unlock audio while we still have a user gesture
  pending.timerStartedAt = Date.now();
  $('#timer').classList.remove('idle');
  $('#timer-start').classList.add('hidden');
  $('#btn-skip').classList.add('hidden');
  $('#timer-note').classList.remove('hidden');
  startTimer(pending.slot.minutes * 60);
};

$('#btn-skip').onclick = () => record('skip');

$('#slot-form').onsubmit = async (e) => {
  e.preventDefault();
  const label = $('#slot-label').value.trim();
  const minutes = parseInt($('#slot-minutes').value, 10);
  if (!label || !minutes) return;
  state.slots.push({ id: uid(), label, minutes });
  if (!state.selectedSlotId) state.selectedSlotId = state.slots[0].id;
  e.target.reset();
  await persist();
};

$('#task-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#task-name').value.trim();
  const category = $('#task-category').value.trim();
  const slotId = $('#task-slot').value;
  if (!name || !category || !slotId) return;
  state.tasks.push({ id: uid(), name, category, slotId });
  $('#task-name').value = '';
  $('#task-name').focus();
  await persist();
};

async function loadApp() {
  const loaded = await api.getState();
  state.slots = loaded.slots || [];
  state.tasks = loaded.tasks || [];
  state.settings = { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) };
  state.spinCycle = Array.isArray(loaded.spinCycle) ? loaded.spinCycle : [];
  state.selectedSlotId = state.slots[0]?.id || null;
  log = await api.getLog();

  // Account section in settings only exists in the signed-in cloud mode.
  $('#account-section').classList.toggle('hidden', !auth);
  if (auth) $('#account-email').textContent = auth.email;

  renderSlotPicker();
  renderCategoryPicker();
  renderWheelArea();
  renderManage();
  renderStats();
  renderDoneToday();
}

(async function init() {
  const mode = await checkAuth();
  if (mode === 'login') {
    showAuthGate();
    return; // loadApp() runs after a successful sign-in
  }
  await loadApp();
})();
