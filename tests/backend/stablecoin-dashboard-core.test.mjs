// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { buildStablecoinDashboard, stablecoinDashboardInternals } from "../../backend/src/stablecoin-dashboard-core.mjs";

const {
  rawToUiAmount,
  aggregateByOwner,
  computeConcentration,
  findMultiStableOverlap,
  fetchYieldMarkets,
  STABLECOINS,
} = stablecoinDashboardInternals;

describe("rawToUiAmount", () => {
  it("converts raw lamports to UI amount", () => {
    expect(rawToUiAmount(1_000_000n, 6)).toBe(1);
    expect(rawToUiAmount(1_500_000n, 6)).toBe(1.5);
    expect(rawToUiAmount(100n, 0)).toBe(100);
  });

  it("handles zero decimals", () => {
    expect(rawToUiAmount(42n, 0)).toBe(42);
  });
});

describe("aggregateByOwner", () => {
  it("aggregates multiple token accounts per owner", () => {
    const accounts = [
      { owner: "alice", amount: "1000000", decimals: 6 },
      { owner: "alice", amount: "2000000", decimals: 6 },
      { owner: "bob", amount: "500000", decimals: 6 },
    ];
    const result = aggregateByOwner(accounts, 6, 10);
    expect(result).toHaveLength(2);
    expect(result[0].owner).toBe("alice");
    expect(result[0].uiAmount).toBe(3);
    expect(result[1].owner).toBe("bob");
    expect(result[1].uiAmount).toBe(0.5);
  });

  it("sorts by amount descending", () => {
    const accounts = [
      { owner: "small", amount: "100", decimals: 6 },
      { owner: "large", amount: "9999999", decimals: 6 },
    ];
    const result = aggregateByOwner(accounts, 6, 100);
    expect(result[0].owner).toBe("large");
  });
});

describe("computeConcentration", () => {
  it("computes top-N concentration percentages", () => {
    const holders = Array.from({ length: 100 }, (_, i) => ({
      owner: `addr-${i}`,
      uiAmount: 100 - i,
      percentage: 0,
    }));
    const supply = holders.reduce((sum, h) => sum + h.uiAmount, 0);

    const result = computeConcentration(holders, supply);
    expect(result.top10Pct).toBeGreaterThan(0);
    expect(result.top50Pct).toBeGreaterThan(result.top10Pct);
    expect(result.top100Pct).toBeCloseTo(100, 1);
  });

  it("handles zero supply", () => {
    const result = computeConcentration([], 0);
    expect(result.top10Pct).toBe(0);
    expect(result.top50Pct).toBe(0);
    expect(result.top100Pct).toBe(0);
  });
});

describe("findMultiStableOverlap", () => {
  it("finds addresses present in 2+ stablecoin holder lists", () => {
    const holdersByTicker = {
      USDC: [
        { owner: "shared", uiAmount: 100, percentage: 10 },
        { owner: "usdc-only", uiAmount: 50, percentage: 5 },
      ],
      USDT: [
        { owner: "shared", uiAmount: 200, percentage: 20 },
        { owner: "usdt-only", uiAmount: 80, percentage: 8 },
      ],
      PYUSD: [
        { owner: "shared", uiAmount: 30, percentage: 3 },
        { owner: "pyusd-only", uiAmount: 10, percentage: 1 },
      ],
    };

    const result = findMultiStableOverlap(holdersByTicker);
    expect(result).toHaveLength(1);
    expect(result[0].owner).toBe("shared");
    expect(result[0].holdings.USDC.amount).toBe(100);
    expect(result[0].holdings.USDT.amount).toBe(200);
    expect(result[0].holdings.PYUSD.amount).toBe(30);
  });

  it("returns empty when no overlap", () => {
    const holdersByTicker = {
      USDC: [{ owner: "a", uiAmount: 1, percentage: 1 }],
      USDT: [{ owner: "b", uiAmount: 1, percentage: 1 }],
    };
    expect(findMultiStableOverlap(holdersByTicker)).toHaveLength(0);
  });

  it("detects pair-wise overlap across many stablecoins", () => {
    const holdersByTicker = {
      USDC: [{ owner: "pair1", uiAmount: 50, percentage: 5 }],
      USDT: [],
      PYUSD: [{ owner: "pair1", uiAmount: 20, percentage: 2 }],
    };

    const result = findMultiStableOverlap(holdersByTicker);
    expect(result).toHaveLength(1);
    expect(Object.keys(result[0].holdings)).toEqual(["USDC", "PYUSD"]);
  });
});

