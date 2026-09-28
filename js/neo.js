// Turns a raw NeoWs record into the model the dashboard and 3D scene use,
// including a geocentric trajectory function posAt(ms) → [x, y, z] km.

import { AU_KM, LD_KM, jdFromMs, parseElements, positionAt, earthHelio } from './astro.js';
import { shortName } from './format.js';

export function buildNeo(raw) {
  const ca = raw.close_approach_data?.[0];
  if (!ca) return null;
  const dm = raw.estimated_diameter?.meters ?? {};
  const dMin = +dm.estimated_diameter_min || 0;
  const dMax = +dm.estimated_diameter_max || 0;
  const missKm = +ca.miss_distance.kilometers;

  const neo = {
    id: raw.id,
    name: raw.name,
    label: shortName(raw.name),
    hazardous: !!raw.is_potentially_hazardous_asteroid,
    sentry: !!raw.is_sentry_object,
    H: raw.absolute_magnitude_h,
    dMin,
    dMax,
    dMean: Math.sqrt(dMin * dMax) || dMax,
    tca: ca.epoch_date_close_approach,
    missKm,
    missLD: missKm / LD_KM,
    missAU: +ca.miss_distance.astronomical,
    speedKms: +ca.relative_velocity.kilometers_per_second,
    speedKmh: +ca.relative_velocity.kilometers_per_hour,
    orbit: raw.orbital_data ?? null,
    elements: parseElements(raw.orbital_data),
    jplUrl: raw.nasa_jpl_url,
  };
  neo.posAt = trajectory(neo);
  return neo;
}

function trajectory(neo) {
  const el = neo.elements;
  if (el) {
    const kepler = (ms) => {
      const jd = jdFromMs(ms);
      const a = positionAt(el, jd);
      const e = earthHelio(jd);
      return [(a[0] - e[0]) * AU_KM, (a[1] - e[1]) * AU_KM, (a[2] - e[2]) * AU_KM];
    };
    const r0 = kepler(neo.tca);
    const d0 = Math.hypot(...r0);
    const dir = r0.map((c) => c / d0);

    // Two-body propagation normally lands within ~0.1% of NASA's miss
    // distance. Nudge the path by a constant offset so closest approach
    // matches NASA exactly.
    if (Math.abs(d0 - neo.missKm) < 0.35 * neo.missKm) {
      const off = dir.map((c) => c * (neo.missKm - d0));
      return (ms) => {
        const r = kepler(ms);
        return [r[0] + off[0], r[1] + off[1], r[2] + off[2]];
      };
    }

    // Very close flybys are bent by Earth's gravity, which a two-body model
    // misses. Keep the real direction but fly a straight line past Earth.
    const r1 = kepler(neo.tca + 60e3);
    const vel = r1.map((c, i) => c - r0[i]);
    return straightLine(neo, dir, perpendicular(vel, dir));
  }

  // No orbit data: pick a stable pseudo-random geometry from the id.
  const rand = mulberry32(hash(neo.id));
  const z = (rand() * 2 - 1) * 0.5;
  const phi = rand() * Math.PI * 2;
  const dir = normalize([Math.cos(phi), Math.sin(phi), z]);
  return straightLine(neo, dir, perpendicular([rand() - 0.5, rand() - 0.5, rand() - 0.5], dir));
}

function straightLine(neo, dir, vel) {
  return (ms) => {
    const s = (neo.speedKms * (ms - neo.tca)) / 1000;
    return [
      dir[0] * neo.missKm + vel[0] * s,
      dir[1] * neo.missKm + vel[1] * s,
      dir[2] * neo.missKm + vel[2] * s,
    ];
  };
}

function normalize(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
}

function perpendicular(v, dir) {
  const dot = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
  return normalize(v.map((c, i) => c - dot * dir[i]));
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
