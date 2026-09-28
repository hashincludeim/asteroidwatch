// Asteroid Watch — dashboard wiring: data loading, list, detail panel, timeline.

import { SpaceScene } from './scene.js';
import { fetchWindow } from './api.js';
import { buildNeo, hash, mulberry32 } from './neo.js';
import { AU_KM, LD_KM } from './astro.js';
import * as fmt from './format.js';
import { renderOrbitDiagram, updateOrbitDiagram } from './orbit-diagram.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = fmt.escapeHtml;
const icon = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const HOUR = 3600e3;
const SPEEDS = [
  { mult: 1, label: '1×', title: 'Real time' },
  { mult: 60, label: '1m/s', title: '1 minute per second' },
  { mult: 600, label: '10m/s', title: '10 minutes per second' },
  { mult: 3600, label: '1h/s', title: '1 hour per second' },
];
const ORBIT_CLASSES = { APO: 'Apollo', ATE: 'Aten', AMO: 'Amor', IEO: 'Atira' };
const GEO_KM = 42164;

const state = {
  dayStart: 0,
  dayEnd: 0,
  neos: [],
  byId: new Map(),
  time: Date.now(),
  live: true,
  playing: true,
  speed: 1,
  selectedId: null,
  hoverId: null,
  filter: 'all',
  sort: 'distance',
  requestSeq: 0,
  fetchedAt: 0,
  stale: false,
  scrubbing: false,
};

const els = {
  stats: $('#stats'),
  overlay: $('#overlay'),
  side: $('#side'),
  listView: $('#listView'),
  detailView: $('#detailView'),
  list: $('#neoList'),
  listSub: $('#listSub'),
  listTitle: $('#listTitle'),
  countAll: $('#countAll'),
  countHaz: $('#countHaz'),
  sortSel: $('#sortSel'),
  dateLabel: $('#dateLabel'),
  dateHint: $('#dateHint'),
  dateInput: $('#dateInput'),
  tooltip: $('#tooltip'),
  track: $('#track'),
  ticks: $('#tlTicks'),
  hours: $('#tlHours'),
  head: $('#tlHead'),
  progress: $('#tlProgress'),
  nowMarker: $('#tlNow'),
  tlMode: $('#tlMode'),
  tlTime: $('#tlTime'),
  tlDate: $('#tlDate'),
  tlTz: $('#tlTz'),
  playBtn: $('#playBtn'),
  speeds: $('#speeds'),
  liveBtn: $('#liveBtn'),
};

/* ------------------------------------------------------------ dates */

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

const isToday = () => startOfDay(Date.now()) === state.dayStart;

/* ------------------------------------------------------------ scene */

const scene = new SpaceScene($('#scene'), {
  focusElement: $('.stage'),
  onTick: tick,
  onSelect: (id) => select(id),
  onHover: (id, x, y) => setHover(id, { x, y, source: 'scene' }),
  onAutoRotate: (on) => setToolPressed($('#toggleRotate'), on),
});

/* ------------------------------------------------------------ loading */

function goToDay(dayMs, { selectId = null } = {}) {
  state.dayStart = startOfDay(dayMs);
  state.dayEnd = addDays(state.dayStart, 1);
  if (isToday()) {
    Object.assign(state, { live: true, playing: true, speed: 1, time: Date.now() });
  } else {
    Object.assign(state, { live: false, playing: false, speed: 600, time: state.dayStart + 12 * HOUR });
  }
  renderDateNav();
  renderHours();
  renderPlayState();
  updatePlayhead();
  scene.setDay(state.dayStart);
  scene.setTime(state.time);
  loadDay({ selectId });
}

async function loadDay({ force = false, selectId = null } = {}) {
  const seq = ++state.requestSeq;
  select(null, { fly: false });
  showOverlay('loading');
  els.listSub.textContent = 'Scanning NASA’s catalogue…';
  try {
    const res = await fetchWindow(state.dayStart, state.dayEnd, { force });
    if (seq !== state.requestSeq) return;
    const seen = new Set();
    const neos = [];
    for (const raw of res.neos) {
      const n = buildNeo(raw);
      if (!n || n.tca < state.dayStart || n.tca >= state.dayEnd || seen.has(n.id)) continue;
      seen.add(n.id);
      neos.push(n);
    }
    state.fetchedAt = res.fetchedAt;
    state.stale = !!res.stale;
    setNeos(neos);
    hideOverlay();
    if (!neos.length) showOverlay('empty');
    if (selectId && state.byId.has(selectId)) select(selectId);
  } catch (err) {
    if (seq !== state.requestSeq) return;
    setNeos([]);
    els.listSub.textContent = 'No data loaded';
    showOverlay('error', err);
  }
}

function setNeos(neos) {
  state.neos = neos;
  state.byId = new Map(neos.map((n) => [n.id, n]));
  state.hoverId = null;
  if (state.filter === 'hazard' && !neos.some((n) => n.hazardous)) {
    state.filter = 'all';
    syncFilterUI();
  }
  els.listTitle.textContent = isToday() ? 'Today’s flybys' : `Flybys on ${fmt.dayLabel(state.dayStart)}`;
  scene.setAsteroids(neos);
  applyFilter();
  scene.frameAll();
  renderStats();
  renderList();
  renderTicks();
  updateLive();
}

