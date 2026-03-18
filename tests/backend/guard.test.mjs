// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getTraceAnalysisPolicy, HEAVY_ROUTE_POLICIES } from "../../backend/src/guard.mjs";

describe("getTraceAnalysisPolicy", () => {
  it("prices quick trace scans lower than full-history trace requests", () => {
    expect(getTraceAnalysisPolicy(2000)).toMatchObject({
      routeKey: HEAVY_ROUTE_POLICIES.traceAnalysis.routeKey,
      concurrencyLabel: HEAVY_ROUTE_POLICIES.traceAnalysis.concurrencyLabel,
      maxConcurrency: HEAVY_ROUTE_POLICIES.traceAnalysis.maxConcurrency,
      cost: 3,
    });

    expect(getTraceAnalysisPolicy(undefined)).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
    expect(getTraceAnalysisPolicy("full")).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
  });
});
