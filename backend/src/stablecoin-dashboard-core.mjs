import { rpcJson, getBatchIdentity, mapWithConcurrency, fetchWithTimeout } from "./providers.mjs";
import { cachedValue } from "./cache.mjs";
import { DIALECT_API_KEY, DIALECT_API_BASE, STABLECOIN_DASHBOARD_TTL_MS } from "./config.mjs";

// Keep internal dashboard fragments no staler than the route-level cache.
const SUPPLY_CACHE_TTL_MS = STABLECOIN_DASHBOARD_TTL_MS;
const LARGEST_ACCTS_CACHE_TTL_MS = STABLECOIN_DASHBOARD_TTL_MS;
const YIELD_CACHE_TTL_MS = STABLECOIN_DASHBOARD_TTL_MS;

const STABLECOINS = [
  { ticker: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { ticker: "USDT", name: "Tether USD", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  { ticker: "PYUSD", name: "PayPal USD", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
  { ticker: "USDG", name: "Global Dollar", mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH" },
  { ticker: "CASH", name: "Cash", mint: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH" },
  { ticker: "USD1", name: "USD1", mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB" },
  { ticker: "syrupUSDC", name: "SyrupUSDC", mint: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj" },
  { ticker: "USX", name: "USX", mint: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG" },
  { ticker: "EURC", name: "Euro Coin", mint: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr" },
  { ticker: "USDS", name: "Sky Dollar", mint: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA" },
  { ticker: "JupUSD", name: "JupUSD", mint: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD" },
];

const STABLECOIN_MINTS = new Set(STABLECOINS.map((s) => s.mint));

const LARGEST_ACCOUNTS_LIMIT = 20;
const TOP_HOLDERS_DISPLAY = 20;

function rawToUiAmount(rawAmount, decimals) {
  if (decimals <= 0) return Number(rawAmount);
  const base = 10n ** BigInt(decimals);
  const whole = rawAmount / base;
  const fraction = rawAmount % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const normalized = fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchTokenSupply(mint, rpc) {
  const json = await rpc("getTokenSupply", [mint]);
  const rawAmount = json?.result?.value?.amount;
  const decimals = Number(json?.result?.value?.decimals ?? 0);
  let rawSupply = 0n;
  try {
    rawSupply = BigInt(rawAmount ?? "0");
  } catch {
    rawSupply = 0n;
  }
  const safeDecimals = Number.isFinite(decimals) ? decimals : 0;
  return {
    rawAmount: rawSupply,
    decimals: safeDecimals,
    uiAmount: rawToUiAmount(rawSupply, safeDecimals),
  };
}

function parseLargestAccount(entry) {
  const owner = entry?.owner ?? "";
  const amount = entry?.amount;
  const decimals = Number(entry?.decimals ?? 0);
  if (!owner || typeof amount !== "string" || !Number.isFinite(decimals)) return null;
  try {
    return { owner, rawAmount: BigInt(amount), decimals };
  } catch {
    return null;
  }
}

const LARGEST_ACCOUNTS_TIMEOUT_MS = 60_000;

async function fetchLargestAccounts(mint, limit, rpc) {
  const json = await rpc("getTokenLargestAccountsV2", [
    mint,
    { commitment: "confirmed", limit },
  ], { timeoutMs: LARGEST_ACCOUNTS_TIMEOUT_MS });
  return Array.isArray(json?.result?.value?.accounts)
    ? json.result.value.accounts
    : [];
}

function aggregateByOwner(accounts, decimals, supplyUi) {
  const ownerTotals = new Map();
  for (const entry of accounts) {
    const parsed = parseLargestAccount(entry);
    if (!parsed || parsed.rawAmount <= 0n) continue;
    ownerTotals.set(parsed.owner, (ownerTotals.get(parsed.owner) ?? 0n) + parsed.rawAmount);
  }

  return [...ownerTotals.entries()]
    .map(([owner, rawAmount]) => ({
      owner,
      uiAmount: rawToUiAmount(rawAmount, decimals),
      percentage: supplyUi > 0 ? (rawToUiAmount(rawAmount, decimals) / supplyUi) * 100 : 0,
    }))
    .sort((a, b) => b.uiAmount - a.uiAmount);
}

function computeConcentration(sortedHolders, supplyUi) {
  const sumPct = (count) =>
    sortedHolders.slice(0, count).reduce((sum, h) => sum + h.uiAmount, 0) / supplyUi * 100;
  return {
    top10Pct: supplyUi > 0 ? sumPct(10) : 0,
    top50Pct: supplyUi > 0 ? sumPct(50) : 0,
    top100Pct: supplyUi > 0 ? sumPct(100) : 0,
  };
}

function generateEditorial(stablecoins, totalSupply, overlap, concentrationRanking) {
  const lines = [];

  const dominant = stablecoins[0];
  if (dominant) {
    lines.push(
      `${dominant.ticker} dominates Solana stablecoin supply at ${formatEditorialUsd(dominant.uiAmount)} (${dominant.sharePct.toFixed(1)}%).`,
    );
  }

  const secondaries = stablecoins.filter((sc) => sc.sharePct >= 5 && sc !== dominant);
  if (secondaries.length > 0) {
    const parts = secondaries.map((sc) => `${sc.ticker} at ${formatEditorialUsd(sc.uiAmount)}`);
    lines.push(`${parts.join(", ")} ${secondaries.length === 1 ? "follows" : "follow"} behind.`);
  }

  const micro = stablecoins.filter((sc) => sc.sharePct < 1 && sc.uiAmount > 0);
  if (micro.length > 0) {
    const tickers = micro.map((sc) => sc.ticker).join(", ");
    lines.push(`${tickers} ${micro.length === 1 ? "holds" : "hold"} less than 1% share each.`);
  }

  if (concentrationRanking.length >= 2) {
    const most = concentrationRanking[0];
    const least = concentrationRanking[concentrationRanking.length - 1];
    lines.push(
      `${most.ticker} is the most concentrated — top 10 holders control ${most.top10Pct.toFixed(1)}% of supply. ${least.ticker} is the most distributed at ${least.top10Pct.toFixed(1)}%.`,
    );
  }

  if (overlap.length > 0) {
    const diversifiedValue = overlap.reduce(
      (sum, h) => sum + Object.values(h.holdings).reduce((s, v) => s + v.amount, 0),
      0,
    );
    const diversifiedPct = totalSupply > 0 ? (diversifiedValue / totalSupply) * 100 : 0;
    const maxTickers = Math.max(...overlap.map((h) => Object.keys(h.holdings).length));
    lines.push(
      `${overlap.length} wallets hold ${maxTickers >= 3 ? "3+" : "2+"} stablecoins, controlling ${formatEditorialUsd(diversifiedValue)} (${diversifiedPct.toFixed(1)}% of total supply).`,
    );
  }

  return lines.join(" ");
}

function formatEditorialUsd(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function buildConcentrationRanking(stablecoins, holdersResult) {
  return stablecoins
    .map((sc) => {
      const data = holdersResult[sc.ticker];
      if (!data) return null;
      return {
        ticker: sc.ticker,
        top10Pct: data.concentration.top10Pct,
        top50Pct: data.concentration.top50Pct,
        top100Pct: data.concentration.top100Pct,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.top10Pct - a.top10Pct);
}

function findMultiStableOverlap(holdersByTicker) {
  const tickers = Object.keys(holdersByTicker);
  const ownerPresence = new Map();

  for (const ticker of tickers) {
    for (const holder of holdersByTicker[ticker]) {
      if (!ownerPresence.has(holder.owner)) {
        ownerPresence.set(holder.owner, {});
      }
      ownerPresence.get(holder.owner)[ticker] = {
        amount: holder.uiAmount,
        pct: holder.percentage,
      };
    }
  }

  const overlap = [];
  for (const [owner, holdings] of ownerPresence) {
    const tickerCount = Object.keys(holdings).length;
    if (tickerCount < 2) continue;
    overlap.push({ owner, holdings });
  }

  const totalValue = (h) => Object.values(h.holdings).reduce((s, v) => s + v.amount, 0);
  return overlap.sort((a, b) => totalValue(b) - totalValue(a));
}

const MIN_TVL = 1_000_000;

async function fetchYieldMarkets(stablecoins, fetcher) {
  const results = await Promise.allSettled(
    stablecoins.map(async (sc) => {
      const url = `${DIALECT_API_BASE}/v0/markets?type=yield,lending&asset=${sc.mint}&limit=200`;
      const res = await fetcher(url, {
        headers: { "x-dialect-api-key": DIALECT_API_KEY },
      });
      if (!res.ok) return [];
      const json = await res.json();
      const markets = Array.isArray(json?.markets) ? json.markets : Array.isArray(json) ? json : [];
      return markets
        .filter((m) => (m.totalDepositUsd ?? 0) >= MIN_TVL)
        .map((m) => ({
          id: m.id,
          type: m.type ?? "yield",
          name: m.additionalData?.marketName || `${m.provider?.name ?? "Unknown"} ${m.productName ?? ""}`.trim(),
          ticker: sc.ticker,
          tokenIcon: m.token?.icon ?? "",
          provider: m.provider?.name ?? "",
          providerIcon: m.provider?.icon ?? "",
          depositApy: m.depositApy ?? 0,
          baseDepositApy: m.baseDepositApy ?? 0,
          baseDepositApy30d: m.baseDepositApy30d ?? null,
          baseDepositApy90d: m.baseDepositApy90d ?? null,
          boosted: (m.depositApy ?? 0) > (m.baseDepositApy ?? 0),
          totalDepositUsd: m.totalDepositUsd ?? 0,
          borrowApy: m.borrowApy ?? null,
          totalBorrowUsd: m.totalBorrowUsd ?? null,
          url: m.websiteUrl ?? null,
        }));
    }),
  );

  const all = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  all.sort((a, b) => b.totalDepositUsd - a.totalDepositUsd);
  return all;
}

export async function buildStablecoinDashboard(deps = {}) {
  const rpc = deps.rpcJson ?? rpcJson;
  const batchIdentity = deps.getBatchIdentity ?? getBatchIdentity;
  const fetcher = deps.fetchWithTimeout ?? fetchWithTimeout;
  const cache = deps.rpcJson || deps.getBatchIdentity || deps.fetchWithTimeout
    ? async (_key, _ttlMs, loader) => loader()
    : cachedValue;

  // Phase 1: Fetch supply + accounts per coin (concurrency-limited to avoid rate limits)
  // Individual sub-calls are cached so dashboard rebuilds are fast
  // Yield markets fire independently in parallel
  const yieldPromise = cache("sc:yield-markets", YIELD_CACHE_TTL_MS, () =>
    fetchYieldMarkets(STABLECOINS, fetcher).catch(() => []),
  );

  const coinData = await mapWithConcurrency(STABLECOINS, 4, async (sc) => {
    const [supply, accounts] = await Promise.all([
      cache(`sc:supply:${sc.mint}`, SUPPLY_CACHE_TTL_MS, () =>
        fetchTokenSupply(sc.mint, rpc),
      ),
      cache(`sc:largest:${sc.mint}`, LARGEST_ACCTS_CACHE_TTL_MS, () =>
        fetchLargestAccounts(sc.mint, LARGEST_ACCOUNTS_LIMIT, rpc),
      ),
    ]);
    return { supply, accounts };
  });

  // Aggregate holders and collect unique owners
  const holdersByTicker = {};
  const ownerSet = new Set();
  const supplies = [];

  for (let i = 0; i < STABLECOINS.length; i++) {
    const { ticker } = STABLECOINS[i];
    const { supply, accounts } = coinData[i];
    supplies.push(supply);
    const holders = aggregateByOwner(accounts, supply.decimals, supply.uiAmount);
    holdersByTicker[ticker] = holders;
    for (const h of holders) ownerSet.add(h.owner);
  }

  // Phase 2: Identity + remaining yield in parallel
  const [identityMap, yieldMarkets] = await Promise.all([
    batchIdentity([...ownerSet]),
    yieldPromise,
  ]);

  function enrichHolders(holders) {
    return holders.slice(0, TOP_HOLDERS_DISPLAY).map((h) => {
      const identity = identityMap.get(h.owner);
      return {
        ...h,
        ...(identity?.label ? { label: identity.label } : {}),
        ...(identity?.category ? { category: identity.category } : {}),
      };
    });
  }

  const totalUiAmount = supplies.reduce((sum, s) => sum + s.uiAmount, 0);

  const stablecoins = STABLECOINS.map((sc, i) => ({
    ticker: sc.ticker,
    name: sc.name,
    mint: sc.mint,
    uiAmount: supplies[i].uiAmount,
    decimals: supplies[i].decimals,
    sharePct: totalUiAmount > 0 ? (supplies[i].uiAmount / totalUiAmount) * 100 : 0,
  }));

  const holdersResult = {};
  for (let i = 0; i < STABLECOINS.length; i++) {
    const { ticker } = STABLECOINS[i];
    holdersResult[ticker] = {
      holders: enrichHolders(holdersByTicker[ticker]),
      concentration: computeConcentration(holdersByTicker[ticker], supplies[i].uiAmount),
    };
  }

  const rawOverlap = findMultiStableOverlap(holdersByTicker);
  const overlap = rawOverlap.map((h) => {
    const identity = identityMap.get(h.owner);
    return {
      ...h,
      ...(identity?.label ? { label: identity.label } : {}),
    };
  });

  const concentrationRanking = buildConcentrationRanking(stablecoins, holdersResult);

  const diversifiedWalletCount = overlap.length;
  const diversifiedTotalValue = overlap.reduce(
    (sum, h) => sum + Object.values(h.holdings).reduce((s, v) => s + v.amount, 0),
    0,
  );
  const diversifiedPct = totalUiAmount > 0 ? (diversifiedTotalValue / totalUiAmount) * 100 : 0;

  const editorial = generateEditorial(stablecoins, totalUiAmount, overlap, concentrationRanking);

  return {
    snapshotAt: Math.floor(Date.now() / 1000),
    stablecoins,
    totalSupply: totalUiAmount,
    holdersByTicker: holdersResult,
    overlap,
    concentrationRanking,
    editorial,
    diversification: {
      walletCount: diversifiedWalletCount,
      totalValue: diversifiedTotalValue,
      pctOfSupply: diversifiedPct,
    },
    yieldMarkets,
  };
}

export const stablecoinDashboardInternals = {
  rawToUiAmount,
  fetchTokenSupply,
  parseLargestAccount,
  fetchLargestAccounts,
  aggregateByOwner,
  computeConcentration,
  findMultiStableOverlap,
  generateEditorial,
  buildConcentrationRanking,
  fetchYieldMarkets,
  STABLECOINS,
  STABLECOIN_MINTS,
};
