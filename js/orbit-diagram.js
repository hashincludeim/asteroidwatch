// Top-down, Sun-centred SVG of an asteroid's orbit against the inner planets.

import { orbitPoint, positionAt, earthHelio, earthElements, jdFromMs } from './astro.js';

const SIZE = 300;
const C = SIZE / 2;
const R = 132;
const PLANETS = [
  { name: 'Mercury', a: 0.387 },
  { name: 'Venus', a: 0.723 },
  { name: 'Mars', a: 1.524 },
  { name: 'Jupiter', a: 5.203 },
];

export function renderOrbitDiagram(neo, timeMs) {
  const el = neo.elements;
  if (!el) return '<p class="orbit-missing">Orbit data isn\'t available for this object.</p>';

  const aphelion = el.a * (1 + el.e);
  const extent = Math.max(aphelion, 1.1) * 1.06;
  const k = R / extent;
  const P = (v) => `${(C + v[0] * k).toFixed(1)},${(C - v[1] * k).toFixed(1)}`;

  // Split the orbit into runs above / below Earth's orbital plane.
  const runs = [];
  let current = null;
  for (let j = 0; j <= 360; j++) {
    const p = orbitPoint(el, (j / 360) * Math.PI * 2);
    const above = p[2] >= 0;
    if (!current || current.above !== above) {
      if (current) current.pts.push(P(p));
      current = { above, pts: [] };
      runs.push(current);
    }
    current.pts.push(P(p));
  }
  const orbitPaths = runs
    .map((r) => `<polyline class="od-neo-orbit${r.above ? '' : ' below'}" points="${r.pts.join(' ')}"/>`)
    .join('');

  const jd = jdFromMs(timeMs);
  const earthEl = earthElements(jd);
  const earthPts = [];
  for (let j = 0; j <= 180; j++) earthPts.push(P(orbitPoint(earthEl, (j / 180) * Math.PI * 2)));

  const planets = PLANETS.filter((p) => p.a < extent)
    .map((p) => `<circle class="od-planet-orbit" cx="${C}" cy="${C}" r="${(p.a * k).toFixed(1)}"/>
      <text class="od-planet-label" x="${C}" y="${(C - p.a * k - 4).toFixed(1)}">${p.name}</text>`)
    .join('');

  const auPx = k;
  const tone = neo.hazardous ? 'hazard' : 'safe';

  return `
  <svg class="orbit-svg tone-${tone}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Orbit of ${neo.label} around the Sun compared with Earth's orbit">
    <defs>
      <radialGradient id="od-sun" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fff7e0"/>
        <stop offset="35%" stop-color="#ffd27a" stop-opacity=".9"/>
        <stop offset="100%" stop-color="#ff9a3c" stop-opacity="0"/>
      </radialGradient>
    </defs>
    ${planets}
    <polyline class="od-earth-orbit" points="${earthPts.join(' ')}"/>
    ${orbitPaths}
    <circle cx="${C}" cy="${C}" r="16" fill="url(#od-sun)"/>
    <circle cx="${C}" cy="${C}" r="4" fill="#fff4d6"/>
    <g class="od-marker od-earth" data-od="earth"><circle r="8" class="halo"/><circle r="4.2"/><text x="9" y="-7">Earth</text></g>
    <g class="od-marker od-neo" data-od="neo"><circle r="8" class="halo"/><circle r="3.6"/></g>
    <g class="od-scale" transform="translate(14 ${SIZE - 14})">
      <line x1="0" y1="0" x2="${auPx.toFixed(1)}" y2="0"/>
      <line x1="0" y1="-3" x2="0" y2="3"/><line x1="${auPx.toFixed(1)}" y1="-3" x2="${auPx.toFixed(1)}" y2="3"/>
      <text x="${(auPx / 2).toFixed(1)}" y="-6">1 AU</text>
    </g>
  </svg>`;
}

/** Move the Earth and asteroid markers to their positions at timeMs. */
export function updateOrbitDiagram(root, neo, timeMs) {
  const el = neo.elements;
  const svg = root?.querySelector('.orbit-svg');
  if (!el || !svg) return;
  const aphelion = el.a * (1 + el.e);
  const k = R / (Math.max(aphelion, 1.1) * 1.06);
  const jd = jdFromMs(timeMs);
  const place = (sel, v) => {
    const g = svg.querySelector(sel);
    if (g) g.setAttribute('transform', `translate(${(C + v[0] * k).toFixed(1)} ${(C - v[1] * k).toFixed(1)})`);
  };
  place('[data-od="earth"]', earthHelio(jd));
  place('[data-od="neo"]', positionAt(el, jd));
}
