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

// Public CNBC endpoints: no API key, CORS enabled, real-time for US stocks.
const QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const SEARCH_URL = 'https://symlookup.cnbc.com/symservice/symlookup.do';
const POLL_FAST_MS = 3_000;   // a market session is active
const POLL_SLOW_MS = 30_000;  // everything closed, or the window is hidden
const QUOTE_CHUNK = 25;
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
  lang: I18N[store.get('lang')] ? store.get('lang') : detectLang(),
  sort: store.get('sort', 'manual'),
  symbols: store.get('symbols', DEFAULT_STOCKS.map(([s]) => s)),
  names: store.get('names', Object.fromEntries(DEFAULT_STOCKS)),
  quotes: {},        // symbol -> parsed quote, see parseQuote()
  ticks: loadSession('ticks', {}), // symbol -> [[t, price], ...] for the sparkline
  cards: new Map(),  // symbol -> card element
  lastUpdate: 0,
  pollTimer: 0,
};

function detectLang() {
  return (navigator.language || 'en').slice(0, 2) === 'he' ? 'he' : 'en';
}

function t(key, vars) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', v);
  return s;
}

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- data ----------

// CNBC sends numbers as display strings: "1,677.96", "+2.35%".
function num(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[,%+\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseQuote(raw) {
  if (!raw || raw.code !== 0 || num(raw.last) == null) return null;
  // Tel Aviv prices arrive in agorot although labelled ILS.
  const scale = /-IL$/.test(raw.symbol) && raw.currencyCode === 'ILS' ? 0.01 : 1;
  const price = (s) => { const n = num(s); return n == null ? null : n * scale; };
  const q = {
    c: price(raw.last),
    d: price(raw.change) ?? 0,
    dp: num(raw.change_pct) ?? 0,
    o: price(raw.open),
    h: price(raw.high),
    l: price(raw.low),
    pc: price(raw.previous_day_closing),
    t: Date.parse(raw.last_time) || Date.now(),
    name: raw.name || raw.shortName || '',
    currency: raw.currencyCode || 'USD',
    realTime: raw.realTime === 'true',
    status: raw.curmktstatus || '',
    ext: null,
  };
  const ext = raw.ExtendedMktQuote;
  if (ext && (q.status === 'PRE_MKT' || q.status === 'POST_MKT') && num(ext.last) != null) {
    q.ext = { type: ext.type, c: price(ext.last), d: price(ext.change) ?? 0, dp: num(ext.change_pct) ?? 0 };
  }
  return q;
}

async function fetchQuotes(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += QUOTE_CHUNK) {
    const url = new URL(QUOTE_URL);
    url.search = new URLSearchParams({
      symbols: symbols.slice(i, i + QUOTE_CHUNK).join('|'),
      requestMethod: 'itv', noform: '1', partnerId: '2', fund: '1', exthrs: '1', output: 'json',
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let list = data?.FormattedQuoteResult?.FormattedQuote || [];
    if (!Array.isArray(list)) list = [list];
    for (const raw of list) if (raw && raw.symbol) out[raw.symbol] = parseQuote(raw);
  }
  return out;
}

async function refreshQuotes() {
  const symbols = [...state.symbols];
  if (!symbols.length) return;
  let quotes;
  try {
    quotes = await fetchQuotes(symbols);
  } catch (err) {
    console.warn(err);
    setConn('offline');
    return;
  }
  setConn('live');
  for (const symbol of symbols) {
    const q = quotes[symbol];
    if (!q || !state.symbols.includes(symbol)) continue;
    const prev = state.quotes[symbol];
    state.quotes[symbol] = q;
    if (q.name && state.names[symbol] !== q.name) {
      state.names[symbol] = q.name;
      store.set('names', state.names);
    }
    pushTick(symbol, q.ext ? q.ext.c : q.c, Date.now());
    const now = q.ext ? q.ext.c : q.c;
    const was = prev ? (prev.ext ? prev.ext.c : prev.c) : now;
    renderCard(symbol, now > was ? 'up' : now < was ? 'down' : null);
  }
  markUpdated();
  renderMarketStatus();
  if (state.sort !== 'manual') applySort();
}

// Poll quickly while any market we follow is trading, slowly otherwise.
async function pollLoop() {
  clearTimeout(state.pollTimer);
  await refreshQuotes();
  const active = Object.values(state.quotes).some((q) => q && q.status && q.status !== 'CLOSED' && q.status !== 'AFTER_MKT_CLOSED');
  const delay = document.visibilityState === 'visible' && active ? POLL_FAST_MS : POLL_SLOW_MS;
  state.pollTimer = setTimeout(pollLoop, delay);
}

async function searchSymbols(q) {
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({ prefix: q, partnerid: '20064', pgok: '1', pgsize: '10' });
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .filter((r) => r && r.symbolName && (r.issueType === 'STOCK' || r.issueType === 'ETF'))
    .map((r) => ({ symbol: r.symbolName, name: r.companyName || '', exchange: r.exchangeName || '' }));
}

function pushTick(symbol, price, time) {
  if (price == null) return;
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

const fmtChange = (d, dp) => `${fmtSigned(d)} (${fmtSigned(dp)}%)`;
const dirOf = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');

function createCard(symbol) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.symbol = symbol;
  $('.remove', node).addEventListener('click', () => removeSymbol(symbol));
  $('.logo', node).textContent = symbol.replace(/^\d+/, '')[0] || symbol[0];
  translate(node);
  state.cards.set(symbol, node);
  return node;
}

function renderCard(symbol, flash) {
  const card = state.cards.get(symbol);
  if (!card) return;
  const q = state.quotes[symbol];

  $('.symbol', card).textContent = symbol;
  $('.name', card).textContent = state.names[symbol] || '';
  $('.remove', card).title = t('remove');
  $('.remove', card).setAttribute('aria-label', t('remove') + ' ' + symbol);

  if (!q) return;
  const cur = q.currency;

  $('.price', card).textContent = fmtPrice(q.c, cur);
  $('.change', card).textContent = fmtChange(q.d, q.dp);
  card.dataset.dir = dirOf(q.d);
  $('.delayed', card).hidden = q.realTime;

  const ext = $('.ext', card);
  ext.hidden = !q.ext;
  if (q.ext) {
    $('.ext-label', ext).textContent = t(q.ext.type === 'PRE_MKT' ? 'marketPre' : 'marketPost');
    $('.ext-price', ext).textContent = fmtPrice(q.ext.c, cur);
    const ch = $('.ext-change', ext);
    ch.textContent = fmtChange(q.ext.d, q.ext.dp);
    ch.dataset.dir = dirOf(q.ext.d);
  }

  $('.open', card).textContent = fmtPrice(q.o, cur);
  $('.pc', card).textContent = fmtPrice(q.pc, cur);
  $('.low', card).textContent = fmtPrice(q.l, cur);
  $('.high', card).textContent = fmtPrice(q.h, cur);
  const span = q.h - q.l;
  const pos = span > 0 ? ((q.c - q.l) / span) * 100 : 50;
  $('.range-mark', card).style.left = Math.max(0, Math.min(100, pos)) + '%';

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
  let min = Math.min(...prices, q.pc ?? Infinity);
  let max = Math.max(...prices, q.pc ?? -Infinity);
  if (max === min) { max += 1; min -= 1; }
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const tspan = t1 - t0 || 1;
  const y = (v) => (30 - ((v - min) / (max - min)) * 28).toFixed(2);
  line.setAttribute('points', pts.map(([tt, v]) => `${(((tt - t0) / tspan) * 100).toFixed(2)},${y(v)}`).join(' '));
  if (q.pc != null) {
    base.style.display = '';
    base.setAttribute('y1', y(q.pc));
    base.setAttribute('y2', y(q.pc));
  }
}

// The US session drives the header pill; most of the list is US-listed.
function renderMarketStatus() {
  const us = Object.values(state.quotes).find((q) => q && q.realTime) || Object.values(state.quotes).find(Boolean);
  const el = $('#market-status');
  if (!us) { el.hidden = true; return; }
  let key = 'marketClosed', cls = 'closed';
  if (us.status === 'REG_MKT') { key = 'marketOpen'; cls = 'open'; }
  else if (us.status === 'PRE_MKT') { key = 'marketPre'; cls = 'ext'; }
  else if (us.status === 'POST_MKT') { key = 'marketPost'; cls = 'ext'; }
  el.dataset.key = key;
  el.className = 'pill market ' + cls;
  el.textContent = t(key);
  el.hidden = false;
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
  setConn($('#conn-status').dataset.kind || 'connecting');
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

async function addSymbol(raw) {
  const symbol = raw.trim().toUpperCase();
  if (!symbol) return;
  if (state.symbols.includes(symbol)) { toast(t('exists', { s: symbol })); return; }
  let q;
  try { q = (await fetchQuotes([symbol]))[symbol]; } catch (err) { console.warn(err); toast(t('offline')); return; }
  if (!q) { toast(t('notFound', { s: symbol })); return; }
  insertSymbol(symbol, state.symbols.length, q);
  toast(t('added', { s: symbol }));
}

function insertSymbol(symbol, index, quote) {
  state.symbols.splice(index, 0, symbol);
  saveSymbols();
  if (quote) {
    state.quotes[symbol] = quote;
    if (quote.name) { state.names[symbol] = quote.name; store.set('names', state.names); }
    pushTick(symbol, quote.ext ? quote.ext.c : quote.c, Date.now());
  }
  $('#grid').append(createCard(symbol));
  renderCard(symbol);
  applySort();
  $('#empty').hidden = true;
}

function removeSymbol(symbol) {
  const index = state.symbols.indexOf(symbol);
  if (index < 0) return;
  const quote = state.quotes[symbol];
  state.symbols.splice(index, 1);
  saveSymbols();
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
    input.value = '';
    hideSuggestions();
    addSymbol(symbol);
  });
}

async function runSearch(q) {
  const seq = ++searchSeq;
  let items;
  try { items = await searchSymbols(q); } catch (err) { console.warn(err); return; }
  if (seq !== searchSeq) return;
  items = items.slice(0, 8);
  const list = $('#suggestions');
  list.replaceChildren();
  activeIndex = -1;
  for (const r of items) {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.symbol = r.symbol;
    const sym = document.createElement('strong');
    sym.textContent = r.symbol;
    const desc = document.createElement('span');
    desc.className = 'muted';
    desc.dir = 'auto';
    desc.textContent = r.name;
    const exch = document.createElement('small');
    exch.className = 'muted exch';
    exch.dir = 'auto';
    exch.textContent = r.exchange;
    li.append(sym, desc, exch);
    if (state.symbols.includes(r.symbol)) li.classList.add('in-list');
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('#add-input').value = '';
      hideSuggestions();
      addSymbol(r.symbol);
    });
    list.append(li);
  }
  list.hidden = items.length === 0;
}

function hideSuggestions() {
  $('#suggestions').hidden = true;
  activeIndex = -1;
}

// ---------- controls ----------

function setupControls() {
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

  $('#reset-list').addEventListener('click', () => {
    if (!confirm(t('resetConfirm'))) return;
    state.cards.forEach((c) => c.remove());
    state.cards.clear();
    state.quotes = {};
    state.symbols = DEFAULT_STOCKS.map(([s]) => s);
    for (const [s, name] of DEFAULT_STOCKS) if (!state.names[s]) state.names[s] = name;
    saveSymbols();
    renderAll();
    pollLoop();
  });
}

// ---------- install as an app ----------

function setupInstall() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn(err));
  }
  const btn = $('#install');
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; });
}

// ---------- boot ----------

document.addEventListener('visibilitychange', () => {
  // Background tabs poll slowly; catch up as soon as the window is visible.
  if (document.visibilityState === 'visible' && Date.now() - state.lastUpdate > POLL_FAST_MS) pollLoop();
});

setupControls();
setupSearch();
setupInstall();
applyLang();
renderAll();
pollLoop();
