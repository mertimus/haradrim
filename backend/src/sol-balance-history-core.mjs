import {
  GTFA_FULL_PAGE_LIMIT,
  GTFA_SIGNATURE_PAGE_LIMIT,
  MAX_SLICE_CONCURRENCY,
  MAX_TRANSACTION_SLICES,
  TARGET_GTFA_TXS_PER_SLICE,
} from "./config.mjs";
import { mapWithConcurrency, rpcJson } from "./providers.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_CHART_POINTS = 720;
const MAX_SLICE_SPLIT_DEPTH = 12;

class SliceOverflowError extends Error {
  constructor(gte, lt, maxPages) {
    super(`GTFA balance-history slice [${gte}, ${lt}) exceeded ${maxPages} pages`);
    this.name = "SliceOverflowError";
    this.gte = gte;
    this.lt = lt;
    this.maxPages = maxPages;
  }
}

function resolveKey(key) {
  return typeof key === "string" ? key : key.pubkey;
}

function roundSol(lamports) {
  return Math.round((Number(lamports) / LAMPORTS_PER_SOL) * 1_000_000_000) / 1_000_000_000;
}

function buildGtfaFilters(opts = {}) {
  const filters = {};
  if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
    const blockTime = {};
    if (opts.blockTimeGte != null) blockTime.gte = opts.blockTimeGte;
    if (opts.blockTimeLt != null) blockTime.lt = opts.blockTimeLt;
    filters.blockTime = blockTime;
  }
  return filters;
}

async function gtfaSignaturePage(address, opts = {}) {
  const params = {
    transactionDetails: "signatures",
    sortOrder: opts.sortOrder ?? "asc",
    limit: opts.limit ?? GTFA_SIGNATURE_PAGE_LIMIT,
    commitment: "confirmed",
  };
  const filters = buildGtfaFilters(opts);
  if (Object.keys(filters).length > 0) {
    params.filters = filters;
  }
  if (opts.paginationToken) {
    params.paginationToken = opts.paginationToken;
  }

  const json = await rpcJson("getTransactionsForAddress", [address, params]);
  const result = json.result ?? {};
  return {
    txs: result.data ?? [],
    nextToken: result.paginationToken ?? null,
  };
}

async function gtfaFullPage(address, opts = {}) {
  const params = {
    transactionDetails: "full",
    sortOrder: opts.sortOrder ?? "asc",
    limit: opts.limit ?? GTFA_FULL_PAGE_LIMIT,
    commitment: "confirmed",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
  };
  const filters = buildGtfaFilters(opts);
  if (Object.keys(filters).length > 0) {
    params.filters = filters;
  }
  if (opts.paginationToken) {
    params.paginationToken = opts.paginationToken;
  }

  const json = await rpcJson("getTransactionsForAddress", [address, params]);
  const result = json.result ?? {};
  return {
    txs: result.data ?? [],
    nextToken: result.paginationToken ?? null,
  };
}

function blockTimeBounds(records) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    if (record.blockTime == null) continue;
    if (record.blockTime < min) min = record.blockTime;
    if (record.blockTime > max) max = record.blockTime;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

async function probeTimeline(address, start, end) {
  const recentPage = await gtfaSignaturePage(address, {
    sortOrder: "desc",
    limit: GTFA_SIGNATURE_PAGE_LIMIT,
    blockTimeGte: start,
    blockTimeLt: end,
  });

  const lastBlockTime = recentPage.txs[0]?.blockTime ?? null;
  if (lastBlockTime == null) return null;

  if (!recentPage.nextToken) {
    const bounds = blockTimeBounds(recentPage.txs);
    const firstBlockTime = bounds?.min ?? lastBlockTime;
    return {
      firstBlockTime,
      lastBlockTime,
      estimatedTxCount: recentPage.txs.length,
      singlePageHistory: recentPage.txs.length <= GTFA_FULL_PAGE_LIMIT,
    };
  }

  const oldestPage = await gtfaSignaturePage(address, {
    sortOrder: "asc",
    limit: 1,
    blockTimeGte: start,
    blockTimeLt: end,
  });

  const firstBlockTime = oldestPage.txs[0]?.blockTime;
  if (firstBlockTime == null) return null;

  const bounds = blockTimeBounds(recentPage.txs);
  if (!bounds) {
    return {
      firstBlockTime,
      lastBlockTime,
      estimatedTxCount: recentPage.txs.length,
      singlePageHistory: false,
    };
  }

  const sampleCoveredSpan = Math.max(bounds.max - bounds.min, 1);
  const totalSpan = Math.max(bounds.max - firstBlockTime, 1);
  const estimate = Math.ceil(recentPage.txs.length * (totalSpan / sampleCoveredSpan));

  return {
    firstBlockTime,
    lastBlockTime,
    estimatedTxCount: Math.max(estimate, recentPage.txs.length),
    singlePageHistory: false,
  };
}

