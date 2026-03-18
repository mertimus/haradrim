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

function touchCacheEntry(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

export function getCacheSize() {
  pruneCache();
  return cache.size;
}

export function clearCache() {
  cache.clear();
  inflight.clear();
}

export function getCachedValue(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  touchCacheEntry(key, entry);
  return entry.value;
}

export function getInflightValue(key) {
  return inflight.get(key) ?? null;
}

export function setCachedValue(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  pruneCache();
  const entry = {
    value,
    expiresAt: Date.now() + ttlMs,
  };
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);
  pruneCache();
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

export async function withInflightValue(key, loader) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(loader)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}
