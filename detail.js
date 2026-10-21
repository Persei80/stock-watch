'use strict';

// Stock detail window: a price chart with Google-style range tabs and key stats.
// Uses helpers and state from app.js (loaded after this file).

const CHART_URL = 'https://ts-api.cnbc.com/harmony/app/charts/';

// CNBC returns more history than the range name says, so each range is
// trimmed here: by trading sessions for intraday data, by calendar otherwise.
const RANGES = [
  { key: '1D', api: '1D', sessions: 1, axis: { hour: '2-digit', minute: '2-digit' }, tip: { hour: '2-digit', minute: '2-digit' }, ttl: 60_000 },
  { key: '5D', api: '5D', sessions: 5, axis: { day: 'numeric', month: 'short' }, tip: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, ttl: 60_000, dayTicks: true },
  { key: '1M', api: '1M', months: 1 },
  { key: '6M', api: '6M', months: 6 },
  { key: 'YTD', api: '1Y', ytd: true },
  { key: '1Y', api: '1Y', months: 12 },
  { key: '5Y', api: '5Y', months: 60, axis: { year: 'numeric' }, tip: { day: 'numeric', month: 'short', year: 'numeric' } },
  { key: 'MAX', api: 'ALL', axis: { year: 'numeric' }, tip: { month: 'short', year: 'numeric' } },
];
const DEFAULT_AXIS = { day: 'numeric', month: 'short' };
const DEFAULT_TIP = { day: 'numeric', month: 'short', year: 'numeric' };
const DEFAULT_TTL = 10 * 60_000;

const detail = {
  symbol: null,
  range: '1D',
  view: null,     // { bars, base, range } currently drawn
  cache: new Map(), // `${symbol}|${api}` -> { at, bars }
  seq: 0,
  timer: 0,
};

// ---------- data ----------

async function fetchBars(symbol, api) {
  const key = symbol + '|' + api;
  const range = RANGES.find((r) => r.api === api);
  const hit = detail.cache.get(key);
  if (hit && Date.now() - hit.at < (range.ttl ?? DEFAULT_TTL)) return hit.bars;
  const res = await fetch(CHART_URL + api + '.json?symbol=' + encodeURIComponent(symbol));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  // Tel Aviv prices arrive in agorot, like the quotes.
  const scale = /-IL$/.test(symbol) ? 0.01 : 1;
  const bars = (data?.barData?.priceBars || [])
    .map((b) => ({ t: b.tradeTimeinMills, d: String(b.tradeTime), p: parseFloat(b.close) * scale }))
    .filter((b) => Number.isFinite(b.p) && b.d.length >= 12);
  detail.cache.set(key, { at: Date.now(), bars });
  return bars;
}

// Returns the bars to draw and the price the range is measured against.
function sliceRange(all, range) {
  if (!all.length) return { bars: [], base: null };
  let start = 0;
  if (range.sessions) {
    const days = [...new Set(all.map((b) => b.d.slice(0, 8)))].slice(-range.sessions);
    start = all.findIndex((b) => b.d.slice(0, 8) === days[0]);
  } else if (range.ytd) {
    const year = all[all.length - 1].d.slice(0, 4);
    start = all.findIndex((b) => b.d.slice(0, 4) === year);
  } else if (range.months) {
    const cut = new Date(all[all.length - 1].t);
    cut.setMonth(cut.getMonth() - range.months);
    start = all.findIndex((b) => b.t >= cut.getTime());
  }
  if (start < 0) start = 0;
  const bars = all.slice(start);
  return { bars, base: start > 0 ? all[start - 1].p : bars[0].p };
}

// tradeTime is the exchange's local wall-clock time; format it as such.
function barDate(d) {
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12)));
}
const dateFmt = (opts) => new Intl.DateTimeFormat(LOCALES[state.lang], { timeZone: 'UTC', ...opts });

// ---------- window ----------

function setupDetail() {
  const dlg = $('#detail');
  detail.range = RANGES.some((r) => r.key === store.get('range')) ? store.get('range') : '1D';

  const tabs = $('.ranges', dlg);
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.dataset.range = r.key;
    b.dataset.i18n = 'range' + r.key;
    b.addEventListener('click', () => selectRange(r.key));
    tabs.append(b);
  }
  translate(tabs);

  $('.detail-close', dlg).addEventListener('click', () => dlg.close());
  // A click on the dimmed backdrop lands on the dialog element itself.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => {
    detail.symbol = null;
    clearInterval(detail.timer);
  });

  const wrap = $('.chart-wrap', dlg);
  wrap.addEventListener('pointermove', (e) => showTip(e));
  wrap.addEventListener('pointerdown', (e) => showTip(e));
  wrap.addEventListener('pointerleave', hideTip);
  window.addEventListener('resize', () => { if (detail.symbol) drawChart(); });
}

