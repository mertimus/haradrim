import { CACHE_MAX_ENTRIES } from "./config.mjs";

const cache = new Map();
const inflight = new Map();

function pruneCache(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

export function getCacheSize() {
  pruneCache();
  return cache.size;
}

export function getCachedValue(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedValue(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  pruneCache();
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export async function cachedValue(key, ttlMs, loader) {
  const hit = getCachedValue(key);
  if (hit !== null) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (value !== null && value !== undefined) {
        setCachedValue(key, value, ttlMs);
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}
