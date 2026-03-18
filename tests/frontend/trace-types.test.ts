import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_FLOW_FILTERS,
  DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL,
  NATIVE_SOL_ASSET_ID,
  filterTraceEvents,
  type TraceTransferEvent,
} from "@/lib/trace-types";

function traceEvent(overrides: Partial<TraceTransferEvent>): TraceTransferEvent {
  return {
    signature: "sig-1",
    timestamp: 1,
    direction: "outflow",
    counterparty: "counterparty-1",
    assetId: "mint-1",
    kind: "token",
    mint: "mint-1",
    decimals: 6,
    rawAmount: "1000000",
    uiAmount: 1,
    ...overrides,
  };
}

describe("filterTraceEvents", () => {
  it("hides only native SOL dust when the default dust filter is enabled", () => {
    const dust = traceEvent({
      signature: "dust",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      mint: undefined,
      decimals: 9,
      rawAmount: "50000",
      uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL / 2,
    });
    const visibleSol = traceEvent({
      signature: "sol-visible",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      mint: undefined,
      decimals: 9,
      rawAmount: "100000",
      uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL,
    });
    const tinyToken = traceEvent({
      signature: "token-tiny",
      assetId: "usdc",
      kind: "token",
      mint: "usdc",
      decimals: 6,
      rawAmount: "5000",
      uiAmount: 0.005,
    });

    const filtered = filterTraceEvents(
      [dust, visibleSol, tinyToken],
      { ...DEFAULT_TRACE_FLOW_FILTERS },
    );

    expect(filtered.map((event) => event.signature)).toEqual(["sol-visible", "token-tiny"]);
  });

  it("restores SOL dust when the dedicated dust toggle is disabled", () => {
    const dust = traceEvent({
      signature: "dust",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      mint: undefined,
      decimals: 9,
      rawAmount: "50000",
      uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL / 2,
    });

    const filtered = filterTraceEvents(
      [dust],
      { ...DEFAULT_TRACE_FLOW_FILTERS, hideSolDust: false },
    );

    expect(filtered.map((event) => event.signature)).toEqual(["dust"]);
  });
});