/* ------------------------------------------------------------ overlay */

function showOverlay(kind, err) {
  const o = els.overlay;
  o.hidden = false;
  o.dataset.kind = kind;
  if (kind === 'loading') {
    o.innerHTML = `<div class="ov-card ov-loading">
      <div class="radar" aria-hidden="true"><span></span></div>
      <div><strong>Scanning the sky…</strong><p>Fetching close approaches from NASA NeoWs</p></div>
    </div>`;
  } else if (kind === 'empty') {
    o.innerHTML = `<div class="ov-card">
      ${icon('globe', 'ov-icon')}
      <div><strong>A quiet day</strong><p>NASA lists no close approaches for ${esc(fmt.dayLong(state.dayStart))}.</p></div>
    </div>`;
  } else {
    const limited = err?.kind === 'rate';
    o.innerHTML = `<div class="ov-card ov-error" role="alert">
      ${icon('warning', 'ov-icon')}
      <div>
        <strong>${limited ? 'Rate limit reached' : 'Something went wrong'}</strong>
        <p>${esc(err?.message || 'Unknown error')}</p>
        <div class="ov-actions">
          <button class="ghost-btn" data-action="retry">Try again</button>
        </div>
      </div>
    </div>`;
  }
}

function hideOverlay() {
  els.overlay.hidden = true;
  els.overlay.innerHTML = '';
}

els.overlay.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry') loadDay({ force: true });
});

/* ------------------------------------------------------------ stats */

const minBy = (list, f) => list.reduce((a, b) => (f(b) < f(a) ? b : a));
const maxBy = (list, f) => list.reduce((a, b) => (f(b) > f(a) ? b : a));

function sizeParts(m) {
  return m >= 1000 ? [fmt.num(m / 1000, 2), 'km'] : [fmt.num(m), 'm'];
}

function statTile({ label, value, unit = '', sub = '', cls = '', id = '', action = '', iconId = '' }) {
  const attrs = `${id ? ` data-id="${id}"` : ''}${action ? ` data-action="${action}"` : ''}`;
  const tag = id || action ? 'button' : 'div';
  return `<${tag} class="stat ${cls}"${attrs}>
    <span class="stat-label">${iconId ? icon(iconId) : ''}${label}</span>
    <span class="stat-value">${value}${unit ? `<small>${unit}</small>` : ''}</span>
    <span class="stat-sub">${sub}</span>
  </${tag}>`;
}

function renderStats() {
  const list = state.neos;
  if (!list.length) {
    els.stats.innerHTML = [
      statTile({ label: 'Flying by', value: '—', sub: 'No data' }),
      statTile({ label: 'Potentially hazardous', value: '—', iconId: 'warning' }),
    ].join('');
    return;
  }
  const haz = list.filter((n) => n.hazardous);
  const closest = minBy(list, (n) => n.missKm);
  const fastest = maxBy(list, (n) => n.speedKms);
  const largest = maxBy(list, (n) => n.dMean);
  const [sizeVal, sizeUnit] = sizeParts(largest.dMean);
  els.stats.innerHTML = [
    statTile({
      label: 'Flying by',
      value: list.length,
      unit: list.length === 1 ? 'object' : 'objects',
      sub: '<span data-live="passed"></span>',
      cls: 'stat-count',
    }),
    statTile({
      label: 'Potentially hazardous',
      value: haz.length,
      sub: haz.length ? `${Math.round((haz.length / list.length) * 100)}% of objects · click to filter` : 'None on this day',
      cls: haz.length ? `stat-hazard${state.filter === 'hazard' ? ' is-active' : ''}` : 'stat-clear',
      action: haz.length ? 'filter-hazard' : '',
      iconId: haz.length ? 'warning' : 'shield',
    }),
    `<button class="stat stat-next" data-live-next>
      <span class="stat-label">Next closest approach</span>
      <span class="stat-value" data-live="next-value">—</span>
      <span class="stat-sub" data-live="next-sub"></span>
    </button>`,
    statTile({
      label: 'Closest approach',
      value: fmt.ld(closest.missLD),
      unit: 'LD',
      sub: `${esc(closest.label)} · ${fmt.km(closest.missKm)}`,
      id: closest.id,
    }),
    statTile({
      label: 'Fastest',
      value: fmt.num(fastest.speedKms, 1),
      unit: 'km/s',
      sub: `${esc(fastest.label)} · ${fmt.num(fastest.speedKmh)} km/h`,
      id: fastest.id,
    }),
    statTile({
      label: 'Largest',
      value: `~${sizeVal}`,
      unit: sizeUnit,
      sub: `${esc(largest.label)} · ${fmt.diameterRange(largest.dMin, largest.dMax)}`,
      id: largest.id,
    }),
  ].join('');
}

els.stats.addEventListener('click', (e) => {
  const tile = e.target.closest('.stat');
  if (!tile) return;
  if (tile.dataset.action === 'filter-hazard') setFilter(state.filter === 'hazard' ? 'all' : 'hazard');
  else if (tile.dataset.id) select(tile.dataset.id);
});

/* ------------------------------------------------------------ list */

