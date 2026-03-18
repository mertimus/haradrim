// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_MAX_ENTRIES,
  CACHE_MAX_METADATA_ENTRIES,
} from "../../backend/src/config.mjs";
import {
  clearCache,
  getCacheSize,
  getCachedValue,
  setCachedValue,
} from "../../backend/src/cache.mjs";

const TTL_MS = 60_000;

describe("cache", () => {
  afterEach(() => {
    clearCache();
  });

  it("keeps recently accessed entries when pruning over capacity", () => {
    setCachedValue("hot", "value", TTL_MS);
    for (let index = 0; index < CACHE_MAX_ENTRIES - 1; index += 1) {
      setCachedValue(`seed:${index}`, index, TTL_MS);
    }

    expect(getCacheSize()).toBe(CACHE_MAX_ENTRIES);
    expect(getCachedValue("hot")).toBe("value");

    setCachedValue("overflow", "next", TTL_MS);

    expect(getCacheSize()).toBe(CACHE_MAX_ENTRIES);
    expect(getCachedValue("hot")).toBe("value");
    expect(getCachedValue("seed:0")).toBeNull();
    expect(getCachedValue("overflow")).toBe("next");
  });

  it("does not let metadata churn evict default cache entries", () => {
    setCachedValue("trace-result", { ok: true }, TTL_MS);

    for (let index = 0; index < CACHE_MAX_METADATA_ENTRIES + 1; index += 1) {
      setCachedValue(`meta:${index}`, index, TTL_MS, { bucket: "metadata" });
    }

    expect(getCachedValue("trace-result")).toEqual({ ok: true });
    expect(getCacheSize({ bucket: "metadata" })).toBe(CACHE_MAX_METADATA_ENTRIES);
    expect(getCachedValue("meta:0", { bucket: "metadata" })).toBeNull();
  });
});
