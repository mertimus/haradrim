import { describe, expect, it } from "vitest";
import {
  aggregateTraceCounterparties,
  selectEdgeTransactions,
  type TraceCounterparty,
  type TraceTransferEvent,
} from "@/lib/trace-types";
import { addCounterpartiesToGraph, buildTraceGraph, createTraceState } from "@/lib/trace-engine";

function tokenEvent(overrides: Partial<TraceTransferEvent>): TraceTransferEvent {
  return {
    signature: "sig",
    timestamp: 1,
    direction: "outflow",
    counterparty: "counterparty",
    assetId: "mint-1",
    kind: "token",
    mint: "mint-1",
    decimals: 6,
    rawAmount: "1000000",
    uiAmount: 1,
    ...overrides,
  };
}

function counterparty(overrides: Partial<TraceCounterparty>): TraceCounterparty {
  return {
    address: "counterparty",
    txCount: 1,
    transferCount: 1,
    inflowTxCount: 0,
    outflowTxCount: 1,
    inflowTransferCount: 0,
    outflowTransferCount: 1,
    inflowFirstSeen: 0,
    inflowLastSeen: 0,
    outflowFirstSeen: 10,
    outflowLastSeen: 20,
    firstSeen: 10,
    lastSeen: 20,
    inflowAssets: [],
    outflowAssets: [{
      assetId: "mint-1",
      kind: "token",
      mint: "mint-1",
      decimals: 6,
      rawAmount: "1000000",
      uiAmount: 1,
      transferCount: 1,
      txCount: 1,
    }],
    ...overrides,
  };
}

describe("trace edge helpers", () => {
  it("keeps edge drill-downs directional", () => {
    const sourceFlows = {
      address: "source",
      assets: [],
      firstSeen: 100,
      lastSeen: 300,
      metadataPending: false,
      events: [
        tokenEvent({
          signature: "outflow-1",
          timestamp: 100,
          direction: "outflow",
          counterparty: "target",
        }),
        tokenEvent({
          signature: "inflow-1",
          timestamp: 300,
          direction: "inflow",
          counterparty: "target",
        }),
      ],
    };

    const events = selectEdgeTransactions("source", "target", sourceFlows, null);

    expect(events?.map((event) => event.signature)).toEqual(["outflow-1"]);
  });

  it("tracks directional timestamps for graph edges", () => {
    const aggregated = aggregateTraceCounterparties([
      tokenEvent({
        signature: "out-1",
        timestamp: 100,
        direction: "outflow",
      }),
      tokenEvent({
        signature: "in-1",
        timestamp: 300,
        direction: "inflow",
      }),
    ]);

    const state = addCounterpartiesToGraph(
      createTraceState("seed"),
      "seed",
      aggregated,
      "outflow",
    );

    expect(state.edgeMap.get("seed:counterparty")?.firstSeen).toBe(100);
    expect(state.edgeMap.get("seed:counterparty")?.lastSeen).toBe(100);
  });

  it("weights edges by activity instead of mixed asset amounts", () => {
    const state = createTraceState("seed");
    const withBusyEdge = addCounterpartiesToGraph(state, "seed", [counterparty({
      address: "busy",
      outflowTransferCount: 10,
      outflowTxCount: 10,
      transferCount: 10,
      txCount: 10,
      outflowAssets: [{
        assetId: "token-a",
        kind: "token",
        mint: "token-a",
        decimals: 6,
        rawAmount: "1000000",
        uiAmount: 1,
        transferCount: 10,
        txCount: 10,
      }],
    })], "outflow");
    const withBothEdges = addCounterpartiesToGraph(withBusyEdge, "seed", [counterparty({
      address: "whale",
      outflowTransferCount: 1,
      outflowTxCount: 1,
      transferCount: 1,
      txCount: 1,
      outflowAssets: [{
        assetId: "token-b",
        kind: "token",
        mint: "token-b",
        decimals: 6,
        rawAmount: "1000000000000",
        uiAmount: 1_000_000,
        transferCount: 1,
        txCount: 1,
      }],
    })], "outflow");

    const graph = buildTraceGraph(withBothEdges);
    const busy = graph.edges.find((edge) => edge.id === "seed:busy");
    const whale = graph.edges.find((edge) => edge.id === "seed:whale");

    expect((busy?.data as { weight: number }).weight).toBeGreaterThan((whale?.data as { weight: number }).weight);
  });
});