function optimalSliceCount(estimatedTxCount, totalSpanSecs) {
  if (totalSpanSecs < 86400 * 7) return 1;
  if (estimatedTxCount <= GTFA_SIGNATURE_PAGE_LIMIT) return 1;
  return Math.max(
    2,
    Math.min(
      Math.ceil(estimatedTxCount / TARGET_GTFA_TXS_PER_SLICE),
      MAX_TRANSACTION_SLICES,
    ),
  );
}

function createUniformSlices(startTs, endTs, count) {
  const span = endTs - startTs;
  if (span <= 0 || count <= 0) return [{ gte: startTs, lt: endTs }];

  const sliceSize = Math.ceil(span / count);
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const gte = startTs + index * sliceSize;
    const lt = Math.min(startTs + (index + 1) * sliceSize, endTs);
    if (gte < lt) slices.push({ gte, lt });
  }
  return slices;
}

async function fetchSlice(address, gte, lt, maxPages = 200) {
  if (gte >= lt) return [];

  const all = [];
  const seenTokens = new Set();
  let token;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await gtfaFullPage(address, {
      sortOrder: "asc",
      blockTimeGte: gte,
      blockTimeLt: lt,
      paginationToken: token,
    });

    all.push(...page.txs);

    if (!page.nextToken) {
      token = undefined;
      break;
    }

    if (seenTokens.has(page.nextToken)) {
      throw new Error(`GTFA balance-history pagination repeated for slice [${gte}, ${lt})`);
    }

    seenTokens.add(page.nextToken);
    token = page.nextToken;
  }

  if (token) {
    throw new SliceOverflowError(gte, lt, maxPages);
  }

  return all;
}

function buildSliceRangeFetcher(fetchSliceFn) {
  return async function fetchSliceRange(address, gte, lt, opts = {}) {
    if (gte >= lt) return [];

    const maxPages = opts.maxPages ?? 200;
    const splitDepth = opts.splitDepth ?? 0;

    try {
      return await fetchSliceFn(address, gte, lt, maxPages);
    } catch (error) {
      if (!(error instanceof SliceOverflowError)) {
        throw error;
      }

      if (splitDepth >= MAX_SLICE_SPLIT_DEPTH || lt - gte <= 1) {
        throw new Error(
          `GTFA balance-history slice [${gte}, ${lt}) is too dense to subdivide further`,
        );
      }

      const midpoint = gte + Math.floor((lt - gte) / 2);
      if (midpoint <= gte || midpoint >= lt) {
        throw error;
      }

      const [left, right] = await Promise.all([
        fetchSliceRange(address, gte, midpoint, {
          maxPages,
          splitDepth: splitDepth + 1,
        }),
        fetchSliceRange(address, midpoint, lt, {
          maxPages,
          splitDepth: splitDepth + 1,
        }),
      ]);

      return deduplicateTransactions([...left, ...right]);
    }
  };
}

const fetchSliceRange = buildSliceRangeFetcher((address, gte, lt, maxPages) =>
  fetchSlice(address, gte, lt, maxPages)
);

async function fetchTransactionsInRange(address, start, end) {
  if (start != null && end != null && start >= end) return [];

  const probe = await probeTimeline(address, start, end);
  if (!probe) return [];

  const windowStart = start ?? probe.firstBlockTime;
  const windowEnd = end ?? probe.lastBlockTime + 1;
  const totalSpan = Math.max(windowEnd - windowStart, 1);
  const sliceCount = optimalSliceCount(probe.estimatedTxCount, totalSpan);
  const slices = createUniformSlices(windowStart, windowEnd, sliceCount);
  const results = await mapWithConcurrency(
    slices,
    MAX_SLICE_CONCURRENCY,
    (slice) => fetchSliceRange(address, slice.gte, slice.lt),
  );

  return deduplicateTransactions(results.flat());
}

function deduplicateTransactions(txs) {
  const seen = new Set();
  const unique = [];
  for (const tx of txs) {
    const signature = tx?.transaction?.signatures?.[0];
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(tx);
  }
  return unique;
}

