'use strict';

// Initial watchlist: the stocks from the original request.
const DEFAULT_STOCKS = [
  ['NVDA', 'NVIDIA'],
  ['ASML', 'ASML Holding'],
  ['AMD', 'Advanced Micro Devices'],
  ['INTC', 'Intel'],
  ['ORCL', 'Oracle'],
  ['FSLR', 'First Solar'],
  ['ENPH', 'Enphase Energy'],
  ['JKS', 'JinkoSolar'],
  ['SHLS', 'Shoals Technologies'],
  ['PLUG', 'Plug Power'],
  ['ONON', 'On Holding'],
  ['IONQ', 'IonQ'],
  ['QBTS', 'D-Wave Quantum'],
  ['RGTI', 'Rigetti Computing'],
];

const API = 'https://finnhub.io/api/v1';
const WS_URL = 'wss://ws.finnhub.io';
const QUOTE_REFRESH_MS = 60_000;
const MARKET_REFRESH_MS = 5 * 60_000;
const SPARK_MAX_POINTS = 240;
const SPARK_MIN_GAP_MS = 5_000;

// ---------- storage (may be unavailable in private mode) ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('sw.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sw.' + key, JSON.stringify(value)); } catch {}
  },
};

function loadSession(key, fallback) {
  try {
    const raw = sessionStorage.getItem('sw.' + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function saveSession(key, value) {
  try { sessionStorage.setItem('sw.' + key, JSON.stringify(value)); } catch {}
}

// ---------- state ----------

const state = {
  apiKey: store.get('apiKey', ''),
  lang: I18N[store.get('lang')] ? store.get('lang') : detectLang(),
  sort: store.get('sort', 'manual'),
  symbols: store.get('symbols', DEFAULT_STOCKS.map(([s]) => s)),
  profiles: store.get('profiles', Object.fromEntries(DEFAULT_STOCKS.map(([s, name]) => [s, { name }]))),
  quotes: {},        // symbol -> { c, d, dp, h, l, o, pc, t }
  ticks: loadSession('ticks', {}), // symbol -> [[t, price], ...] for the sparkline
  cards: new Map(),  // symbol -> card element
  ws: null,
  wsRetry: 0,
  lastUpdate: 0,
};

function detectLang() {
  const nav = (navigator.language || 'en').slice(0, 2);
  return I18N[nav] ? nav : 'en';
}

function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', v);
  return s;
}

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- API ----------

class ApiError extends Error {
  constructor(status) { super('HTTP ' + status); this.status = status; }
}

// Finnhub's free tier allows 60 requests/minute; space calls out a little.
let apiChain = Promise.resolve();
function api(path, params = {}) {
  const run = async () => {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('token', state.apiKey);
    let res = await fetch(url);
    if (res.status === 429) {
      await sleep(2_000);
      res = await fetch(url);
    }
    if (!res.ok) throw new ApiError(res.status);
    return res.json();
  };
  const p = apiChain.then(run);
  apiChain = p.catch(() => {}).then(() => sleep(120));
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleApiError(err) {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    toast(t('badKey'));
    setConn('offline');
  } else if (err instanceof ApiError && err.status === 429) {
    toast(t('rateLimit'));
  } else {
    console.warn(err);
  }
}

async function fetchQuote(symbol) {
  const q = await api('/quote', { symbol });
  // Finnhub answers unknown symbols with all zeros.
  if (!q || (!q.c && !q.pc)) return null;
  return q;
}

async function fetchProfile(symbol) {
  try {
    const p = await api('/stock/profile2', { symbol });
    const prev = state.profiles[symbol] || {};
    state.profiles[symbol] = p && p.name
      ? { name: p.name, logo: p.logo || '', currency: p.currency || 'USD', fetched: true }
      : { ...prev, fetched: true };
    store.set('profiles', state.profiles);
    renderCard(symbol);
  } catch (err) { handleApiError(err); }
}

async function refreshQuotes() {
  for (const symbol of [...state.symbols]) {
    try {
      const q = await fetchQuote(symbol);
      if (q && state.symbols.includes(symbol)) {
        state.quotes[symbol] = { ...q };
        pushTick(symbol, q.c, q.t ? q.t * 1000 : Date.now());
        renderCard(symbol);
        markUpdated();
      }
    } catch (err) {
      handleApiError(err);
      if (err.status === 401 || err.status === 403) return;
    }
  }
  if (state.sort !== 'manual') applySort();
}

async function refreshMarketStatus() {
  try {
    const m = await api('/stock/market-status', { exchange: 'US' });
    const el = $('#market-status');
    let key = 'marketClosed', cls = 'closed';
    if (m.session === 'pre-market') { key = 'marketPre'; cls = 'ext'; }
    else if (m.session === 'post-market') { key = 'marketPost'; cls = 'ext'; }
    else if (m.isOpen) { key = 'marketOpen'; cls = 'open'; }
    el.dataset.key = key;
    el.className = 'pill market ' + cls;
    el.textContent = t(key);
    el.hidden = false;
  } catch (err) { handleApiError(err); }
}

// ---------- live trades over WebSocket ----------

function connectWs() {
  if (!state.apiKey) return;
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  setConn('connecting');
  const ws = new WebSocket(WS_URL + '?token=' + encodeURIComponent(state.apiKey));
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 0;
    setConn('live');
    state.symbols.forEach(subscribe);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
    // Keep only the latest trade per symbol from this batch.
    const latest = {};
    for (const tr of msg.data) {
      if (!latest[tr.s] || tr.t >= latest[tr.s].t) latest[tr.s] = tr;
    }
    for (const tr of Object.values(latest)) applyTrade(tr.s, tr.p, tr.t);
  };
  ws.onclose = () => {
    setConn('offline');
    const delay = Math.min(30_000, 1_000 * 2 ** state.wsRetry++);
    setTimeout(() => { if (state.ws === ws) connectWs(); }, delay);
  };
  ws.onerror = () => ws.close();
}

function subscribe(symbol) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
  }
}
function unsubscribe(symbol) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'unsubscribe', symbol }));
  }
}

