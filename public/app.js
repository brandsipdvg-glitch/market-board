const cards = {};
for (const root of document.querySelectorAll('.card')) {
  cards[root.dataset.site] = {
    root,
    value: root.querySelector('[data-value]'),
    delta: root.querySelector('[data-delta]'),
    pct: root.querySelector('[data-pct]'),
    stats: root.querySelector('[data-stats]'),
    sourceTime: root.querySelector('[data-source-time]'),
    updated: root.querySelector('[data-updated]'),
    status: root.querySelector('[data-status]'),
    error: root.querySelector('[data-error]'),
    svg: root.querySelector('[data-spark]'),
    line: root.querySelector('[data-line]'),
    area: root.querySelector('[data-area]'),
    lastValue: null,
  };
}

const clockEl = document.getElementById('clock');
const feedState = document.getElementById('feedState');
const feedText = document.getElementById('feedText');
const lastSync = document.getElementById('lastSync');
const intervalGroup = document.getElementById('intervalGroup');
const refreshBtn = document.getElementById('refreshNow');
const chartBody = document.querySelector('.chart-body');
const chartPaths = {
  sgx: document.getElementById('chart-sgx'),
  nse: document.getElementById('chart-nse'),
  vix: document.getElementById('chart-vix'),
};

let latest = null;
let streamOpen = false;

const istTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(ts) {
  if (!ts) return 'Waiting…';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function formatInterval(ms) {
  if (!ms) return 'off';
  return ms < 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 1000) + 's';
}

function syncIntervalButtons(ms) {
  for (const b of intervalGroup.querySelectorAll('button[data-ms]')) {
    b.classList.toggle('active', Number(b.dataset.ms) === ms);
  }
}

