import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
let pollMs = Math.min(60000, Math.max(250, Number(process.env.POLL_MS || 500)));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// These functions run inside each source page and read the values the page displays.
const EXTRACTORS = {
  sgx: () => {
    const card = document.querySelector('#c-hero');
    if (!card) return null;
    const text = (sel) => card.querySelector(sel)?.textContent?.trim() || '';
    const value = text('.hero-px');
    const changeText = [...card.querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .find((t) => /^[▲▼]/.test(t)) || '';
    const pct = text('.pill');
    const stats = [];
    card.querySelectorAll('small').forEach((s) => {
      const label = s.textContent.trim();
      const v = s.nextElementSibling?.textContent?.trim();
      if (label && v) stats.push({ label, value: v });
    });
    return {
      value,
      change: changeText,
      changePercent: pct,
      direction: changeText.startsWith('▼') ? 'down' : changeText.startsWith('▲') ? 'up' : 'flat',
      stats: stats.slice(0, 4),
      sourceTime: '',
    };
  },

  nse: () => {
    const scope = document.querySelector('main') || document;
    const value = scope.querySelector('.index-value')?.textContent?.trim() || '';
    const changeEl = scope.querySelector('.index-pchange');
    const change = changeEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const stats = [...scope.querySelectorAll('.index-item')].slice(0, 10).map((it) => ({
      label: it.querySelector('.index-label')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      value: it.querySelector('.index-val')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }));
    const match = (document.body.innerText || '').match(/As on\s+([^\n]+)/i);
    const negative = /(^|\s)[-−]/.test(change.trim()) || /red_color|red_txt|decline/i.test(changeEl?.className || '');
    const pctMatch = change.match(/([-−]?[\d.]+)\s*%/);
    const pct = pctMatch ? pctMatch[1].replace('−', '-') : '';
    return {
      value,
      change,
      changePercent: pct ? (pct.startsWith('-') ? pct : '+' + pct) + '%' : '',
      direction: negative ? 'down' : 'up',
      stats,
      sourceTime: match ? match[1].trim() : '',
    };
  },

  vix: () => {
    const box = document.querySelector('.stickymcont');
    if (!box) return null;
    const value = box.querySelector('.pcstkspr')?.textContent?.trim() || '';
    const chgEl = box.querySelector('#stick_ch_prch');
    const change = chgEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const negative = /red|decline|down/i.test(chgEl?.className || '') || change.trim().startsWith('-');
    const pctMatch = change.match(/\(([-−]?[^)]*%)\)/);
    const pct = pctMatch ? pctMatch[1].replace('−', '-') : '';
    const stats = [];
    const byId = (id) => document.getElementById(id)?.textContent?.trim() || '';
    const low = byId('sp_low');
    const high = byId('sp_high');
    const yearLow = byId('sp_yearlylow');
    const yearHigh = byId('sp_yearlyhigh');
    const ytd = byId('ytd');
    if (low || high) stats.push({ label: 'Day range', value: low + ' – ' + high });
    if (yearLow || yearHigh) stats.push({ label: '52W range', value: yearLow + ' – ' + yearHigh });
    if (ytd) stats.push({ label: 'YTD return', value: ytd });
    return {
      value,
      change,
      changePercent: pct ? (pct.startsWith('-') ? pct : '+' + pct) : '' ,
      direction: negative ? 'down' : 'up',
      stats,
      sourceTime: '',
    };
  },
};

const SITES = [
  { id: 'sgx', name: 'SGX Nifty', host: 'sgxnifty.org', url: 'https://sgxnifty.org/?shem=aimgspe', selector: '.hero-px', watch: '#c-hero' },
  { id: 'nse', name: 'NIFTY 50', host: 'nseindia.in', url: 'https://www.nseindia.in/index-tracker/NIFTY%2050', selector: '.index-value', watch: 'main' },
  { id: 'vix', name: 'India VIX', host: 'moneycontrol.com', url: 'https://www.moneycontrol.com/indian-indices/india-vix-36.html?shem=aimgspe', selector: '.pcstkspr', watch: '.stickymcont' },
];

const state = { sites: {}, ts: 0, pollMs };
const history = { sgx: [], nse: [], vix: [] };
const clients = new Set();
const pages = {};
const reading = new Set();
let browser = null;
let pollBusy = false;
let timer = null;

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {}
  const candidates = [
    '/Users/sukshemk/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) || undefined;
}

async function dismissOverlays(page) {
  for (const label of ['No thanks', 'Maybe later', 'I Accept']) {
    try {
      await page.getByText(label, { exact: false }).first().click({ timeout: 900 });
    } catch {}
  }
}

async function openSite(site) {
  if (!browser) throw new Error('Browser is not ready');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: UA,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = await context.newPage();

  // Keep resource use low enough for small free cloud instances. Ads, images,
  // fonts and trackers are noise for quote extraction and consume most of the RAM.
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
    if (/doubleclick|googlesyndication|googletagmanager|google-analytics|primis|adnxs|pubmatic|openx|casalemedia|adtrafficquality|turnstile|recaptcha|scorecardresearch|amazon-adsystem/i.test(url)) return route.abort();
    return route.continue();
  });

  // The source page calls this as soon as its quote changes.
  await page.exposeBinding('__marketBoardChanged', () => { readSite(site); });

  const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!response?.ok()) throw new Error('HTTP ' + (response?.status() || 'unknown'));
  await page.waitForSelector(site.selector, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await dismissOverlays(page);

  // Watch only the quote area so ad/chart noise does not trigger reads.
  await page.evaluate((watch) => {
    const target = document.querySelector(watch) || document.body;
    let timer = null;
    let last = 0;
    const notify = () => {
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => window.__marketBoardChanged?.(), 40);
    };
    const observer = new MutationObserver(notify);
    observer.observe(target, { subtree: true, childList: true, characterData: true });
    window.__marketBoardObserver = observer;
  }, site.watch);

  // Several sources pause their own live feed when a visitor is idle (SGX Nifty
  // stops after 10 minutes with no input). Keep a harmless activity signal going
  // so the source page refreshes itself, then our observer pushes the change.
  const keepAlive = setInterval(() => {
    page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
    }).catch(() => {});
  }, 30000);

  pages[site.id] = { page, context, fails: 0, keepAlive };
}