function applyTrade(symbol, price, time) {
  const q = state.quotes[symbol];
  if (!q || !state.symbols.includes(symbol)) return;
  const prev = q.c;
  q.c = price;
  if (q.pc) {
    q.d = price - q.pc;
    q.dp = (q.d / q.pc) * 100;
  }
  if (q.h && price > q.h) q.h = price;
  if (q.l && price < q.l) q.l = price;
  pushTick(symbol, price, time);
  renderCard(symbol, price > prev ? 'up' : price < prev ? 'down' : null);
  markUpdated();
}

function pushTick(symbol, price, time) {
  if (!price) return;
  const arr = state.ticks[symbol] || (state.ticks[symbol] = []);
  const last = arr[arr.length - 1];
  if (last && time - last[0] < SPARK_MIN_GAP_MS) last[1] = price;
  else arr.push([time, price]);
  if (arr.length > SPARK_MAX_POINTS) arr.splice(0, arr.length - SPARK_MAX_POINTS);
  scheduleTickSave();
}

let tickSaveTimer = 0;
function scheduleTickSave() {
  if (tickSaveTimer) return;
  tickSaveTimer = setTimeout(() => { tickSaveTimer = 0; saveSession('ticks', state.ticks); }, 3_000);
}

// ---------- rendering ----------