function openDetail(symbol) {
  detail.symbol = symbol;
  const dlg = $('#detail');
  $('.detail-symbol', dlg).textContent = symbol;
  $('.detail-name', dlg).textContent = state.names[symbol] || '';
  renderDetailQuote();
  dlg.showModal();
  loadRange();
  clearInterval(detail.timer);
  // Keep intraday charts current while the window is open.
  detail.timer = setInterval(() => {
    const r = RANGES.find((x) => x.key === detail.range);
    if (r.ttl && document.visibilityState === 'visible') loadRange(true);
  }, 60_000);
}

function selectRange(key) {
  detail.range = key;
  store.set('range', key);
  loadRange();
}

async function loadRange(quiet) {
  const symbol = detail.symbol;
  const range = RANGES.find((r) => r.key === detail.range);
  const seq = ++detail.seq;
  const dlg = $('#detail');
  dlg.querySelectorAll('.ranges button').forEach((b) => b.setAttribute('aria-selected', b.dataset.range === range.key));
  if (!quiet) setChartMsg(t('loading'));
  let all;
  try {
    all = await fetchBars(symbol, range.api);
  } catch (err) {
    console.warn(err);
    if (seq === detail.seq) setChartMsg(t('offline'));
    return;
  }
  if (seq !== detail.seq || symbol !== detail.symbol) return;
  const { bars, base } = sliceRange(all, range);
  // For one day Google measures against yesterday's close, like the cards do.
  const pc = state.quotes[symbol]?.pc;
  detail.view = { bars, base: range.key === '1D' && pc != null ? pc : base, range };
  if (bars.length < 2) {
    setChartMsg(t('chartNoData'));
    $('#chart').replaceChildren();
  } else {
    setChartMsg('');
    drawChart();
  }
  renderDetailQuote();
}

function setChartMsg(text) {
  const el = $('#detail .chart-msg');
  setText(el, text);
  el.hidden = !text;
}

// Header price and change over the selected range.
function renderDetailQuote() {
  const symbol = detail.symbol;
  if (!symbol) return;
  const dlg = $('#detail');
  const q = state.quotes[symbol];
  if (!q) return;
  const cur = q.currency;
  $('.detail-price', dlg).textContent = fmtPrice(q.c, cur);

  const view = detail.view;
  const range = RANGES.find((r) => r.key === detail.range);
  let d = q.d, dp = q.dp;
  if (range.key !== '1D' && view && view.base) {
    d = q.c - view.base;
    dp = (d / view.base) * 100;
  }
  const ch = $('.detail-change', dlg);
  ch.textContent = fmtChange(d, dp);
  ch.dataset.dir = dirOf(d);
  setText($('.detail-period', dlg), t('period' + range.key));

  const ext = $('.detail-ext', dlg);
  ext.hidden = !q.ext;
  if (q.ext) {
    setText($('.ext-label', ext), t(q.ext.type === 'PRE_MKT' ? 'marketPre' : 'marketPost'));
    $('.ext-price', ext).textContent = fmtPrice(q.ext.c, cur);
    const ec = $('.ext-change', ext);
    ec.textContent = fmtChange(q.ext.d, q.ext.dp);
    ec.dataset.dir = dirOf(q.ext.d);
  }

  const s = q.stats || {};
  const rows = [
    ['open', fmtPrice(q.o, cur)],
    ['high', fmtPrice(q.h, cur)],
    ['low', fmtPrice(q.l, cur)],
    ['prevClose', fmtPrice(q.pc, cur)],
    ['yearHigh', fmtPrice(s.yrhi, cur)],
    ['yearLow', fmtPrice(s.yrlo, cur)],
    ['mktCap', s.mktcap],
    ['pe', s.pe],
    ['divYield', s.divy],
    ['volume', s.vol],
  ].filter(([, v]) => v && v !== '—');
  const dl = $('.detail-stats', dlg);
  dl.replaceChildren(...rows.map(([k, v]) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.className = 'muted';
    setText(dt, t(k));
    const dd = document.createElement('dd');
    dd.dir = 'ltr';
    dd.textContent = v;
    div.append(dt, dd);
    return div;
  }));
}

// ---------- chart ----------

function niceTicks(min, max, count) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return ticks;
}

