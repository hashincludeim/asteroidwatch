// NASA NeoWs client with a small localStorage cache, so every fetched day is
// kept and reused instead of spending another request.

import { NASA_API_KEY } from './config.js';

const FEED_URL = 'https://api.nasa.gov/neo/rest/v1/feed';
const CACHE_PREFIX = 'neowatch.feed.v1.';
const MAX_CACHE_ENTRIES = 30;
const FRESH_MS = 3 * 3600e3;

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'rate' | 'key' | 'network' | 'http'
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readCache(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  const store = storage();
  if (!store) return;
  const payload = JSON.stringify(value);
  try {
    store.setItem(key, payload);
  } catch {
    // Quota exceeded: drop every cached day and try once more.
    try {
      cacheKeys().forEach((k) => store.removeItem(k));
      store.setItem(key, payload);
    } catch {
      /* give up silently — the app still works uncached */
    }
  }
  pruneCache();
}

function cacheKeys() {
  const store = storage();
  if (!store) return [];
  const keys = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  return keys;
}

function pruneCache() {
  try {
    const entries = cacheKeys().map((k) => [k, readCache(k)?.fetchedAt ?? 0]);
    if (entries.length <= MAX_CACHE_ENTRIES) return;
    entries.sort((a, b) => a[1] - b[1]);
    entries.slice(0, entries.length - MAX_CACHE_ENTRIES).forEach(([k]) => storage()?.removeItem(k));
  } catch {
    /* ignore */
  }
}

const isoUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

function slim(neo) {
  // Drop link blobs we never use to keep the cache small.
  const { links, ...rest } = neo;
  return rest;
}

/**
 * Every close approach whose UTC feed date overlaps [startMs, endMs).
 * A local calendar day can straddle two UTC dates, so this asks for a range
 * in a single request (the feed allows up to 7 days).
 */
export async function fetchWindow(startMs, endMs, { force = false } = {}) {
  const startDate = isoUTC(startMs);
  const endDate = isoUTC(endMs - 1);
  const cacheKey = `${CACHE_PREFIX}${startDate}_${endDate}`;
  const cached = readCache(cacheKey);
  const settled = endMs < Date.now() - 86400e3; // past days won't change
  const fresh = cached && (settled || Date.now() - cached.fetchedAt < FRESH_MS);

  if (cached && fresh && !force) return { ...cached, fromCache: true };

  const url = `${FEED_URL}?start_date=${startDate}&end_date=${endDate}&detailed=true&api_key=${encodeURIComponent(NASA_API_KEY)}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    if (cached) return { ...cached, fromCache: true, stale: true };
    throw new ApiError('network', "Couldn't reach NASA's servers. Check your connection and try again.");
  }

  if (!res.ok) {
    if (cached) return { ...cached, fromCache: true, stale: true };
    if (res.status === 429) {
      throw new ApiError('rate', 'Your API key has hit its rate limit. Try again in a little while.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('key', 'NASA rejected the API key in js/config.js. Double-check it.');
    }
    throw new ApiError('http', `NASA's API returned an error (HTTP ${res.status}).`);
  }

  const json = await res.json();
  const neos = Object.values(json.near_earth_objects ?? {}).flat().map(slim);
  const entry = { fetchedAt: Date.now(), neos };
  writeCache(cacheKey, entry);
  return { ...entry, fromCache: false };
}