function fmtPrice(value, currency = 'USD') {
  if (value == null || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat(LOCALES[state.lang], {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function fmtSigned(value, digits = 2) {
  const s = Math.abs(value).toLocaleString(LOCALES[state.lang], { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (value > 0 ? '+' : value < 0 ? '−' : '') + s;
}

function createCard(symbol) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.symbol = symbol;
  $('.remove', node).addEventListener('click', () => removeSymbol(symbol));
  translate(node);
  state.cards.set(symbol, node);
  return node;
}

function renderCard(symbol, flash) {
  const card = state.cards.get(symbol);
  if (!card) return;
  const profile = state.profiles[symbol] || {};
  const q = state.quotes[symbol];
  const cur = profile.currency || 'USD';

  $('.symbol', card).textContent = symbol;
  $('.name', card).textContent = profile.name || '';
  $('.remove', card).title = t('remove');
  $('.remove', card).setAttribute('aria-label', t('remove') + ' ' + symbol);

  const logo = $('.logo', card);
  if (profile.logo && !logo.querySelector('img')) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = profile.logo;
    img.onerror = () => { img.remove(); logo.textContent = symbol[0]; };
    logo.textContent = '';
    logo.append(img);
  } else if (!profile.logo && !logo.textContent) {
    logo.textContent = symbol[0];
  }

  if (!q) return;

  $('.price', card).textContent = fmtPrice(q.c, cur);
  const change = $('.change', card);
  change.textContent = `${fmtSigned(q.d ?? 0)} (${fmtSigned(q.dp ?? 0)}%)`;
  const dir = (q.d ?? 0) > 0 ? 'up' : (q.d ?? 0) < 0 ? 'down' : 'flat';
  card.dataset.dir = dir;

  $('.open', card).textContent = fmtPrice(q.o, cur);
  $('.pc', card).textContent = fmtPrice(q.pc, cur);
  $('.low', card).textContent = fmtPrice(q.l, cur);
  $('.high', card).textContent = fmtPrice(q.h, cur);
  const span = q.h - q.l;
  const pos = span > 0 ? ((q.c - q.l) / span) * 100 : 50;
  $('.range-mark', card).style.left =Math.max(0, Math.min(100, pos)) + '%';

  renderSpark(card, symbol, q);

  if (flash) {
    card.classList.remove('flash-up', 'flash-down');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash-' + flash);
  }
}

function renderSpark(card, symbol, q) {
  const pts = state.ticks[symbol] || [];
  const svg = $('.spark', card);
  const line = $('.line', svg);
  const base = $('.base', svg);
  if (pts.length < 2) {
    line.setAttribute('points', '');
    base.style.display = 'none';
    return;
  }
  const prices = pts.map((p) => p[1]);
  let min = Math.min(...prices, q.pc || Infinity);
  let max = Math.max(...prices, q.pc || -Infinity);
  if (max === min) { max += 1; min -= 1; }
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const tspan = t1 - t0 || 1;
  const y = (v) => (30 - ((v - min) / (max - min)) * 28).toFixed(2);
  line.setAttribute('points', pts.map(([tt, v]) => `${(((tt - t0) / tspan) * 100).toFixed(2)},${y(v)}`).join(' '));
  if (q.pc) {
    base.style.display = '';
    base.setAttribute('y1', y(q.pc));
    base.setAttribute('y2', y(q.pc));
  }
}

function renderAll() {
  const grid = $('#grid');
  for (const symbol of state.symbols) {
    if (!state.cards.has(symbol)) grid.append(createCard(symbol));
    renderCard(symbol);
  }
  applySort();
  $('#empty').hidden = state.symbols.length > 0;
}

function applySort() {
  const grid = $('#grid');
  const list = [...state.symbols];
  const dp = (s) => state.quotes[s]?.dp ?? 0;
  if (state.sort === 'change-desc') list.sort((a, b) => dp(b) - dp(a));
  else if (state.sort === 'change-asc') list.sort((a, b) => dp(a) - dp(b));
  else if (state.sort === 'symbol') list.sort((a, b) => a.localeCompare(b));
  list.forEach((s) => grid.append(state.cards.get(s)));
}

function markUpdated() {
  state.lastUpdate = Date.now();
  renderUpdated();
}
function renderUpdated() {
  if (!state.lastUpdate) return;
  const time = new Date(state.lastUpdate).toLocaleTimeString(LOCALES[state.lang]);
  $('#updated').textContent = `${t('updated')}: ${time}`;
}

function setConn(kind) {
  const el = $('#conn-status');
  el.dataset.kind = kind;
  $('.label', el).textContent = t(kind);
}

function translate(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'he' ? 'rtl' : 'ltr';
  document.title = t('title');
  $('#lang').value = state.lang;
  translate();
  const ms = $('#market-status');
  if (ms.dataset.key) ms.textContent = t(ms.dataset.key);
  const conn = $('#conn-status').dataset.kind;
  if (conn) setConn(conn);
  state.symbols.forEach((s) => renderCard(s));
  renderUpdated();
}

// ---------- toast ----------

let toastTimer = 0;
function toast(message, undo) {
  const el = $('#toast');
  $('.msg', el).textContent = message;
  const btn = $('.undo', el);
  btn.hidden = !undo;
  btn.textContent = t('undo');
  btn.onclick = undo ? () => { undo(); el.hidden = true; } : null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6_000 : 3_500);
}

// ---------- add / remove ----------

function saveSymbols() { store.set('symbols', state.symbols); }

async function addSymbol(raw, name) {
  const symbol = raw.trim().toUpperCase();
  if (!symbol) return;
  if (state.symbols.includes(symbol)) { toast(t('exists', { s: symbol })); return; }
  let q;
  try { q = await fetchQuote(symbol); } catch (err) { handleApiError(err); return; }
  if (!q) { toast(t('notFound', { s: symbol })); return; }
  insertSymbol(symbol, state.symbols.length, q, name);
  toast(t('added', { s: symbol }));
  if (!state.profiles[symbol]?.fetched) fetchProfile(symbol);
}

function insertSymbol(symbol, index, quote, name) {
  state.symbols.splice(index, 0, symbol);
  saveSymbols();
  if (name && !state.profiles[symbol]) state.profiles[symbol] = { name };
  if (quote) {
    state.quotes[symbol] = { ...quote };
    pushTick(symbol, quote.c, quote.t ? quote.t * 1000 : Date.now());
  }
  const card = createCard(symbol);
  $('#grid').append(card);
  renderCard(symbol);
  applySort();
  subscribe(symbol);
  $('#empty').hidden = true;
}

function removeSymbol(symbol) {
  const index = state.symbols.indexOf(symbol);
  if (index < 0) return;
  const quote = state.quotes[symbol];
  state.symbols.splice(index, 1);
  saveSymbols();
  unsubscribe(symbol);
  state.cards.get(symbol)?.remove();
  state.cards.delete(symbol);
  delete state.quotes[symbol];
  $('#empty').hidden = state.symbols.length > 0;
  toast(t('removed', { s: symbol }), () => {
    if (!state.symbols.includes(symbol)) insertSymbol(symbol, Math.min(index, state.symbols.length), quote);
  });
}

// ---------- search suggestions ----------

let searchTimer = 0;
let searchSeq = 0;
let activeIndex = -1;

function setupSearch() {
  const input = $('#add-input');
  const list = $('#suggestions');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 1) { hideSuggestions(); return; }
    searchTimer = setTimeout(() => runSearch(q), 300);
  });

  input.addEventListener('keydown', (e) => {
    const items = [...list.children];
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', i === activeIndex));
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const items = [...list.children];
    const picked = !list.hidden && activeIndex >= 0 ? items[activeIndex] : null;
    const symbol = picked ? picked.dataset.symbol : input.value;
    const name = picked ? picked.dataset.name : undefined;
    input.value = '';
    hideSuggestions();
    addSymbol(symbol, name);
  });
}

