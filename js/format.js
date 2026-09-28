// Formatting helpers shared by the dashboard UI.

const formatters = new Map();
function numberFormat(digits) {
  if (!formatters.has(digits)) {
    formatters.set(digits, new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  }
  return formatters.get(digits);
}

export const num = (value, digits = 0) => numberFormat(digits).format(value);

export const ld = (v) => num(v, v < 1 ? 3 : v < 10 ? 2 : 1);

export function km(v) {
  if (v >= 1e6) return `${num(v / 1e6, 2)}M km`;
  return `${num(v)} km`;
}

export function meters(v) {
  if (v >= 1000) return `${num(v / 1000, 2)} km`;
  return `${num(v)} m`;
}

export function diameterRange(min, max) {
  if (max >= 1000) return `${num(min / 1000, 2)}–${num(max / 1000, 2)} km`;
  return `${num(min)}–${num(max)} m`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const clockSecFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const clock = (ms, seconds = false) => (seconds ? clockSecFmt : clockFmt).format(ms);
export const hourLabel = (ms) => hourFmt.format(ms);
export const dayLabel = (ms) => dayFmt.format(ms);
export const dayLong = (ms) => dayYearFmt.format(ms);
export const fullDate = (ms) => fullFmt.format(ms);

export function tzName() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** "in 3h 12m" / "3h 12m ago" / "now" */
export function relative(target, now) {
  const diff = target - now;
  const abs = Math.abs(diff);
  if (abs < 60e3) return 'now';
  const totalMin = Math.floor(abs / 60e3);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = Math.floor(h / 24);
  const body = d >= 1 ? `${d}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
  return diff > 0 ? `in ${body}` : `${body} ago`;
}

/** Short display name: "433 Eros (A898 PA)" → "Eros", "(2004 TB10)" → "2004 TB10". */
export function shortName(name) {
  const named = name.match(/^\d+\s+([^(]+?)\s*\(/);
  if (named && /[a-z]/i.test(named[1])) return named[1];
  const inner = name.match(/\(([^)]+)\)/);
  return inner ? inner[1] : name.trim();
}

const SIZE_REFS = [
  { name: 'a school bus', m: 12 },
  { name: 'a blue whale', m: 30 },
  { name: 'a Boeing 747', m: 70 },
  { name: 'the Statue of Liberty', m: 93 },
  { name: 'the Great Pyramid of Giza', m: 139 },
  { name: 'the Eiffel Tower', m: 330 },
  { name: 'the Empire State Building', m: 443 },
  { name: 'the Burj Khalifa', m: 828 },
  { name: 'the Golden Gate Bridge span', m: 1280 },
  { name: 'Mount Fuji', m: 3776 },
  { name: 'Mount Everest', m: 8849 },
];

/** The landmark closest in size (log scale) plus a friendly sentence. */
export function sizeComparison(dM) {
  let ref = SIZE_REFS[0];
  for (const r of SIZE_REFS) {
    if (Math.abs(Math.log(dM / r.m)) < Math.abs(Math.log(dM / ref.m))) ref = r;
  }
  const ratio = dM / ref.m;
  let text;
  if (ratio > 0.85 && ratio < 1.18) text = `About the size of ${ref.name}`;
  else text = `About ${num(ratio, 1)}× the size of ${ref.name}`;
  return { ref, ratio, text };
}

/** Kinetic energy for a hypothetical impact, assuming a rocky 2.6 g/cm³ body. */
export function impactEnergy(dM, vKms) {
  const mass = 2600 * (Math.PI / 6) * dM ** 3;
  const joules = 0.5 * mass * (vKms * 1000) ** 2;
  const mt = joules / 4.184e15;
  if (mt < 1) return `${num(mt * 1000, mt < 0.01 ? 1 : 0)} kilotons`;
  if (mt < 1000) return `${num(mt, mt < 10 ? 1 : 0)} megatons`;
  return `${num(mt / 1000, 1)} gigatons`;
}

export function isoDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
