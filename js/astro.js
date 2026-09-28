// Lightweight orbital mechanics — enough precision to place near-Earth
// asteroids around Earth for visualisation. Everything is heliocentric or
// geocentric ecliptic J2000 unless noted otherwise.

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export const AU_KM = 149597870.7;
export const LD_KM = 384400;
export const EARTH_RADIUS_KM = 6371;
export const OBLIQUITY = 23.4392911 * DEG;
const EARTH_MOON_MASS_RATIO = 81.30056;

export const jdFromMs = (ms) => ms / 86400000 + 2440587.5;

function solveKepler(M, e) {
  M = ((M % TAU) + TAU) % TAU;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 40; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Point on an orbit for eccentric anomaly E, in the ecliptic frame (AU). */
export function orbitPoint(el, E) {
  const { a, e, i, node, peri } = el;
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(node), sO = Math.sin(node);
  const cw = Math.cos(peri), sw = Math.sin(peri);
  const ci = Math.cos(i), si = Math.sin(i);
  return [
    (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
    (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

/** Heliocentric position (AU) of a body with the given elements at Julian date jd. */
export function positionAt(el, jd) {
  const M = el.M0 + el.n * (jd - el.epoch);
  return orbitPoint(el, solveKepler(M, el.e));
}

/** Convert NeoWs `orbital_data` into radians/day elements, or null if unusable. */
export function parseElements(od) {
  if (!od) return null;
  const el = {
    a: +od.semi_major_axis,
    e: +od.eccentricity,
    i: +od.inclination * DEG,
    node: +od.ascending_node_longitude * DEG,
    peri: +od.perihelion_argument * DEG,
    M0: +od.mean_anomaly * DEG,
    n: +od.mean_motion * DEG,
    epoch: +od.epoch_osculation,
  };
  const valid = Object.values(el).every(Number.isFinite) && el.e >= 0 && el.e < 1 && el.a > 0;
  return valid ? el : null;
}

/** Earth–Moon barycentre elements (JPL/Standish approximation, valid 1800–2050). */
export function earthElements(jd) {
  const T = (jd - 2451545) / 36525;
  const lonPeri = (102.93768193 + 0.32327364 * T) * DEG;
  const meanLon = (100.46457166 + 35999.37244981 * T) * DEG;
  return {
    a: 1.00000261 + 0.00000562 * T,
    e: 0.01671123 - 0.00004392 * T,
    i: (-0.00001531 - 0.01294668 * T) * DEG,
    node: 0,
    peri: lonPeri,
    M0: meanLon - lonPeri,
    n: 0,
    epoch: jd,
  };
}

/** Low-precision geocentric Moon position in km (Astronomical Almanac series, ~0.3°). */
export function moonGeoKm(jd) {
  const T = (jd - 2451545) / 36525;
  const s = (d) => Math.sin(d * DEG);
  const c = (d) => Math.cos(d * DEG);
  const lon = 218.32 + 481267.881 * T
    + 6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T)
    + 0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T)
    - 0.19 * s(357.5 + 35999.05 * T) - 0.11 * s(186.5 + 966404.03 * T);
  const lat = 5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T)
    - 0.28 * s(318.3 + 6003.15 * T) - 0.17 * s(217.6 - 407332.21 * T);
  const parallax = 0.9508 + 0.0518 * c(135.0 + 477198.87 * T) + 0.0095 * c(259.3 - 413335.36 * T)
    + 0.0078 * c(235.7 + 890534.22 * T) + 0.0028 * c(269.9 + 954397.74 * T);
  const r = 6378.14 / Math.sin(parallax * DEG);
  return [r * c(lat) * c(lon), r * c(lat) * s(lon), r * s(lat)];
}

/** Heliocentric Earth position (AU), corrected from the barycentre using the Moon. */
export function earthHelio(jd) {
  const emb = positionAt(earthElements(jd), jd);
  const moon = moonGeoKm(jd);
  const f = 1 / (1 + EARTH_MOON_MASS_RATIO) / AU_KM;
  return [emb[0] - moon[0] * f, emb[1] - moon[1] * f, emb[2] - moon[2] * f];
}

/** Greenwich mean sidereal time in radians. */
export function gmst(jd) {
  const deg = 280.46061837 + 360.98564736629 * (jd - 2451545);
  return (((deg % 360) + 360) % 360) * DEG;
}