async function runSearch(q) {
  const seq = ++searchSeq;
  let res;
  try { res = await api('/search', { q, exchange: 'US' }); } catch (err) { handleApiError(err); return; }
  if (seq !== searchSeq) return;
  const items = (res.result || [])
    .filter((r) => r.symbol && !r.symbol.includes('.'))
    .slice(0, 8);
  const list = $('#suggestions');
  list.replaceChildren();
  activeIndex = -1;
  for (const r of items) {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.symbol = r.symbol;
    li.dataset.name = r.description || '';
    const sym = document.createElement('strong');
    sym.textContent = r.displaySymbol || r.symbol;
    const desc = document.createElement('span');
    desc.className = 'muted';
    desc.textContent = r.description || '';
    li.append(sym, desc);
    if (state.symbols.includes(r.symbol)) li.classList.add('in-list');
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('#add-input').value = '';
      hideSuggestions();
      addSymbol(r.symbol, r.description);
    });
    list.append(li);
  }
  list.hidden = items.length === 0;
}

function hideSuggestions() {
  $('#suggestions').hidden = true;
  activeIndex = -1;
}

// ---------- settings ----------

function setupSettings() {
  const dlg = $('#settings');
  $('#open-settings').addEventListener('click', () => {
    $('#settings-key').value = state.apiKey;
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const key = $('#settings-key').value.trim();
    if (key && key !== state.apiKey) setApiKey(key);
  });
  $('#reset-list').addEventListener('click', () => {
    if (!confirm(t('resetConfirm'))) return;
    state.symbols.forEach(unsubscribe);
    state.cards.forEach((c) => c.remove());
    state.cards.clear();
    state.quotes = {};
    state.symbols = DEFAULT_STOCKS.map(([s]) => s);
    for (const [s, name] of DEFAULT_STOCKS) if (!state.profiles[s]) state.profiles[s] = { name };
    saveSymbols();
    dlg.close('cancel');
    renderAll();
    state.symbols.forEach(subscribe);
    refreshQuotes();
  });

  $('#setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#setup-key').value.trim();
    if (key) setApiKey(key);
  });

  $('#lang').addEventListener('change', (e) => {
    state.lang = e.target.value;
    store.set('lang', state.lang);
    applyLang();
  });

  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    store.set('sort', state.sort);
    applySort();
  });
}

function setApiKey(key) {
  state.apiKey = key;
  store.set('apiKey', key);
  start();
}

// ---------- boot ----------

let timers = [];
function start() {
  timers.forEach(clearInterval);
  timers = [];
  const hasKey = Boolean(state.apiKey);
  $('#setup').hidden = hasKey;
  $('#app').hidden = !hasKey;
  $('#conn-status').hidden = !hasKey;
  if (!hasKey) return;

  renderAll();
  connectWs();
  refreshMarketStatus();
  refreshQuotes().then(() => {
    // Fetch logos for anything we haven't seen yet, after the quotes.
    state.symbols.filter((s) => !state.profiles[s]?.fetched).forEach(fetchProfile);
  });
  timers.push(setInterval(refreshQuotes, QUOTE_REFRESH_MS));
  timers.push(setInterval(refreshMarketStatus, MARKET_REFRESH_MS));
}

document.addEventListener('visibilitychange', () => {
  // Browsers throttle background tabs; catch up when the tab comes back.
  if (document.visibilityState === 'visible' && state.apiKey && Date.now() - state.lastUpdate > 30_000) {
    refreshQuotes();
    if (!state.ws || state.ws.readyState > WebSocket.OPEN) connectWs();
  }
});

setupSettings();
setupSearch();
applyLang();
start();