describe("STABLECOINS config", () => {
  it("includes all five stablecoins", () => {
    const tickers = STABLECOINS.map((s) => s.ticker);
    expect(tickers).toEqual(["USDC", "USDT", "PYUSD", "USDG", "CASH", "USD1", "syrupUSDC", "USX", "EURC", "USDS", "JupUSD"]);
  });
});

function makeDialectMarket(overrides = {}) {
  return {
    id: "market-1",
    productName: "Earn",
    provider: { name: "Kamino", icon: "https://kamino.icon" },
    token: { symbol: "USDC", icon: "https://usdc.icon" },
    depositApy: 0.0487,
    baseDepositApy: 0.035,
    totalDepositUsd: 50_000_000,
    websiteUrl: "https://kamino.finance",
    additionalData: {},
    rewards: [{ apy: 0.0137, token: { symbol: "JTO", icon: "" } }],
    ...overrides,
  };
}

function makeFetcher(markets) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ markets }),
  }));
}

describe("fetchYieldMarkets", () => {
  it("filters by TVL >= $1M", async () => {
    const markets = [
      makeDialectMarket({ id: "big", totalDepositUsd: 5_000_000 }),
      makeDialectMarket({ id: "small", totalDepositUsd: 500_000 }),
      makeDialectMarket({ id: "tiny", totalDepositUsd: 1_700 }),
    ];
    const fetcher = makeFetcher(markets);
    const result = await fetchYieldMarkets([STABLECOINS[0]], fetcher);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("big");
  });

  it("sorts by deposits descending", async () => {
    const markets = [
      makeDialectMarket({ id: "mid", totalDepositUsd: 10_000_000 }),
      makeDialectMarket({ id: "top", totalDepositUsd: 100_000_000 }),
      makeDialectMarket({ id: "low", totalDepositUsd: 2_000_000 }),
    ];
    const fetcher = makeFetcher(markets);
    const result = await fetchYieldMarkets([STABLECOINS[0]], fetcher);
    expect(result[0].id).toBe("top");
    expect(result[1].id).toBe("mid");
    expect(result[2].id).toBe("low");
  });

  it("detects boosted correctly", async () => {
    const markets = [
      makeDialectMarket({ id: "boosted", depositApy: 0.06, baseDepositApy: 0.04, totalDepositUsd: 2_000_000 }),
      makeDialectMarket({ id: "not-boosted", depositApy: 0.04, baseDepositApy: 0.04, totalDepositUsd: 3_000_000 }),
    ];
    const fetcher = makeFetcher(markets);
    const result = await fetchYieldMarkets([STABLECOINS[0]], fetcher);
    const boosted = result.find((m) => m.id === "boosted");
    const notBoosted = result.find((m) => m.id === "not-boosted");
    expect(boosted.boosted).toBe(true);
    expect(notBoosted.boosted).toBe(false);
  });

  it("builds market name from additionalData.marketName or fallback", async () => {
    const markets = [
      makeDialectMarket({ id: "named", additionalData: { marketName: "JLP Vault" }, totalDepositUsd: 5_000_000 }),
      makeDialectMarket({ id: "fallback", additionalData: {}, productName: "Earn", provider: { name: "Jupiter", icon: "" }, totalDepositUsd: 5_000_000 }),
    ];
    const fetcher = makeFetcher(markets);
    const result = await fetchYieldMarkets([STABLECOINS[0]], fetcher);
    const named = result.find((m) => m.id === "named");
    const fallback = result.find((m) => m.id === "fallback");
    expect(named.name).toBe("JLP Vault");
    expect(fallback.name).toBe("Jupiter Earn");
  });

  it("handles fetch failure gracefully per mint", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500 }));
    const result = await fetchYieldMarkets([STABLECOINS[0]], fetcher);
    expect(result).toEqual([]);
  });
});