function compareTransactions(a, b) {
  const aTime = a.blockTime ?? 0;
  const bTime = b.blockTime ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  const aSlot = a.slot ?? 0;
  const bSlot = b.slot ?? 0;
  if (aSlot !== bSlot) return aSlot - bSlot;
  const aTransactionIndex = Number.isFinite(Number(a.transactionIndex))
    ? Number(a.transactionIndex)
    : null;
  const bTransactionIndex = Number.isFinite(Number(b.transactionIndex))
    ? Number(b.transactionIndex)
    : null;
  if (aTransactionIndex != null && bTransactionIndex != null && aTransactionIndex !== bTransactionIndex) {
    return aTransactionIndex - bTransactionIndex;
  }
  const aSig = a?.transaction?.signatures?.[0] ?? "";
  const bSig = b?.transaction?.signatures?.[0] ?? "";
  return aSig.localeCompare(bSig);
}

function hasSignatureOverlap(leftTxs, rightTxs) {
  const seen = new Set(
    leftTxs.map((tx) => tx?.transaction?.signatures?.[0]).filter(Boolean),
  );
  return rightTxs.some((tx) => seen.has(tx?.transaction?.signatures?.[0]));
}

function extractSolBalancePoint(tx, address) {
  const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(resolveKey);
  const walletIndex = accountKeys.indexOf(address);
  if (walletIndex < 0 || !tx.meta) return null;

  const signature = tx.transaction?.signatures?.[0];
  if (!signature) return null;

  const preBalanceLamports = Number(tx.meta.preBalances?.[walletIndex] ?? 0);
  const balanceLamports = Number(tx.meta.postBalances?.[walletIndex] ?? 0);
  const deltaLamports = balanceLamports - preBalanceLamports;

  return {
    signature,
    slot: Number(tx.slot ?? 0),
    timestamp: Number(tx.blockTime ?? 0),
    preBalanceLamports,
    balanceLamports,
    deltaLamports,
  };
}

function compressEvenly(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];

  const lastIndex = points.length - 1;
  const result = [points[0]];
  for (let index = 1; index < maxPoints - 1; index += 1) {
    const sourceIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
    const nextPoint = points[sourceIndex];
    if (result[result.length - 1] !== nextPoint) {
      result.push(nextPoint);
    }
  }
  if (result[result.length - 1] !== points[lastIndex]) {
    result.push(points[lastIndex]);
  }
  return result;
}

function downsampleBalancePoints(points, maxPoints = MAX_CHART_POINTS) {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];

  const interior = points.slice(1, -1).map((point, index) => ({ ...point, index: index + 1 }));
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const bucketSize = Math.ceil(interior.length / bucketCount);
  const sampled = [points[0]];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = bucketIndex * bucketSize;
    const bucket = interior.slice(start, start + bucketSize);
    if (bucket.length === 0) continue;

    let minPoint = bucket[0];
    let maxPoint = bucket[0];
    for (const point of bucket) {
      if (point.balanceLamports < minPoint.balanceLamports) minPoint = point;
      if (point.balanceLamports > maxPoint.balanceLamports) maxPoint = point;
    }

    const ordered = minPoint.index <= maxPoint.index
      ? [minPoint, maxPoint]
      : [maxPoint, minPoint];

    for (const point of ordered) {
      if (sampled.length >= maxPoints - 1) break;
      if (sampled[sampled.length - 1]?.signature === point.signature) continue;
      sampled.push(point);
    }

    if (sampled.length >= maxPoints - 1) break;
  }

  sampled.push(points[points.length - 1]);
  return compressEvenly(sampled, maxPoints).map(({ index, ...point }) => point);
}

function emptyHistory(address) {
  return {
    address,
    firstTimestamp: null,
    lastTimestamp: null,
    txCount: 0,
    estimatedTxCount: 0,
    currentBalanceSol: 0,
    startingBalanceSol: 0,
    netChangeSol: 0,
    minBalanceSol: 0,
    maxBalanceSol: 0,
    downsampled: false,
    strategy: "empty",
    points: [],
  };
}

