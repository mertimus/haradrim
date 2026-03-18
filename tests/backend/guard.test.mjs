// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  getTraceAnalysisPolicy,
  HEAVY_ROUTE_POLICIES,
  withConcurrencyLimit,
  getGuardStats,
} from "../../backend/src/guard.mjs";

const originalNodeEnv = process.env.NODE_ENV;
const originalForceGuards = process.env.VITEST_FORCE_GUARDS;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalForceGuards == null) delete process.env.VITEST_FORCE_GUARDS;
  else process.env.VITEST_FORCE_GUARDS = originalForceGuards;
});

describe("getTraceAnalysisPolicy", () => {
  it("keeps trace requests on the shared trace concurrency policy", () => {
    expect(getTraceAnalysisPolicy(2000)).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
    expect(getTraceAnalysisPolicy(undefined)).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
    expect(getTraceAnalysisPolicy("full")).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
  });
});

describe("withConcurrencyLimit", () => {
  it("queues saturated requests instead of rejecting them", async () => {
    process.env.VITEST_FORCE_GUARDS = "1";

    let releaseFirst;
    const first = withConcurrencyLimit("trace-analysis", 1, () => new Promise((resolve) => {
      releaseFirst = resolve;
    }));

    let secondRan = false;
    const second = withConcurrencyLimit("trace-analysis", 1, async () => {
      secondRan = true;
      return "second";
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondRan).toBe(false);
    expect(getGuardStats().queued["trace-analysis"]).toBe(1);

    releaseFirst?.("first");

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(secondRan).toBe(true);
    expect(getGuardStats().queued["trace-analysis"]).toBeUndefined();
  });
});