async function boot() {
  try {
    browser = await chromium.launch({
      executablePath: findChrome(),
      headless: true,
      args: [
        '--disable-http2',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    await Promise.allSettled(SITES.map((site) => openSite(site).catch((err) => {
      console.error('[' + site.id + '] initial load failed:', err.message);
    })));
  } catch (err) {
    console.error('Browser launch failed:', err.message);
  }
}

function publicState() {
  return { sites: state.sites, ts: state.ts, pollMs };
}

function broadcast(event = 'update') {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// Small heartbeat keeps the "last sync" indicator fresh without re-rendering
// every card on every 0.5s check. Full updates are sent only when data changes.
function heartbeat() {
  const payload = 'event: heartbeat\ndata: ' + JSON.stringify({
    ts: state.ts || Date.now(),
    pollMs,
    updatedAt: Object.fromEntries(SITES.map((s) => [s.id, state.sites[s.id]?.updatedAt || 0])),
  }) + '\n\n';
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function signature(entry) {
  return [
    entry.value, entry.change, entry.changePercent, entry.direction,
    entry.error, entry.sourceTime, JSON.stringify(entry.stats || []),
  ].join('|');
}

async function readSite(site) {
  if (reading.has(site.id)) return;
  reading.add(site.id);
  try {
    if (!pages[site.id]) await openSite(site);
    const p = pages[site.id];
    let raw = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      raw = await p.page.evaluate(EXTRACTORS[site.id]);
      if (raw?.value) break;
      await p.page.waitForTimeout(200);
    }
    if (!raw?.value) throw new Error('Quote not found on source page');

    const numeric = Number(String(raw.value).replace(/[^0-9.-]/g, ''));
    const prev = state.sites[site.id];
    const entry = {
      id: site.id,
      name: site.name,
      host: site.host,
      url: site.url,
      value: raw.value,
      change: raw.change || '',
      changePercent: raw.changePercent || '',
      direction: raw.direction || 'flat',
      stats: raw.stats || [],
      sourceTime: raw.sourceTime || '',
      numeric,
      updatedAt: Date.now(),
      spark: [],
      previousValue: prev?.value || null,
      error: null,
    };
    state.sites[site.id] = entry;
    p.fails = 0;
    const h = history[site.id];
    if (Number.isFinite(numeric) && numeric > 0) {
      if (!h.length || h[h.length - 1][1] !== numeric) h.push([entry.updatedAt, numeric]);
      if (h.length > 120) h.shift();
    }
    entry.spark = h.slice();
    state.ts = Date.now();
    if (!prev || signature(prev) !== signature(entry)) broadcast('update');
  } catch (err) {
    const prev = state.sites[site.id];
    const p = pages[site.id];
    if (p) {
      p.fails += 1;
      if (p.fails >= 3) {
        clearInterval(p.keepAlive);
        try { await p.context.close(); } catch {}
        delete pages[site.id];
        p.fails = 0;
      }
    }
    const message = String(err?.message || err);
    state.sites[site.id] = {
      ...(prev || { id: site.id, name: site.name, host: site.host, url: site.url }),
      error: message,
      updatedAt: Date.now(),
      spark: history[site.id].slice(),
    };
    state.ts = Date.now();
    if (!prev || prev.error !== message) broadcast('update');
  } finally {
    reading.delete(site.id);
  }
}

async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  await Promise.all(SITES.map((site) => readSite(site)));
  pollBusy = false;
}

function schedulePoll() {
  if (timer) clearInterval(timer);
  if (pollMs > 0) timer = setInterval(poll, pollMs);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/feed') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: ready\ndata: ' + JSON.stringify(publicState()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(publicState()));
    return;
  }

  if (url.pathname === '/api/interval' && req.method === 'POST') {
    const body = await readBody(req);
    const ms = Number(body.ms);
    if (Number.isFinite(ms) && ms >= 250 && ms <= 60000) {
      pollMs = ms;
      state.pollMs = ms;
      schedulePoll();
      broadcast('interval');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pollMs }));
    return;
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    await poll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: state.ts }));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  await serveStatic(req, res, url.pathname);
});

let heartbeatTimer = null;

server.listen(PORT, () => {
  console.log('Market Board running at http://localhost:' + PORT + '  (auto-refresh every ' + pollMs / 1000 + 's; source changes pushed instantly)');
  boot().then(() => {
    poll();
    schedulePoll();
  });
  heartbeatTimer = setInterval(heartbeat, 1000);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    if (timer) clearInterval(timer);
    for (const p of Object.values(pages)) clearInterval(p.keepAlive);
    for (const res of clients) res.end();
    server.close();
    // A stuck browser close must never leave a zombie process behind.
    setTimeout(() => process.exit(0), 2000).unref();
    Promise.race([
      browser?.close() || Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).then(() => process.exit(0)).catch(() => process.exit(0));
  });
}