describe("buildStablecoinDashboard", () => {
  it("returns a complete dashboard result with mocked RPC", async () => {
    const mintSupplies = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { amount: "10000000000", decimals: 6 },
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { amount: "5000000000", decimals: 6 },
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": { amount: "1000000000", decimals: 6 },
      "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": { amount: "500000000", decimals: 6 },
      CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: { amount: "200000000", decimals: 6 },
      USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { amount: "100000000", decimals: 6 },
      AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: { amount: "50000000", decimals: 6 },
      "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG": { amount: "25000000", decimals: 6 },
      HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { amount: "75000000", decimals: 6 },
      USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: { amount: "84000000", decimals: 6 },
      JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: { amount: "60000000", decimals: 6 },
    };

    const mintAccounts = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: [
        { owner: "whale-A", amount: "3000000000", decimals: 6 },
        { owner: "shared-C", amount: "1000000000", decimals: 6 },
      ],
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: [
        { owner: "whale-D", amount: "2000000000", decimals: 6 },
        { owner: "shared-C", amount: "1500000000", decimals: 6 },
      ],
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": [
        { owner: "shared-C", amount: "500000000", decimals: 6 },
      ],
      "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": [],
      CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: [],
      USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: [],
      AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: [],
      "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG": [],
      HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: [],
      USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: [],
      JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: [],
    };

    const rpcJson = vi.fn(async (method, params) => {
      if (method === "getTokenSupply") {
        const supply = mintSupplies[params[0]] ?? { amount: "0", decimals: 6 };
        return { result: { value: supply } };
      }
      if (method === "getTokenLargestAccountsV2") {
        const accounts = mintAccounts[params[0]] ?? [];
        return { result: { value: { accounts } } };
      }
      return {};
    });

    const getBatchIdentity = vi.fn(async () => {
      const map = new Map();
      map.set("whale-A", { address: "whale-A", name: "Coinbase", label: "Coinbase", category: "exchange" });
      map.set("shared-C", { address: "shared-C", name: "Binance", label: "Binance", category: "exchange" });
      return map;
    });

    const fetchWithTimeout = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        markets: [makeDialectMarket({ id: "yield-1", totalDepositUsd: 20_000_000 })],
      }),
    }));

    const result = await buildStablecoinDashboard({ rpcJson, getBatchIdentity, fetchWithTimeout });

    expect(result.snapshotAt).toBeGreaterThan(0);
    expect(result.stablecoins).toHaveLength(11);
    expect(result.stablecoins[0].ticker).toBe("USDC");
    expect(result.stablecoins[0].uiAmount).toBe(10000);
    expect(result.stablecoins[1].ticker).toBe("USDT");
    expect(result.stablecoins[1].uiAmount).toBe(5000);
    expect(result.stablecoins[2].ticker).toBe("PYUSD");
    expect(result.stablecoins[2].uiAmount).toBe(1000);
    expect(result.totalSupply).toBe(17094);

    expect(result.holdersByTicker.USDC.holders[0].owner).toBe("whale-A");
    expect(result.holdersByTicker.USDC.holders[0].label).toBe("Coinbase");
    expect(result.holdersByTicker.USDT.holders).toHaveLength(2);

    expect(result.overlap.length).toBeGreaterThan(0);
    const sharedC = result.overlap.find((h) => h.owner === "shared-C");
    expect(sharedC).toBeDefined();
    expect(sharedC.label).toBe("Binance");
    expect(sharedC.holdings.USDC).toBeDefined();
    expect(sharedC.holdings.USDT).toBeDefined();
    expect(sharedC.holdings.PYUSD).toBeDefined();

    expect(result.holdersByTicker.USDC.concentration.top10Pct).toBeGreaterThan(0);

    expect(typeof result.editorial).toBe("string");
    expect(result.editorial.length).toBeGreaterThan(0);
    expect(result.editorial).toContain("USDC");

    expect(result.concentrationRanking.length).toBeGreaterThan(0);
    expect(result.concentrationRanking[0].top10Pct).toBeGreaterThanOrEqual(
      result.concentrationRanking[result.concentrationRanking.length - 1].top10Pct,
    );

    expect(result.diversification.walletCount).toBe(1);
    expect(result.diversification.totalValue).toBeGreaterThan(0);
    expect(result.diversification.pctOfSupply).toBeGreaterThan(0);

    expect(result.yieldMarkets.length).toBeGreaterThan(0);
    expect(result.yieldMarkets[0].id).toBe("yield-1");
    expect(result.yieldMarkets[0].totalDepositUsd).toBe(20_000_000);
  });

  it("returns yieldMarkets: [] when fetchWithTimeout throws", async () => {
    const rpcJson = vi.fn(async (method, params) => {
      if (method === "getTokenSupply") return { result: { value: { amount: "1000000", decimals: 6 } } };
      if (method === "getTokenLargestAccountsV2") return { result: { value: { accounts: [] } } };
      return {};
    });
    const getBatchIdentity = vi.fn(async () => new Map());
    const fetchWithTimeout = vi.fn(async () => { throw new Error("network fail"); });

    const result = await buildStablecoinDashboard({ rpcJson, getBatchIdentity, fetchWithTimeout });
    expect(result.yieldMarkets).toEqual([]);
    expect(result.stablecoins).toHaveLength(11);
  });
});
