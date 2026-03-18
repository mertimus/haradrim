import {
  CACHE_MAX_ENTRIES,
  CACHE_MAX_METADATA_ENTRIES,
  CACHE_MAX_PROXY_ENTRIES,
} from "./config.mjs";

const DEFAULT_BUCKET = "default";
const bucketConfigs = new Map([
  [DEFAULT_BUCKET, { maxEntries: CACHE_MAX_ENTRIES }],
  ["metadata", { maxEntries: CACHE_MAX_METADATA_ENTRIES }],
  ["proxy", { maxEntries: CACHE_MAX_PROXY_ENTRIES }],
]);
const cacheBuckets = new Map(
  [...bucketConfigs.keys()].map((bucketName) => [bucketName, new Map()]),
);
const inflight = new Map();

function resolveBucketName(options) {
  if (typeof options === "string" && options) return options;
  if (options?.bucket && bucketConfigs.has(options.bucket)) return options.bucket;
  return DEFAULT_BUCKET;
}

function getBucket(bucketName) {
  const bucket = cacheBuckets.get(bucketName);
  if (bucket) return bucket;
  const next = new Map();
  cacheBuckets.set(bucketName, next);
  return next;
}

function pruneBucket(bucketName, now = Date.now()) {
  const bucket = getBucket(bucketName);
  for (const [key, entry] of bucket) {
    if (entry.expiresAt <= now) bucket.delete(key);
  }
  const maxEntries = bucketConfigs.get(bucketName)?.maxEntries ?? CACHE_MAX_ENTRIES;
  while (bucket.size > maxEntries) {
    const firstKey = bucket.keys().next().value;
    if (!firstKey) break;
    bucket.delete(firstKey);
  }
}

function pruneAllBuckets(now = Date.now()) {
  for (const bucketName of cacheBuckets.keys()) {
    pruneBucket(bucketName, now);
  }
}

function touchCacheEntry(bucketName, key, entry) {
  const bucket = getBucket(bucketName);
  bucket.delete(key);
  bucket.set(key, entry);
}

export function getCacheSize(options) {
  const bucketName = options == null ? null : resolveBucketName(options);
  if (bucketName) {
    pruneBucket(bucketName);
    return getBucket(bucketName).size;
  }

  pruneAllBuckets();
  let total = 0;
  for (const bucket of cacheBuckets.values()) {
    total += bucket.size;
  }
  return total;
}

export function getCacheStats() {
  pruneAllBuckets();
  const buckets = {};
  let totalEntries = 0;

  for (const [bucketName, bucket] of cacheBuckets.entries()) {
    const size = bucket.size;
    buckets[bucketName] = size;
    totalEntries += size;
  }

  return {
    totalEntries,
    buckets,
  };
}

export function clearCache(options) {
  const bucketName = options == null ? null : resolveBucketName(options);
  if (bucketName) {
    getBucket(bucketName).clear();
  } else {
    for (const bucket of cacheBuckets.values()) {
      bucket.clear();
    }
  }
  inflight.clear();
}

export function getCachedValue(key, options) {
  const bucketName = resolveBucketName(options);
  const bucket = getBucket(bucketName);
  const entry = bucket.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    bucket.delete(key);
    return null;
  }
  touchCacheEntry(bucketName, key, entry);
  return entry.value;
}

export function getInflightValue(key) {
  return inflight.get(key) ?? null;
}

export function setCachedValue(key, value, ttlMs, options) {
  if (ttlMs <= 0) return;
  const bucketName = resolveBucketName(options);
  const bucket = getBucket(bucketName);
  pruneBucket(bucketName);
  const entry = {
    value,
    expiresAt: Date.now() + ttlMs,
  };
  if (bucket.has(key)) {
    bucket.delete(key);
  }
  bucket.set(key, entry);
  pruneBucket(bucketName);
}

export async function cachedValue(key, ttlMs, loader, options) {
  const hit = getCachedValue(key, options);
  if (hit !== null) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (value !== null && value !== undefined) {
        setCachedValue(key, value, ttlMs, options);
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