function renderSpark(points, direction) {
  const card = arguments[2];
  if (!points || !points.length) {
    card.line.setAttribute('d', '');
    card.area.setAttribute('d', '');
    return;
  }
  const vals = points.map((p) => Number(p[1])).filter(Number.isFinite);
  if (!vals.length) return;
  if (vals.length === 1) {
    card.line.setAttribute('d', 'M0 40 L300 40');
    card.area.setAttribute('d', 'M0 40 L300 40 L300 70 L0 70 Z');
    card.svg.classList.remove('up', 'down', 'flat');
    card.svg.classList.add('flat');
    return;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = 300 / (vals.length - 1);
  const coords = vals.map((v, i) => [i * step, 62 - ((v - min) / range) * 54]);
  const line = coords.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  card.line.setAttribute('d', line);
  card.area.setAttribute('d', line + ' L300 70 L0 70 Z');

  let dir = direction;
  if (dir === 'flat') dir = vals[vals.length - 1] >= vals[0] ? 'up' : 'down';
  card.svg.classList.remove('up', 'down', 'flat');
  card.svg.classList.add(dir);
}

function renderCombined(state) {
  const series = {};
  let maxAbs = 0;

  for (const [id, path] of Object.entries(chartPaths)) {
    const spark = state.sites?.[id]?.spark || [];
    const vals = spark.map((p) => Number(p[1])).filter(Number.isFinite);
    if (!vals.length) {
      path.setAttribute('d', '');
      continue;
    }
    const base = vals[0] || 1;
    const pcts = vals.map((v) => (v / base - 1) * 100);
    maxAbs = Math.max(maxAbs, ...pcts.map((p) => Math.abs(p)));
    series[id] = pcts;
  }

  const scale = Math.max(maxAbs, 0.05);
  for (const [id, pcts] of Object.entries(series)) {
    const coords = pcts.map((p, i) => [
      pcts.length === 1 ? 0 : (i / (pcts.length - 1)) * 900,
      110 - (p / scale) * 80,
    ]);
    if (coords.length === 1) coords.push([900, coords[0][1]]);
    chartPaths[id].setAttribute(
      'd',
      coords.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ')
    );
  }

  chartBody.classList.toggle('has-data', Object.keys(series).length > 0);
}

function applyState(state) {
  if (!state) return;
  latest = state;
  const pollMs = Number(state.pollMs) || 0;

  for (const [id, ui] of Object.entries(cards)) {
    const data = state.sites?.[id];
    if (!data) continue;

    const value = data.value || '—';
    if (ui.lastValue !== null && value !== ui.lastValue && !data.error) {
      ui.value.classList.remove('flash-up', 'flash-down');
      void ui.value.offsetWidth;
      ui.value.classList.add(data.direction === 'down' ? 'flash-down' : 'flash-up');
    }
    ui.lastValue = value;
    ui.value.textContent = value;

    const dir = data.direction || 'flat';
    ui.delta.textContent = data.change || '—';
    ui.delta.className = 'delta ' + (dir === 'up' ? 'up' : dir === 'down' ? 'down' : '');
    ui.pct.textContent = data.changePercent || '—';
    ui.pct.className = 'pct ' + (dir === 'up' ? 'up' : dir === 'down' ? 'down' : '');

    const stats = Array.isArray(data.stats) ? data.stats : [];
    ui.stats.innerHTML = stats.slice(0, 8).map((s) =>
      '<div class="stat"><span class="stat-label">' + escapeHTML(s.label) + '</span>' +
      '<span class="stat-value">' + escapeHTML(s.value) + '</span></div>'
    ).join('');

    ui.sourceTime.textContent = data.sourceTime ? 'Source: ' + data.sourceTime : 'Source time —';
    renderSpark(data.spark, dir, ui);

    if (data.error) {
      ui.error.hidden = false;
      ui.error.textContent = 'Feed issue: ' + data.error + '. Retrying automatically.';
    } else {
      ui.error.hidden = true;
    }
  }

  renderCombined(state);
  updateMeta();
}

function updateMeta() {
  const pollMs = Number(latest?.pollMs) || 0;
  const now = Date.now();
  clockEl.textContent = istTime.format(now);
  syncIntervalButtons(pollMs);

  let freshCount = 0;
  let errorCount = 0;
  for (const [id, ui] of Object.entries(cards)) {
    const data = latest?.sites?.[id];
    if (!data) continue;
    ui.updated.textContent = relativeTime(data.updatedAt);
    const age = now - (data.updatedAt || 0);
    const staleAfter = Math.max(15000, pollMs * 3);
    let cls = 'fresh';
    if (data.error) { cls = 'error'; errorCount += 1; }
    else if (pollMs === 0 || age > staleAfter) cls = 'stale';
    else freshCount += 1;
    ui.status.className = 'status-dot ' + cls;
    ui.status.title = cls === 'error' ? 'Feed error' : cls === 'stale' ? 'Waiting for update' : 'Live';
  }

  if (!streamOpen) {
    feedState.className = 'feed-state offline';
    feedText.textContent = 'Reconnecting…';
  } else if (pollMs === 0) {
    feedState.className = 'feed-state';
    feedText.textContent = 'Auto refresh off';
  } else if (errorCount > 0 && freshCount === 0) {
    feedState.className = 'feed-state offline';
    feedText.textContent = 'Source issue';
  } else {
    feedState.className = 'feed-state live';
    feedText.textContent = pollMs <= 500
      ? 'Live · instant updates'
      : 'Live · ' + formatInterval(pollMs) + ' refresh';
  }

  if (latest?.ts) {
    const t = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(latest.ts);
    lastSync.textContent = 'Last sync ' + t + ' IST · every ' + formatInterval(pollMs) +
      (pollMs <= 500 ? ' (instant on change)' : '');
  }
}

const stream = new EventSource('/api/feed');
stream.onopen = () => { streamOpen = true; updateMeta(); };
stream.onerror = () => { streamOpen = false; updateMeta(); };
stream.addEventListener('ready', (e) => applyState(JSON.parse(e.data)));
stream.addEventListener('update', (e) => applyState(JSON.parse(e.data)));
stream.addEventListener('interval', (e) => applyState(JSON.parse(e.data)));

fetch('/api/latest')
  .then((r) => r.json())
  .then(applyState)
  .catch(() => {});

intervalGroup.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-ms]');
  if (!btn) return;
  const ms = Number(btn.dataset.ms);
  for (const b of intervalGroup.querySelectorAll('button')) b.classList.toggle('active', b === btn);
  try {
    const res = await fetch('/api/interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms }),
    });
    const body = await res.json();
    if (latest) { latest.pollMs = body.pollMs; updateMeta(); }
  } catch {}
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  try { await fetch('/api/refresh', { method: 'POST' }); } catch {}
  setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
});

setInterval(updateMeta, 1000);
updateMeta();
