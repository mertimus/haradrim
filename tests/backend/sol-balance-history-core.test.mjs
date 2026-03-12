// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { solBalanceHistoryInternals } from "../../backend/src/sol-balance-history-core.mjs";

const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";

function createTx(
  signature,
  blockTime,
  preLamports,
  postLamports,
  slot = blockTime,
  transactionIndex = 0,
) {
  return {
    slot,
    blockTime,
    transactionIndex,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [WALLET],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [preLamports],
      postBalances: [postLamports],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

describe("buildSolBalanceHistoryAnalyzer", () => {
  it("uses a single full-page fetch when the history fits in one GTFA page", async () => {
    const tx1 = createTx("sig-1", 100, 1_000_000_000, 1_200_000_000);
    const tx2 = createTx("sig-2", 200, 1_200_000_000, 1_400_000_000);
    const fetchFrontierPage = vi.fn(async () => ({
      txs: [tx2, tx1],
      nextToken: null,
    }));
    const fetchTransactionsInRange = vi.fn(async () => []);
    const analyze = solBalanceHistoryInternals.buildSolBalanceHistoryAnalyzer({
      probeTimeline: async () => ({
        firstBlockTime: 100,
        lastBlockTime: 200,
        estimatedTxCount: 2,
        singlePageHistory: true,
      }),
      fetchFrontierPage,
      fetchTransactionsInRange,
    });

    const result = await analyze(WALLET);

    expect(fetchFrontierPage).toHaveBeenCalledTimes(1);
    expect(fetchFrontierPage).toHaveBeenCalledWith(WALLET, {
      sortOrder: "desc",
      limit: 1000,
    });
    expect(fetchTransactionsInRange).not.toHaveBeenCalled();
    expect(result.txCount).toBe(2);
    expect(result.currentBalanceSol).toBe(1.4);
  });

  it("fills the middle gap after fetching oldest and newest GTFA windows", async () => {
    const tx1 = createTx("sig-1", 100, 1_000_000_000, 1_100_000_000);
    const tx2 = createTx("sig-2", 200, 1_100_000_000, 1_300_000_000);
    const tx3 = createTx("sig-3", 300, 1_300_000_000, 1_600_000_000);
    const tx4 = createTx("sig-4", 400, 1_600_000_000, 2_000_000_000);
    const tx5 = createTx("sig-5", 500, 2_000_000_000, 2_300_000_000);

    const fetchTransactionsInRange = vi.fn(async () => [tx2, tx3, tx4]);
    const analyze = solBalanceHistoryInternals.buildSolBalanceHistoryAnalyzer({
      probeTimeline: async () => ({
        firstBlockTime: 100,
        lastBlockTime: 500,
        estimatedTxCount: 5,
      }),
      fetchFrontierPage: async (_address, opts) => (
        opts.sortOrder === "asc"
          ? { txs: [tx1, tx2], nextToken: "oldest-next" }
          : { txs: [tx4, tx5], nextToken: "newest-next" }
      ),
      fetchTransactionsInRange,
    });

    const result = await analyze(WALLET);

    expect(fetchTransactionsInRange).toHaveBeenCalledWith(WALLET, 200, 401);
    expect(result.strategy).toBe("two-sided-gap-fill");
    expect(result.txCount).toBe(5);
    expect(result.startingBalanceSol).toBe(1);
    expect(result.currentBalanceSol).toBe(2.3);
    expect(result.netChangeSol).toBe(1.3);
    expect(result.points.map((point) => point.signature)).toEqual([
      "sig-1",
      "sig-2",
      "sig-3",
      "sig-4",
      "sig-5",
    ]);
  });

  it("skips middle-gap fetching when the two frontier windows already overlap", async () => {
    const tx1 = createTx("sig-1", 100, 1_000_000_000, 1_200_000_000);
    const tx2 = createTx("sig-2", 200, 1_200_000_000, 1_400_000_000);
    const tx3 = createTx("sig-3", 300, 1_400_000_000, 1_500_000_000);
    const tx4 = createTx("sig-4", 400, 1_500_000_000, 1_700_000_000);

    const fetchTransactionsInRange = vi.fn(async () => []);
    const analyze = solBalanceHistoryInternals.buildSolBalanceHistoryAnalyzer({
      probeTimeline: async () => ({
        firstBlockTime: 100,
        lastBlockTime: 400,
        estimatedTxCount: 4,
      }),
      fetchFrontierPage: async (_address, opts) => (
        opts.sortOrder === "asc"
          ? { txs: [tx1, tx2, tx3], nextToken: "oldest-next" }
          : { txs: [tx3, tx4], nextToken: "newest-next" }
      ),
      fetchTransactionsInRange,
    });

    const result = await analyze(WALLET);

    expect(fetchTransactionsInRange).not.toHaveBeenCalled();
    expect(result.strategy).toBe("two-sided-direct");
    expect(result.txCount).toBe(4);
    expect(result.currentBalanceSol).toBe(1.7);
  });
});

describe("buildSolBalanceHistoryResult", () => {
  it("uses transactionIndex to preserve same-slot execution order", () => {
    const firstTx = createTx("sig-z", 100, 1_000_000_000, 2_000_000_000, 900, 1);
    const secondTx = createTx("sig-a", 100, 2_000_000_000, 1_500_000_000, 900, 2);

    const result = solBalanceHistoryInternals.buildSolBalanceHistoryResult(
      WALLET,
      [secondTx, firstTx],
      {},
    );

    expect(result.points.map((point) => point.signature)).toEqual(["sig-z", "sig-a"]);
    expect(result.startingBalanceSol).toBe(1);
    expect(result.currentBalanceSol).toBe(1.5);
    expect(result.netChangeSol).toBe(0.5);
  });
});

describe("buildSliceRangeFetcher", () => {
  it("subdivides dense slices and retries instead of failing immediately", async () => {
    const firstHalfTx = createTx("sig-1", 100, 1_000_000_000, 1_200_000_000);
    const secondHalfTx = createTx("sig-2", 200, 1_200_000_000, 1_500_000_000);
    const fetchSlice = vi.fn(async (_address, gte, lt) => {
      if (gte === 0 && lt === 8) {
        throw new solBalanceHistoryInternals.SliceOverflowError(gte, lt, 200);
      }
      if (gte === 0 && lt === 4) return [firstHalfTx];
      if (gte === 4 && lt === 8) return [secondHalfTx];
      return [];
    });
    const fetchSliceRange = solBalanceHistoryInternals.buildSliceRangeFetcher(fetchSlice);

    const result = await fetchSliceRange(WALLET, 0, 8);

    expect(fetchSlice).toHaveBeenCalledTimes(3);
    expect(result.map((tx) => tx.transaction.signatures[0])).toEqual(["sig-1", "sig-2"]);
  });
});
