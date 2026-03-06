// ---- localStorage cache ----

const CACHE_PREFIX = "haradrim:";
const MAX_PERSISTED_CACHE_CHARS = 250_000;
const memoryCache = new Map<string, CacheEntry<unknown>>();

interface CacheEntry<T> {
  data: T;
  ts: number;
}

export function cacheGet<T>(key: string, ttlMs: number): T | null {
  const memoryEntry = memoryCache.get(CACHE_PREFIX + key) as CacheEntry<T> | undefined;
  if (memoryEntry) {
    if (Date.now() - memoryEntry.ts > ttlMs) {
      memoryCache.delete(CACHE_PREFIX + key);
    } else {
      return memoryEntry.data;
    }
  }

  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.ts > ttlMs) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = { data, ts: Date.now() };
  memoryCache.set(CACHE_PREFIX + key, entry);

  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length > MAX_PERSISTED_CACHE_CHARS) return;
    localStorage.setItem(CACHE_PREFIX + key, serialized);
  } catch {
    // storage full — evict oldest entries
    try {
      const keys: { key: string; ts: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(CACHE_PREFIX)) {
          const raw = localStorage.getItem(k);
          if (raw) {
            const e = JSON.parse(raw);
            keys.push({ key: k, ts: e.ts ?? 0 });
          }
        }
      }
      keys.sort((a, b) => a.ts - b.ts);
      for (const k of keys.slice(0, Math.ceil(keys.length / 2))) {
        localStorage.removeItem(k.key);
      }
      const serialized = JSON.stringify(entry);
      if (serialized.length > MAX_PERSISTED_CACHE_CHARS) return;
      localStorage.setItem(CACHE_PREFIX + key, serialized);
    } catch {
      // give up
    }
  }
}

/** Cache-through wrapper for async functions keyed by a single string */
export async function cached<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cacheKey = `${namespace}:${key}`;
  const hit = cacheGet<T>(cacheKey, ttlMs);
  if (hit !== null) return hit;
  const data = await fetcher();
  if (data !== null && data !== undefined && !(Array.isArray(data) && data.length === 0)) {
    cacheSet(cacheKey, data);
  }
  return data;
}
