import { describe, expect, it } from "vitest";
import type { TokenHolder } from "@/birdeye-api";
import type { FundingWalkResult } from "@/lib/funding-walk";
import { buildSuspiciousClusters } from "@/lib/suspicious-clusters";

function makeHolder(owner: string, percentage: number): TokenHolder {
  return {
    owner,
    percentage,
    uiAmount: percentage * 1_000,
  };
}

function makeAddress(seed: string): string {
  return `${seed}${"1".repeat(Math.max(0, 44 - seed.length))}`;
}

describe("buildSuspiciousClusters", () => {
  it("fuses synchronized acquisition and shared funding into a shared-funding bundle cluster", () => {
    const holderA = makeAddress("HolderA");
    const holderB = makeAddress("HolderB");
    const holderC = makeAddress("HolderC");
    const ancestor = makeAddress("Ancestor");

    const fundingResult: FundingWalkResult = {
      nodes: new Map([
        [holderA, { address: holderA, depth: 0, amount: 0, children: [], isHolder: true, holdersFunded: 0, holdersPctFunded: 0, holderPct: 6 }],
        [holderB, { address: holderB, depth: 0, amount: 0, children: [], isHolder: true, holdersFunded: 0, holdersPctFunded: 0, holderPct: 5 }],
        [holderC, { address: holderC, depth: 0, amount: 0, children: [], isHolder: true, holdersFunded: 0, holdersPctFunded: 0, holderPct: 2 }],
        [ancestor, { address: ancestor, depth: 1, amount: 4, children: [holderA, holderB], isHolder: false, holdersFunded: 2, holdersPctFunded: 11, label: "Seed Wallet" }],
      ]),
      edges: [
        { source: ancestor, target: holderA, amount: 2 },
        { source: ancestor, target: holderB, amount: 2 },
      ],
      commonFunders: [],
    };

    const result = buildSuspiciousClusters({
      holders: [
        makeHolder(holderA, 6),
        makeHolder(holderB, 5),
        makeHolder(holderC, 2),
      ],
      bundleGroups: [{ slot: 100, members: [holderA, holderB], totalPct: 11 }],
      firstAcquisitionSlots: new Map([
        [holderA, 100],
        [holderB, 102],
      ]),
      fundingResult,
      scope: new Set([holderA, holderB, holderC]),
    });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].signalKinds).toEqual(
      expect.arrayContaining(["synchronized_acquisition", "shared_funding_ancestor"]),
    );
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].label).toBe("Shared-Funding Bundle");
    expect(result.clusters[0].members).toEqual(
      expect.arrayContaining([holderA, holderB]),
    );
  });

  it("does not cluster a single weak incidental transfer by itself", () => {
    const holderA = makeAddress("WeakA");
    const holderB = makeAddress("WeakB");

    const result = buildSuspiciousClusters({
      holders: [makeHolder(holderA, 7), makeHolder(holderB, 4)],
      connections: [
        {
          source: holderA,
          target: holderB,
          txCount: 1,
          bidirectional: false,
          sourceToTargetTxCount: 1,
          targetToSourceTxCount: 0,
          firstSeen: 100,
          lastSeen: 100,
          evidenceScore: 1,
        },
      ],
      scope: new Set([holderA, holderB]),
    });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].totalScore).toBeLessThan(2.25);
    expect(result.clusters).toHaveLength(0);
  });

  it("labels a strong bidirectional transfer pair as a reciprocal transfer ring", () => {
    const holderA = makeAddress("RingA");
    const holderB = makeAddress("RingB");

    const result = buildSuspiciousClusters({
      holders: [makeHolder(holderA, 8), makeHolder(holderB, 6)],
      connections: [
        {
          source: holderA,
          target: holderB,
          txCount: 2,
          bidirectional: true,
          sourceToTargetTxCount: 1,
          targetToSourceTxCount: 1,
          firstSeen: 100,
          lastSeen: 110,
          evidenceScore: 3,
        },
      ],
      scope: new Set([holderA, holderB]),
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].label).toBe("Reciprocal Transfer Ring");
    expect(result.clusters[0].reciprocalTransferEdges).toBe(1);
  });
});
