/* TimeChunkz admin dashboard. Fetches /api/admin (owner-only; returns 404 to
   anyone else) and renders usage metrics. Read-only — no mutations here. */

const $ = (sel) => document.querySelector(sel);

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n || 0);

const pad2 = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// The API returns only days that had data; build a continuous 30-day axis so
// the bars keep their true spacing (gaps read as zero, not as missing).
function last30Days() {
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(dayStr(d));
  }
  return days;
}

function renderStats(t) {
  const rate = t.completions + t.fails
    ? `${Math.round((t.completions / (t.completions + t.fails)) * 100)}%`
    : '—';
  const cards = [
    { value: fmt(t.users), label: 'Total users', sub: `${fmt(t.signups)} tracked signups` },
    { value: fmt(t.activeToday), label: 'Active today', sub: `${fmt(t.active7d)} in 7d · ${fmt(t.active30d)} in 30d` },
    { value: fmt(t.visits), label: 'App opens', sub: `${fmt(t.logins)} logins` },
    { value: fmt(t.spins), label: 'Total spins', sub: `${fmt(t.taskEdits)} task edits` },
    { value: fmt(t.completions), label: 'Completions', sub: `${fmt(t.fails)} skipped/failed` },
    { value: rate, label: 'Success rate', sub: 'completed vs. skipped' },
  ];
  $('#stat-grid').innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="value">${escapeHtml(c.value)}</div>
      <div class="label">${escapeHtml(c.label)}</div>
      <div class="sub">${escapeHtml(c.sub)}</div>
    </div>`).join('');
}

// Vertical bar chart over the fixed 30-day axis.
function renderSeries(containerId, rows, className) {
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const days = last30Days();
  const values = days.map((d) => byDay[d] || 0);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);

  const el = $(containerId);
  if (total === 0) {
    el.innerHTML = '<div class="chart-empty">No data yet.</div>';
    return;
  }
  const bars = days.map((d, i) => {
    const h = values[i] === 0 ? 2 : Math.max(3, Math.round((values[i] / max) * 130));
    return `<div class="bar ${className}" style="height:${h}px" title="${d}: ${values[i]}"></div>`;
  }).join('');
  el.innerHTML = `<div class="chart">${bars}</div>
    <div class="chart-axis"><span>${days[0]}</span><span>peak ${max}</span><span>${days[days.length - 1]}</span></div>`;
}

// Horizontal bars — how often each time-chunk length was spun.
function renderChunks(rows) {
  const el = $('#chart-chunks');
  const sorted = [...rows].filter((r) => r.minutes != null).sort((a, b) => a.minutes - b.minutes);
  const total = sorted.reduce((a, r) => a + r.n, 0);
  if (total === 0) {
    el.innerHTML = '<div class="chart-empty">No spins recorded yet.</div>';
    return;
  }
  const max = Math.max(...sorted.map((r) => r.n));
  const label = (m) => (m % 60 === 0 && m >= 60 ? `${m / 60} hr` : `${m} min`);
  el.innerHTML = `<div class="hbars">${sorted.map((r) => `
    <div class="hbar">
      <span class="hbar-label">${escapeHtml(label(r.minutes))}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(3, Math.round((r.n / max) * 100))}%"></span></span>
      <span class="hbar-val">${fmt(r.n)}</span>
    </div>`).join('')}</div>`;
}

function renderUsers(users) {
  const table = $('#users-table');
  if (!users.length) {
    table.innerHTML = '<tr><td class="dim">No users yet.</td></tr>';
    return;
  }
  const head = `<tr>
    <th>Email</th><th>Joined</th><th>Last active</th>
    <th class="num">Visits</th><th class="num">Spins</th>
    <th class="num">Done</th><th class="num">Sessions</th><th class="num">Tasks</th>
  </tr>`;
  const rows = users.map((u) => `<tr>
    <td class="email">${escapeHtml(u.email)}</td>
    <td class="dim">${escapeHtml(u.joined || '—')}</td>
    <td class="dim">${escapeHtml(u.last_active || '—')}</td>
    <td class="num">${fmt(u.visits)}</td>
    <td class="num">${fmt(u.spins)}</td>
    <td class="num">${fmt(u.completions)}</td>
    <td class="num">${fmt(u.sessions)}</td>
    <td class="num">${fmt(u.tasks)}</td>
  </tr>`).join('');
  table.innerHTML = head + rows;
}

async function load() {
  $('#loading').classList.remove('hidden');
  $('#gate').classList.add('hidden');
  try {
    const res = await fetch('/api/admin', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      $('#loading').classList.add('hidden');
      $('#dash').classList.add('hidden');
      $('#gate').classList.remove('hidden');
      return;
    }
    const data = await res.json();
    renderStats(data.totals);
    renderSeries('#chart-dau', data.dauByDay, 'dau');
    renderSeries('#chart-spins', data.spinsByDay, '');
    renderSeries('#chart-signups', data.signupsByDay, 'signup');
    renderChunks(data.chunkDist);
    renderUsers(data.users);

    const now = new Date();
    $('#updated').textContent = `Updated ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    $('#loading').classList.add('hidden');
    $('#dash').classList.remove('hidden');
  } catch {
    // Network/backend unreachable (e.g. local dev has no /api/admin) — treat as
    // not-authorized rather than leaving a spinner.
    $('#loading').classList.add('hidden');
    $('#dash').classList.add('hidden');
    $('#gate').classList.remove('hidden');
  }
}

$('#refresh').onclick = load;
load();
