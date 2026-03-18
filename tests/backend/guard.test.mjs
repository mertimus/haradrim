// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getTraceAnalysisPolicy, HEAVY_ROUTE_POLICIES } from "../../backend/src/guard.mjs";

describe("getTraceAnalysisPolicy", () => {
  it("keeps trace requests on the shared trace concurrency policy", () => {
    expect(getTraceAnalysisPolicy(2000)).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
    expect(getTraceAnalysisPolicy(undefined)).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
    expect(getTraceAnalysisPolicy("full")).toBe(HEAVY_ROUTE_POLICIES.traceAnalysis);
  });
});