function buildSolBalanceHistoryResult(address, txs, meta) {
  const ordered = deduplicateTransactions(txs).slice().sort(compareTransactions);
  const rawPoints = ordered
    .map((tx) => extractSolBalancePoint(tx, address))
    .filter(Boolean);

  if (rawPoints.length === 0) return emptyHistory(address);

  const sampledPoints = downsampleBalancePoints(rawPoints);
  const firstPoint = rawPoints[0];
  const lastPoint = rawPoints[rawPoints.length - 1];
  let minBalanceLamports = firstPoint.preBalanceLamports;
  let maxBalanceLamports = firstPoint.preBalanceLamports;

  for (const point of rawPoints) {
    if (point.balanceLamports < minBalanceLamports) minBalanceLamports = point.balanceLamports;
    if (point.balanceLamports > maxBalanceLamports) maxBalanceLamports = point.balanceLamports;
  }

  return {
    address,
    firstTimestamp: firstPoint.timestamp > 0 ? firstPoint.timestamp : null,
    lastTimestamp: lastPoint.timestamp > 0 ? lastPoint.timestamp : null,
    txCount: rawPoints.length,
    estimatedTxCount: Math.max(meta?.estimatedTxCount ?? rawPoints.length, rawPoints.length),
    currentBalanceSol: roundSol(lastPoint.balanceLamports),
    startingBalanceSol: roundSol(firstPoint.preBalanceLamports),
    netChangeSol: roundSol(lastPoint.balanceLamports - firstPoint.preBalanceLamports),
    minBalanceSol: roundSol(minBalanceLamports),
    maxBalanceSol: roundSol(maxBalanceLamports),
    downsampled: sampledPoints.length !== rawPoints.length,
    strategy: meta?.strategy ?? "two-sided-direct",
    points: sampledPoints.map((point) => ({
      signature: point.signature,
      slot: point.slot,
      timestamp: point.timestamp,
      balanceSol: roundSol(point.balanceLamports),
      deltaSol: roundSol(point.deltaLamports),
    })),
  };
}

export function buildSolBalanceHistoryAnalyzer(deps) {
  return async function analyze(address) {
    const probe = await deps.probeTimeline(address);
    if (!probe) return emptyHistory(address);

    if (probe.singlePageHistory) {
      const singlePage = await deps.fetchFrontierPage(address, {
        sortOrder: "desc",
        limit: GTFA_FULL_PAGE_LIMIT,
      });

      return buildSolBalanceHistoryResult(address, singlePage.txs, {
        estimatedTxCount: probe.estimatedTxCount,
        strategy: "two-sided-direct",
      });
    }

    const [oldestFrontier, newestFrontier] = await Promise.all([
      deps.fetchFrontierPage(address, { sortOrder: "asc", limit: GTFA_FULL_PAGE_LIMIT }),
      deps.fetchFrontierPage(address, { sortOrder: "desc", limit: GTFA_FULL_PAGE_LIMIT }),
    ]);

    let txs = deduplicateTransactions([
      ...oldestFrontier.txs,
      ...newestFrontier.txs,
    ]);
    let strategy = "two-sided-direct";

    const overlap = hasSignatureOverlap(oldestFrontier.txs, newestFrontier.txs);
    const needsGapFill = !overlap && oldestFrontier.nextToken && newestFrontier.nextToken;

    if (needsGapFill) {
      const oldestBounds = blockTimeBounds(oldestFrontier.txs);
      const newestBounds = blockTimeBounds(newestFrontier.txs);
      const gapStart = oldestBounds && newestBounds
        ? Math.min(oldestBounds.max, newestBounds.min)
        : probe.firstBlockTime;
      const gapEnd = oldestBounds && newestBounds
        ? Math.max(oldestBounds.max, newestBounds.min) + 1
        : probe.lastBlockTime + 1;

      const middleTxs = await deps.fetchTransactionsInRange(address, gapStart, gapEnd);
      txs = deduplicateTransactions([...txs, ...middleTxs]);
      strategy = "two-sided-gap-fill";
    }

    return buildSolBalanceHistoryResult(address, txs, {
      estimatedTxCount: probe.estimatedTxCount,
      strategy,
    });
  };
}

export const analyzeWalletSolBalanceHistory = buildSolBalanceHistoryAnalyzer({
  probeTimeline: (address) => probeTimeline(address),
  fetchFrontierPage: (address, opts) => gtfaFullPage(address, opts),
  fetchTransactionsInRange: (address, start, end) => fetchTransactionsInRange(address, start, end),
});

export const solBalanceHistoryInternals = {
  SliceOverflowError,
  buildSolBalanceHistoryAnalyzer,
  buildSliceRangeFetcher,
  buildSolBalanceHistoryResult,
  deduplicateTransactions,
  downsampleBalancePoints,
  extractSolBalancePoint,
};