function drawChart() {
  const view = detail.view;
  const svg = $('#chart');
  if (!view || view.bars.length < 2) return;
  const wrap = $('#detail .chart-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const m = { top: 12, right: 64, bottom: 28, left: 6 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const { bars, base, range } = view;
  const cur = state.quotes[detail.symbol]?.currency || 'USD';

  let min = Math.min(...bars.map((b) => b.p));
  let max = Math.max(...bars.map((b) => b.p));
  if (range.key === '1D' && base != null) { min = Math.min(min, base); max = Math.max(max, base); }
  const pad = (max - min) * 0.06 || max * 0.01 || 1;
  min = Math.max(0, min - pad); max += pad;

  const x = (i) => m.left + (i / (bars.length - 1)) * iw;
  const y = (v) => m.top + (1 - (v - min) / (max - min)) * ih;
  const up = bars[bars.length - 1].p >= (base ?? bars[0].p);
  const color = up ? 'var(--up)' : 'var(--down)';

  const line = bars.map((b, i) => `${x(i).toFixed(1)},${y(b.p).toFixed(1)}`).join(' L');
  const area = `M${x(0).toFixed(1)},${(m.top + ih).toFixed(1)} L${line} L${x(bars.length - 1).toFixed(1)},${(m.top + ih).toFixed(1)} Z`;

  const yTicks = niceTicks(min, max, H < 240 ? 3 : 4);
  const short = (v) => fmtPrice(v, cur).replace(/\.00(?=\D*$)/, '');
  const grid = yTicks.map((v) => `
    <line class="grid" x1="${m.left}" x2="${m.left + iw}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line>
    <text class="ylab" x="${W - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${short(v)}</text>`).join('');

  // X labels: day boundaries for 5D, evenly spaced otherwise.
  const axisFmt = dateFmt(range.axis || DEFAULT_AXIS);
  const xIdx = [];
  const last = bars.length - 1;
  if (range.dayTicks) {
    bars.forEach((b, i) => { if (i === 0 || b.d.slice(0, 8) !== bars[i - 1].d.slice(0, 8)) xIdx.push(i); });
  } else {
    const n = Math.max(2, Math.min(5, Math.floor(iw / 110)));
    for (let k = 0; k < n; k++) xIdx.push(Math.round((k / (n - 1)) * last));
  }
  let lastLabel = '';
  const xlabs = xIdx.map((i) => {
    const label = axisFmt.format(barDate(bars[i].d));
    if (label === lastLabel) return '';
    lastLabel = label;
    const anchor = range.dayTicks || i === 0 ? 'start' : i === last ? 'end' : 'middle';
    return `<text class="xlab" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${label}</text>`;
  }).join('');

  const baseLine = range.key === '1D' && base != null
    ? `<line class="baseline" x1="${m.left}" x2="${m.left + iw}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}"></line>`
    : '';

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = `
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.22"></stop>
      <stop offset="1" stop-color="${color}" stop-opacity="0"></stop>
    </linearGradient></defs>
    ${grid}${baseLine}
    <path d="${area}" fill="url(#chart-fill)"></path>
    <path d="M${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"></path>
    ${xlabs}
    <g class="hover" visibility="hidden">
      <line class="cross" y1="${m.top}" y2="${m.top + ih}"></line>
      <circle r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2"></circle>
    </g>`;
  view.geom = { x, y, m, iw };
}

function showTip(e) {
  const view = detail.view;
  if (!view || !view.geom || view.bars.length < 2) return;
  const wrap = $('#detail .chart-wrap');
  const rect = wrap.getBoundingClientRect();
  const { x, y, m, iw } = view.geom;
  const px = e.clientX - rect.left;
  const i = Math.max(0, Math.min(view.bars.length - 1, Math.round(((px - m.left) / iw) * (view.bars.length - 1))));
  const b = view.bars[i];
  const g = $('#chart .hover');
  if (!g) return;
  g.setAttribute('visibility', 'visible');
  const cx = x(i), cy = y(b.p);
  $('line', g).setAttribute('x1', cx);
  $('line', g).setAttribute('x2', cx);
  $('circle', g).setAttribute('cx', cx);
  $('circle', g).setAttribute('cy', cy);

  const tip = $('#detail .chart-tip');
  const cur = state.quotes[detail.symbol]?.currency || 'USD';
  $('.tip-price', tip).textContent = fmtPrice(b.p, cur);
  $('.tip-time', tip).textContent = dateFmt(view.range.tip || DEFAULT_TIP).format(barDate(b.d));
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(0, Math.min(rect.width - tw, cx - tw / 2)) + 'px';
}

function hideTip() {
  const g = $('#chart .hover');
  if (g) g.setAttribute('visibility', 'hidden');
  $('#detail .chart-tip').hidden = true;
}