const LOG_MIN = Math.log10(0.05);
const LOG_MAX = Math.log10(250);
const distPct = (ldValue) => Math.min(100, Math.max(0, ((Math.log10(ldValue) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100));

function visibleNeos() {
  const list = state.neos.filter((n) => state.filter === 'all' || n.hazardous);
  const sorters = {
    distance: (a, b) => a.missKm - b.missKm,
    time: (a, b) => a.tca - b.tca,
    size: (a, b) => b.dMean - a.dMean,
    speed: (a, b) => b.speedKms - a.speedKms,
  };
  return list.sort(sorters[state.sort]);
}

function cardHTML(n) {
  const glyph = Math.round(Math.min(22, Math.max(8, 6 + 5 * Math.log10(Math.max(n.dMean, 1)))));
  const [size, unit] = sizeParts(n.dMean);
  return `<li><button class="neo-card${n.hazardous ? ' is-hazard' : ''}" data-id="${n.id}">
    <span class="nc-glyph" style="--g:${glyph}px" aria-hidden="true"></span>
    <span class="nc-body">
      <span class="nc-row">
        <span class="nc-name">${esc(n.label)}</span>
        ${n.hazardous ? `<span class="badge badge-hazard">${icon('warning')}Hazardous</span>` : ''}
        ${n.sentry ? `<span class="badge badge-sentry">${icon('eye')}Sentry</span>` : ''}
      </span>
      <span class="nc-when"><span class="nc-status" data-rel="${n.tca}"></span><span class="nc-dot-sep">·</span>${fmt.clock(n.tca)}</span>
      <span class="nc-metrics">
        <span><b>${fmt.ld(n.missLD)}</b> LD</span>
        <span><b>${fmt.num(n.speedKms, 1)}</b> km/s</span>
        <span><b>~${size}</b> ${unit}</span>
      </span>
      <span class="nc-track" aria-hidden="true" title="Miss distance on a log scale (Earth → Moon → beyond)">
        <span class="nc-earth"></span>
        <span class="nc-moon" style="left:${distPct(1)}%"></span>
        <span class="nc-pos" style="left:${distPct(n.missLD)}%"></span>
      </span>
    </span>
  </button></li>`;
}

function renderList() {
  const items = visibleNeos();
  els.countAll.textContent = state.neos.length;
  els.countHaz.textContent = state.neos.filter((n) => n.hazardous).length;
  if (!items.length) {
    els.list.innerHTML = state.neos.length
      ? `<li class="list-empty">${icon('shield')}<span>No potentially hazardous asteroids on this day.</span></li>`
      : '<li class="list-empty"><span>Nothing to show yet.</span></li>';
  } else {
    els.list.innerHTML = items.map(cardHTML).join('');
  }
  if (state.neos.length) {
    const updated = fmt.relative(state.fetchedAt, Date.now());
    els.listSub.textContent = `${state.neos.length} close approaches · updated ${updated === 'now' ? 'just now' : updated}${state.stale ? ' (offline copy)' : ''}`;
  }
  syncHighlights();
  updateLive();
}

els.list.addEventListener('click', (e) => {
  const card = e.target.closest('.neo-card');
  if (card) select(card.dataset.id);
});
els.list.addEventListener('pointerover', (e) => {
  const card = e.target.closest('.neo-card');
  if (card && card.dataset.id !== state.hoverId) setHover(card.dataset.id, { source: 'list' });
});
els.list.addEventListener('pointerleave', () => setHover(null));

$$('.seg button').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
els.sortSel.addEventListener('change', () => {
  state.sort = els.sortSel.value;
  renderList();
});

function syncFilterUI() {
  $$('.seg button').forEach((b) => {
    const on = b.dataset.filter === state.filter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('.stat-hazard')?.classList.toggle('is-active', state.filter === 'hazard');
}

function setFilter(filter) {
  state.filter = filter;
  syncFilterUI();
  applyFilter();
  const sel = state.byId.get(state.selectedId);
  if (sel && filter === 'hazard' && !sel.hazardous) select(null);
  renderList();
  renderTicks();
}

function applyFilter() {
  scene.setFilter((n) => state.filter === 'all' || n.hazardous);
}

/* ------------------------------------------------------------ hover & select */

function setHover(id, { x, y, source } = {}) {
  const n = id ? state.byId.get(id) : null;
  state.hoverId = n ? n.id : null;
  scene.setHovered(state.hoverId);
  syncHighlights();
  if (n && (source === 'scene' || source === 'tick') && x != null) {
    els.tooltip.innerHTML = tooltipHTML(n);
    els.tooltip.hidden = false;
    positionTooltip(x, y, source === 'tick');
  } else {
    els.tooltip.hidden = true;
  }
}

function tooltipHTML(n) {
  const now = Math.hypot(...n.posAt(state.time)) / LD_KM;
  return `<div class="tt-head">
      <span class="tt-name">${esc(n.label)}</span>
      ${n.hazardous ? `<span class="badge badge-hazard">${icon('warning')}Hazardous</span>` : ''}
    </div>
    <dl class="tt-grid">
      <dt>Now</dt><dd>${fmt.ld(now)} LD</dd>
      <dt>Closest</dt><dd>${fmt.ld(n.missLD)} LD · ${fmt.clock(n.tca)}</dd>
      <dt>Speed</dt><dd>${fmt.num(n.speedKms, 1)} km/s</dd>
      <dt>Size</dt><dd>${fmt.diameterRange(n.dMin, n.dMax)}</dd>
    </dl>
    <div class="tt-hint">Click for details</div>`;
}

function positionTooltip(x, y, above) {
  const t = els.tooltip;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let left = x + 16;
  let top = above ? y - h - 14 : y + 16;
  if (left + w > window.innerWidth - 8) left = x - w - 16;
  if (top + h > window.innerHeight - 8) top = y - h - 16;
  t.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}

function syncHighlights() {
  $$('.neo-card', els.list).forEach((c) => {
    c.classList.toggle('is-hover', c.dataset.id === state.hoverId);
    c.classList.toggle('is-selected', c.dataset.id === state.selectedId);
  });
  $$('.tick', els.ticks).forEach((t) => {
    t.classList.toggle('is-hover', t.dataset.id === state.hoverId);
    t.classList.toggle('is-selected', t.dataset.id === state.selectedId);
  });
}

function select(id, { fly = true } = {}) {
  const n = id ? state.byId.get(id) : null;
  if (n && state.filter === 'hazard' && !n.hazardous) setFilter('all');
  state.selectedId = n ? n.id : null;
  scene.setSelected(state.selectedId, { fly });
  els.tooltip.hidden = true;
  if (n) {
    renderDetail(n);
    els.listView.hidden = true;
    els.detailView.hidden = false;
    els.side.classList.add('has-detail');
    els.detailView.scrollTop = 0;
  } else {
    els.detailView.hidden = true;
    els.listView.hidden = false;
    els.side.classList.remove('has-detail');
  }
  syncHighlights();
  updateHash();
  updateLive();
}

/* ------------------------------------------------------------ detail */

function metric(label, value, unit, sub) {
  return `<div class="metric">
    <span class="metric-label">${label}</span>
    <span class="metric-value">${value}<small>${unit}</small></span>
    <span class="metric-sub">${sub}</span>
  </div>`;
}

function kv(label, value) {
  return `<div class="kv-row"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function blobPath(cx, cy, r, seed) {
  const rand = mulberry32(seed);
  const pts = [];
  const count = 14;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const rr = r * (0.82 + rand() * 0.3);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  // Smooth closed curve through the points (Catmull-Rom → cubic Bézier).
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < count; i++) {
    const p0 = pts[(i - 1 + count) % count];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % count];
    const p3 = pts[(i + 2) % count];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `${d}Z`;
}

const HORIZONTAL_REFS = new Set(['a school bus', 'a blue whale', 'a Boeing 747', 'the Golden Gate Bridge span']);

function sizeCompareSVG(n, cmp) {
  const W = 320;
  const H = 132;
  const base = 104;
  const maxPx = 84;
  const s = maxPx / Math.max(n.dMean, cmp.ref.m);
  const r = (n.dMean * s) / 2;
  const blob = blobPath(92, base - r, r, hash(n.id));
  const refLen = cmp.ref.m * s;
  const horizontal = HORIZONTAL_REFS.has(cmp.ref.name);
  const refName = cmp.ref.name.replace(/^(a|the) /, '');
  const refShape = horizontal
    ? `<rect x="${(228 - refLen / 2).toFixed(1)}" y="${base - 10}" width="${refLen.toFixed(1)}" height="10" rx="3" class="sc-ref"/>`
    : `<path class="sc-ref" d="M${228 - Math.max(6, refLen * 0.16)},${base} L${228 - 3},${(base - refLen).toFixed(1)} L${228 + 3},${(base - refLen).toFixed(1)} L${228 + Math.max(6, refLen * 0.16)},${base} Z"/>`;
  return `<svg class="size-svg tone-${n.hazardous ? 'hazard' : 'safe'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cmp.text)}">
    <line x1="16" x2="${W - 16}" y1="${base}" y2="${base}" class="sc-ground"/>
    <path d="${blob}" class="sc-blob"/>
    ${refShape}
    <text x="92" y="${base + 18}" class="sc-label">${esc(n.label)} · ~${fmt.meters(n.dMean)}</text>
    <text x="228" y="${base + 18}" class="sc-label">${esc(refName.charAt(0).toUpperCase() + refName.slice(1))} · ${fmt.meters(cmp.ref.m)}</text>
  </svg>`;
}

function distanceLadderSVG(n) {
  const W = 320;
  const H = 70;
  const x0 = 22;
  const x1 = W - 14;
  const maxLD = Math.max(250, n.missLD * 1.6);
  const minLD = 0.02;
  const X = (v) => x0 + ((Math.log10(v) - Math.log10(minLD)) / (Math.log10(maxLD) - Math.log10(minLD))) * (x1 - x0);
  const ticks = [0.1, 1, 10, 100].filter((v) => v < maxLD);
  const y = 34;
  return `<svg class="ladder-svg tone-${n.hazardous ? 'hazard' : 'safe'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Miss distance compared with the Moon on a log scale">
    <line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" class="ld-axis"/>
    ${ticks.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${y - 4}" y2="${y + 4}" class="ld-tick"/><text x="${X(v)}" y="${y + 20}" class="ld-tick-label">${v} LD</text>`).join('')}
    <circle cx="${x0 - 6}" cy="${y}" r="7" class="ld-earth"/>
    <text x="${x0 - 6}" y="${y - 14}" class="ld-label">Earth</text>
    <circle cx="${X(GEO_KM / LD_KM)}" cy="${y}" r="2.5" class="ld-geo"/>
    <text x="${X(GEO_KM / LD_KM)}" y="${y - 10}" class="ld-label small">GEO sats</text>
    <circle cx="${X(1)}" cy="${y}" r="4.5" class="ld-moon"/>
    <text x="${X(1)}" y="${y - 12}" class="ld-label">Moon</text>
    <path d="M${X(n.missLD)},${y - 7} l6,7 -6,7 -6,-7Z" class="ld-neo"/>
    <text x="${X(n.missLD)}" y="${y - 12}" class="ld-label strong">${fmt.ld(n.missLD)} LD</text>
  </svg>`;
}

function closenessText(n) {
  if (n.missLD < 1) {
    return `Closer than the Moon: ${fmt.num(n.missLD * 100)}% of the Earth–Moon distance, or ${fmt.km(n.missKm)} from Earth’s centre.`;
  }
  return `About ${fmt.num(n.missLD, n.missLD < 10 ? 1 : 0)}× farther away than the Moon at its closest point, a safe miss of ${fmt.km(n.missKm)}.`;
}

function renderDetail(n) {
  const o = n.orbit;
  const cmp = fmt.sizeComparison(n.dMean);
  const [size, sizeUnit] = sizeParts(n.dMean);
  const cls = o?.orbit_class;
  const className = cls ? ORBIT_CLASSES[cls.orbit_class_type] || cls.orbit_class_type : null;
  const moid = o ? +o.minimum_orbit_intersection : NaN;
  const period = o ? +o.orbital_period : NaN;
  const arc = o ? +o.data_arc_in_days : NaN;

  els.detailView.innerHTML = `
    <div class="dt-top">
      <button class="icon-btn" data-action="back" aria-label="Back to list" title="Back to list (Esc)">${icon('back')}</button>
      <div class="dt-top-actions">
        <button class="chip-btn" data-action="focus">${icon('target')}Focus</button>
        <a class="chip-btn" href="${esc(n.jplUrl)}" target="_blank" rel="noopener">JPL database ${icon('external')}</a>
      </div>
    </div>

    <header class="dt-head${n.hazardous ? ' is-hazard' : ''}">
      <p class="eyebrow">${className ? `${esc(className)}-class near-Earth asteroid` : 'Near-Earth object'}</p>
      <h2>${esc(n.label)}</h2>
      <p class="muted mono small">${esc(n.name)} · NEO ${esc(n.id)}</p>
      <div class="badges">
        ${n.hazardous
          ? `<span class="badge badge-hazard lg">${icon('warning')}Potentially hazardous</span>`
          : `<span class="badge badge-safe lg">${icon('shield')}Not potentially hazardous</span>`}
        ${n.sentry ? `<span class="badge badge-sentry lg">${icon('eye')}On Sentry impact watch</span>` : ''}
      </div>
    </header>

    <section class="dt-hero">
      <div class="hero-cell">
        <span class="hero-label" data-live="ca-label">Closest approach</span>
        <span class="hero-value" data-live="ca-rel">—</span>
        <span class="hero-sub">${fmt.fullDate(n.tca)}</span>
      </div>
      <div class="hero-cell">
        <span class="hero-label">Distance right now</span>
        <span class="hero-value"><span data-live="now-ld">—</span><small>LD</small></span>
        <span class="hero-sub" data-live="now-km">—</span>
      </div>
    </section>

    <section class="dt-grid">
      ${metric('Miss distance', fmt.ld(n.missLD), 'LD', `${fmt.km(n.missKm)} · ${fmt.num(n.missAU, 4)} AU`)}
      ${metric('Relative speed', fmt.num(n.speedKms, 2), 'km/s', `${fmt.num(n.speedKmh)} km/h`)}
      ${metric('Diameter', `~${size}`, sizeUnit, `${fmt.diameterRange(n.dMin, n.dMax)} estimated`)}
      ${metric('Brightness (H)', fmt.num(n.H, 1), 'mag', 'Lower = bigger / brighter')}
    </section>

    <section class="dt-card">
      <h3>How big is it?</h3>
      ${sizeCompareSVG(n, cmp)}
      <p>${esc(cmp.text)}.</p>
    </section>

    <section class="dt-card">
      <h3>How close does it come?</h3>
      ${distanceLadderSVG(n)}
      <p>${closenessText(n)}</p>
    </section>

    ${n.hazardous ? `<section class="dt-card dt-explain">
      ${icon('info')}
      <p><strong>Why “potentially hazardous”?</strong> Its orbit passes within 0.05 AU (19.5 LD) of Earth’s orbit${Number.isFinite(moid) ? ` (closest orbit gap: ${fmt.num(moid, 4)} AU)` : ''}, and it’s big enough (H ≤ 22, roughly 140 m or more) to cause regional damage. It is a long-term monitoring label, not an impact prediction.</p>
    </section>` : ''}

    <section class="dt-card">
      <h3>Orbit around the Sun</h3>
      <div class="orbit-wrap" id="orbitWrap">${renderOrbitDiagram(n, state.time)}</div>
      <div class="orbit-legend">
        <span><i class="ol ol-earth"></i>Earth</span>
        <span><i class="ol ol-neo${n.hazardous ? ' hazard' : ''}"></i>${esc(n.label)}</span>
        <span><i class="ol ol-below"></i>Below Earth’s orbital plane</span>
      </div>
      ${cls ? `<p class="muted small">${esc(className)} class: ${esc(cls.orbit_class_description)} (${esc(cls.orbit_class_range)}).</p>` : ''}
    </section>

    ${o ? `<section class="dt-card">
      <h3>Orbital elements</h3>
      <dl class="kv">
        ${kv('Semi-major axis', `${fmt.num(+o.semi_major_axis, 3)} AU`)}
        ${kv('Eccentricity', fmt.num(+o.eccentricity, 3))}
        ${kv('Inclination', `${fmt.num(+o.inclination, 2)}°`)}
        ${kv('Perihelion / aphelion', `${fmt.num(+o.perihelion_distance, 3)} / ${fmt.num(+o.aphelion_distance, 3)} AU`)}
        ${Number.isFinite(period) ? kv('Orbital period', `${fmt.num(period)} days (${fmt.num(period / 365.25, 2)} yr)`) : ''}
        ${Number.isFinite(moid) ? kv('Min. orbit intersection', `${fmt.num(moid, 4)} AU (${fmt.ld((moid * AU_KM) / LD_KM)} LD)`) : ''}
      </dl>
    </section>

    <section class="dt-card">
      <h3>Observation record</h3>
      <dl class="kv">
        ${kv('First observed', esc(o.first_observation_date))}
        ${kv('Last observed', esc(o.last_observation_date))}
        ${kv('Observations used', fmt.num(+o.observations_used))}
        ${Number.isFinite(arc) ? kv('Data arc', `${fmt.num(arc)} days (${fmt.num(arc / 365.25, 1)} yr)`) : ''}
        ${kv('Orbit uncertainty', `${esc(o.orbit_uncertainty)} <span class="muted">(0 = best, 9 = worst)</span>`)}
      </dl>
    </section>` : ''}

    <section class="dt-card dt-energy">
      <h3>Hypothetical impact energy</h3>
      <p class="energy-value">${fmt.impactEnergy(n.dMean, n.speedKms)} <small>of TNT</small></p>
      <p class="muted small">Kinetic energy if an object this size struck Earth at this speed, assuming a rocky density of 2.6 g/cm³. This flyby misses Earth by ${fmt.km(n.missKm)}.</p>
    </section>

    <p class="dt-source muted small">Data: NASA NeoWs / JPL Small-Body Database. Positions are computed from the published orbit.</p>
  `;
}

els.detailView.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'back') {
    select(null);
    scene.resetView();
  } else if (action === 'focus') {
    scene.focusSelected();
  }
});

/* ------------------------------------------------------------ live updates */

function updateLive() {
  const t = state.time;

  $$('[data-rel]', els.list).forEach((el) => {
    const tca = +el.dataset.rel;
    const past = tca <= t;
    el.textContent = past ? `Passed ${fmt.relative(tca, t)}` : `Closest ${fmt.relative(tca, t)}`;
    el.classList.toggle('is-past', past);
  });

  if (state.neos.length) {
    const passed = state.neos.filter((n) => n.tca <= t).length;
    const passedEl = $('[data-live="passed"]', els.stats);
    if (passedEl) passedEl.textContent = `${passed} passed · ${state.neos.length - passed} still approaching`;

    const upcoming = state.neos.filter((n) => n.tca > t && (state.filter === 'all' || n.hazardous));
    const next = upcoming.length ? minBy(upcoming, (n) => n.tca) : null;
    const nextTile = $('[data-live-next]', els.stats);
    if (nextTile) {
      const value = $('[data-live="next-value"]', nextTile);
      const sub = $('[data-live="next-sub"]', nextTile);
      if (next) {
        nextTile.dataset.id = next.id;
        value.textContent = fmt.relative(next.tca, t).replace(/^in /, '');
        sub.textContent = `${next.label} · ${fmt.ld(next.missLD)} LD at ${fmt.clock(next.tca)}`;
      } else {
        delete nextTile.dataset.id;
        value.textContent = 'All passed';
        sub.textContent = 'Every flyby for this day is done';
      }
    }
  }

  const n = state.byId.get(state.selectedId);
  if (n && !els.detailView.hidden) {
    const rel = $('[data-live="ca-rel"]', els.detailView);
    const label = $('[data-live="ca-label"]', els.detailView);
    const nowLd = $('[data-live="now-ld"]', els.detailView);
    const nowKm = $('[data-live="now-km"]', els.detailView);
    const dist = Math.hypot(...n.posAt(t));
    if (rel) {
      const past = n.tca <= t;
      label.textContent = past ? 'Closest approach was' : 'Closest approach';
      rel.textContent = fmt.relative(n.tca, t);
    }
    if (nowLd) nowLd.textContent = fmt.ld(dist / LD_KM);
    if (nowKm) nowKm.textContent = `${fmt.km(dist)} from Earth`;
    updateOrbitDiagram($('#orbitWrap'), n, t);
  }

  if (state.hoverId && !els.tooltip.hidden) {
    const hovered = state.byId.get(state.hoverId);
    const dd = $('.tt-grid dd', els.tooltip);
    if (hovered && dd) dd.textContent = `${fmt.ld(Math.hypot(...hovered.posAt(t)) / LD_KM)} LD`;
  }

  const nowMs = Date.now();
  const showNow = nowMs >= state.dayStart && nowMs < state.dayEnd;
  els.nowMarker.hidden = !showNow;
  if (showNow) els.nowMarker.style.left = `${((nowMs - state.dayStart) / (state.dayEnd - state.dayStart)) * 100}%`;
}

/* ------------------------------------------------------------ timeline */

let lastLiveUpdate = 0;
let lastClock = '';

function tick(dt) {
  if (state.live) {
    state.time = Date.now();
    if (state.time >= state.dayEnd) {
      goToDay(state.time);
      return;
    }
  } else if (state.playing && !state.scrubbing) {
    state.time += dt * 1000 * state.speed;
    if (state.time >= state.dayEnd) state.time = state.dayStart;
  }
  scene.setTime(state.time);
  updatePlayhead();
  const now = performance.now();
  if (now - lastLiveUpdate > 250) {
    lastLiveUpdate = now;
    updateLive();
  }
}

function updatePlayhead() {
  const span = state.dayEnd - state.dayStart;
  const pct = Math.min(100, Math.max(0, ((state.time - state.dayStart) / span) * 100));
  els.head.style.left = `${pct}%`;
  els.progress.style.width = `${pct}%`;
  const clock = fmt.clock(state.time, true);
  if (clock !== lastClock) {
    lastClock = clock;
    els.tlTime.textContent = clock;
    els.track.setAttribute('aria-valuenow', String(Math.round(pct)));
    els.track.setAttribute('aria-valuetext', clock);
  }
}

function renderHours() {
  const span = state.dayEnd - state.dayStart;
  let html = '';
  for (let h = 0; h <= 24; h += 3) {
    const d = new Date(state.dayStart);
    d.setHours(h);
    const pct = ((d.getTime() - state.dayStart) / span) * 100;
    html += `<span class="${h % 6 === 0 ? 'major' : ''}" style="left:${pct}%">${h < 24 ? fmt.hourLabel(d.getTime()) : ''}</span>`;
  }
  els.hours.innerHTML = html;
  els.tlDate.textContent = fmt.dayLabel(state.dayStart);
  els.tlTz.textContent = fmt.tzName();
}

function renderTicks() {
  const span = state.dayEnd - state.dayStart;
  els.ticks.innerHTML = state.neos
    .filter((n) => state.filter === 'all' || n.hazardous)
    .map((n) => {
      const pct = ((n.tca - state.dayStart) / span) * 100;
      return `<button class="tick${n.hazardous ? ' is-hazard' : ''}" data-id="${n.id}" style="left:${pct}%" aria-label="${esc(n.label)}, closest approach at ${fmt.clock(n.tca)}"></button>`;
    })
    .join('');
  syncHighlights();
}

els.ticks.addEventListener('click', (e) => {
  const tick = e.target.closest('.tick');
  if (!tick) return;
  const n = state.byId.get(tick.dataset.id);
  if (!n) return;
  state.live = false;
  state.time = n.tca;
  renderPlayState();
  select(n.id);
});
els.ticks.addEventListener('pointerover', (e) => {
  const tick = e.target.closest('.tick');
  if (!tick) return;
  const r = tick.getBoundingClientRect();
  setHover(tick.dataset.id, { x: r.left + r.width / 2, y: r.top, source: 'tick' });
});
els.ticks.addEventListener('pointerout', (e) => {
  if (e.target.closest('.tick')) setHover(null);
});

function scrubTo(clientX) {
  const r = els.track.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  state.time = state.dayStart + f * (state.dayEnd - state.dayStart);
  if (state.live) {
    state.live = false;
    state.playing = false;
  }
  renderPlayState();
  scene.setTime(state.time);
  updatePlayhead();
  updateLive();
}

els.track.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.tick')) return;
  state.scrubbing = true;
  els.track.setPointerCapture(e.pointerId);
  els.track.classList.add('is-scrubbing');
  scrubTo(e.clientX);
});
els.track.addEventListener('pointermove', (e) => {
  if (state.scrubbing) scrubTo(e.clientX);
});
const endScrub = () => {
  state.scrubbing = false;
  els.track.classList.remove('is-scrubbing');
};
els.track.addEventListener('pointerup', endScrub);
els.track.addEventListener('pointercancel', endScrub);
els.track.addEventListener('keydown', (e) => {
  const step = (e.shiftKey ? 60 : 15) * 60e3;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  state.live = false;
  state.time = Math.min(state.dayEnd - 1, Math.max(state.dayStart, state.time + (e.key === 'ArrowRight' ? step : -step)));
  renderPlayState();
  updateLive();
});

function renderSpeeds() {
  els.speeds.innerHTML = SPEEDS.map((s) => `<button role="radio" data-mult="${s.mult}" title="${s.title}">${s.label}</button>`).join('');
}

function renderPlayState() {
  els.playBtn.innerHTML = icon(state.playing ? 'pause' : 'play');
  els.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  $$('button', els.speeds).forEach((b) => {
    const on = +b.dataset.mult === state.speed;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  els.liveBtn.classList.toggle('is-live', state.live);
  els.liveBtn.title = isToday() ? 'Jump to the current moment' : 'Go to today, live';
  const speed = SPEEDS.find((s) => s.mult === state.speed);
  els.tlMode.textContent = state.live ? 'Live' : state.playing ? `Playback · ${speed?.label ?? ''}` : 'Paused';
  els.tlMode.dataset.mode = state.live ? 'live' : state.playing ? 'play' : 'paused';
}

els.playBtn.addEventListener('click', togglePlay);

function togglePlay() {
  if (state.playing) {
    state.playing = false;
    state.live = false;
  } else {
    state.playing = true;
    if (state.time >= state.dayEnd - 60e3) state.time = state.dayStart;
  }
  renderPlayState();
}

els.speeds.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const mult = +b.dataset.mult;
  const stayLive = state.live && mult === 1;
  state.speed = mult;
  state.playing = true;
  state.live = stayLive;
  renderPlayState();
});

els.liveBtn.addEventListener('click', () => {
  if (!isToday()) {
    goToDay(Date.now());
    return;
  }
  Object.assign(state, { live: true, playing: true, speed: 1, time: Date.now() });
  renderPlayState();
});

/* ------------------------------------------------------------ date nav */

function renderDateNav() {
  els.dateLabel.textContent = fmt.dayLabel(state.dayStart);
  const today = startOfDay(Date.now());
  const diff = Math.round((state.dayStart - today) / 86400e3);
  els.dateHint.textContent = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : diff === 1 ? 'Tomorrow' : String(new Date(state.dayStart).getFullYear());
  els.dateHint.dataset.today = String(diff === 0);
  els.dateInput.value = fmt.isoDate(state.dayStart);
  $('#todayBtn').disabled = diff === 0;
  updateHash();
}

$('#prevDay').addEventListener('click', () => goToDay(addDays(state.dayStart, -1)));
$('#nextDay').addEventListener('click', () => goToDay(addDays(state.dayStart, 1)));
$('#todayBtn').addEventListener('click', () => goToDay(Date.now()));
$('.date-pill').addEventListener('click', (e) => {
  if (e.target === els.dateInput) return;
  e.preventDefault();
  try {
    els.dateInput.showPicker();
  } catch {
    els.dateInput.focus();
  }
});
els.dateInput.addEventListener('change', () => {
  const [y, m, d] = els.dateInput.value.split('-').map(Number);
  if (y && m && d) goToDay(new Date(y, m - 1, d).getTime());
});

/* ------------------------------------------------------------ scene tools */

function setToolPressed(btn, on) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
}

$('#resetView').addEventListener('click', () => scene.resetView());
$('#toggleLabels').addEventListener('click', (e) => {
  const on = !scene.showLabels;
  scene.setLabelsVisible(on);
  setToolPressed(e.currentTarget, on);
});
$('#toggleTrails').addEventListener('click', (e) => {
  const on = !scene.showTrails;
  scene.setTrailsVisible(on);
  setToolPressed(e.currentTarget, on);
});
$('#toggleRotate').addEventListener('click', (e) => {
  const on = !scene.controls.autoRotate;
  scene.setAutoRotate(on);
  setToolPressed(e.currentTarget, on);
});

/* ------------------------------------------------------------ keyboard & hash */

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (e.key === 'Escape' && state.selectedId) {
    select(null);
    scene.resetView();
  } else if (e.key === ' ' && !typing && tag !== 'BUTTON') {
    e.preventDefault();
    togglePlay();
  } else if ((e.key === '[' || e.key === ']') && !typing) {
    goToDay(addDays(state.dayStart, e.key === ']' ? 1 : -1));
  }
});

function updateHash() {
  const params = new URLSearchParams();
  if (!isToday()) params.set('date', fmt.isoDate(state.dayStart));
  if (state.selectedId) params.set('neo', state.selectedId);
  const hashStr = params.toString();
  const url = `${location.pathname}${location.search}${hashStr ? `#${hashStr}` : ''}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const date = params.get('date');
  let day = Date.now();
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    day = new Date(y, m - 1, d).getTime();
  }
  return { day, neo: params.get('neo') };
}

/* ------------------------------------------------------------ first-run hint */

function showHint() {
  let seen = false;
  try {
    seen = localStorage.getItem('neowatch.hintSeen') === '1';
    localStorage.setItem('neowatch.hintSeen', '1');
  } catch {
    /* ignore */
  }
  if (seen) return;
  const hint = document.createElement('div');
  hint.className = 'hint glass-lite';
  hint.textContent = 'Drag to orbit · scroll to zoom · click an asteroid for details';
  $('.stage').appendChild(hint);
  setTimeout(() => hint.classList.add('is-out'), 7000);
  setTimeout(() => hint.remove(), 8000);
}

/* ------------------------------------------------------------ boot */

renderSpeeds();
const initial = readHash();
goToDay(initial.day, { selectId: initial.neo });
showHint();
