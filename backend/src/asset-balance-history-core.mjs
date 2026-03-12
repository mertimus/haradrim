import {
  bigintToUiAmount,
  buildTokenAccountInfo,
  NATIVE_SOL_ASSET_ID,
} from "./analysis-core.mjs";
import {
  fetchTransactions,
  getCurrentTokenBalancesByOwner,
  getTokenMetadataBatch,
} from "./providers.mjs";

const MAX_TOTAL_CHART_POINTS = 12_000;
const MAX_POINTS_PER_ASSET = 240;
const MIN_POINTS_PER_ASSET = 16;
const LAMPORTS_DECIMALS = 9;

function resolveKey(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

function compareTransactions(a, b) {
  const aTime = a?.blockTime ?? 0;
  const bTime = b?.blockTime ?? 0;
  if (aTime !== bTime) return aTime - bTime;

  const aSlot = a?.slot ?? 0;
  const bSlot = b?.slot ?? 0;
  if (aSlot !== bSlot) return aSlot - bSlot;

  const aTransactionIndex = Number.isFinite(Number(a?.transactionIndex))
    ? Number(a.transactionIndex)
    : null;
  const bTransactionIndex = Number.isFinite(Number(b?.transactionIndex))
    ? Number(b.transactionIndex)
    : null;
  if (aTransactionIndex != null && bTransactionIndex != null && aTransactionIndex !== bTransactionIndex) {
    return aTransactionIndex - bTransactionIndex;
  }

  const aSignature = a?.transaction?.signatures?.[0] ?? "";
  const bSignature = b?.transaction?.signatures?.[0] ?? "";
  return aSignature.localeCompare(bSignature);
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

function parseRawTokenAmount(balance) {
  try {
    return BigInt(balance?.uiTokenAmount?.amount ?? "0");
  } catch {
    return 0n;
  }
}

function collectWalletMintActivity(tx, walletAddress) {
  const byMint = new Map();
  const tokenAccountInfo = buildTokenAccountInfo(tx);
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map(resolveKey);

  function accumulate(balances, key) {
    for (const balance of balances ?? []) {
      const account = accountKeys[balance?.accountIndex];
      const inferred = account ? tokenAccountInfo.get(account) : undefined;
      const owner = balance?.owner ?? inferred?.owner;
      const mint = balance?.mint ?? inferred?.mint;
      if (owner !== walletAddress || !mint) continue;

      const rawAmount = parseRawTokenAmount(balance);
      const decimals = Number(balance?.uiTokenAmount?.decimals ?? inferred?.decimals ?? 0);
      const entry = byMint.get(mint) ?? {
        mint,
        decimals,
        preRaw: 0n,
        postRaw: 0n,
      };

      entry[key] += rawAmount;
      if (!Number.isFinite(entry.decimals) || entry.decimals === 0) {
        entry.decimals = decimals;
      }
      byMint.set(mint, entry);
    }
  }

  accumulate(tx?.meta?.preTokenBalances, "preRaw");
  accumulate(tx?.meta?.postTokenBalances, "postRaw");
  return byMint;
}

function extractSolPoint(tx, address) {
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map(resolveKey);
  const walletIndex = accountKeys.indexOf(address);
  if (walletIndex < 0 || !tx?.meta) return null;

  const signature = tx?.transaction?.signatures?.[0];
  if (!signature) return null;

  const preBalanceRaw = BigInt(tx.meta.preBalances?.[walletIndex] ?? 0);
  const balanceRaw = BigInt(tx.meta.postBalances?.[walletIndex] ?? 0);
  if (preBalanceRaw === balanceRaw) return null;

  return {
    signature,
    slot: Number(tx.slot ?? 0),
    timestamp: Number(tx.blockTime ?? 0),
    decimals: LAMPORTS_DECIMALS,
    preBalanceRaw,
    balanceRaw,
    deltaRaw: balanceRaw - preBalanceRaw,
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

function downsamplePoints(points, maxPoints) {
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
      if (point.balanceRaw < minPoint.balanceRaw) minPoint = point;
      if (point.balanceRaw > maxPoint.balanceRaw) maxPoint = point;
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

function assetPointBudget(assetCount) {
  return Math.max(
    MIN_POINTS_PER_ASSET,
    Math.min(MAX_POINTS_PER_ASSET, Math.floor(MAX_TOTAL_CHART_POINTS / Math.max(assetCount, 1))),
  );
}

function buildPointOutput(point) {
  return {
    signature: point.signature,
    slot: point.slot,
    timestamp: point.timestamp,
    balance: bigintToUiAmount(point.balanceRaw, point.decimals),
    delta: bigintToUiAmount(point.deltaRaw, point.decimals),
  };
}

function buildAssetHistory(asset, rawPoints, pointBudget) {
  if (rawPoints.length === 0) return null;

  const sampledPoints = downsamplePoints(rawPoints, pointBudget);
  const firstPoint = rawPoints[0];
  const lastPoint = rawPoints[rawPoints.length - 1];
  let minBalanceRaw = firstPoint.preBalanceRaw;
  let maxBalanceRaw = firstPoint.preBalanceRaw;

  for (const point of rawPoints) {
    if (point.preBalanceRaw < minBalanceRaw) minBalanceRaw = point.preBalanceRaw;
    if (point.balanceRaw < minBalanceRaw) minBalanceRaw = point.balanceRaw;
    if (point.preBalanceRaw > maxBalanceRaw) maxBalanceRaw = point.preBalanceRaw;
    if (point.balanceRaw > maxBalanceRaw) maxBalanceRaw = point.balanceRaw;
  }

  const decimals = firstPoint.decimals;
  const currentBalance = bigintToUiAmount(lastPoint.balanceRaw, decimals);

  return {
    ...asset,
    pointCount: rawPoints.length,
    firstTimestamp: firstPoint.timestamp > 0 ? firstPoint.timestamp : null,
    lastTimestamp: lastPoint.timestamp > 0 ? lastPoint.timestamp : null,
    currentBalance,
    startingBalance: bigintToUiAmount(firstPoint.preBalanceRaw, decimals),
    netChange: bigintToUiAmount(lastPoint.balanceRaw - firstPoint.preBalanceRaw, decimals),
    minBalance: bigintToUiAmount(minBalanceRaw, decimals),
    maxBalance: bigintToUiAmount(maxBalanceRaw, decimals),
    currentlyHeld: currentBalance > 0,
    downsampled: sampledPoints.length !== rawPoints.length,
    points: sampledPoints.map(buildPointOutput),
  };
}

function compareAssetHistories(a, b) {
  if (a.currentlyHeld !== b.currentlyHeld) return Number(b.currentlyHeld) - Number(a.currentlyHeld);
  if (a.kind !== b.kind) return a.kind === "native" ? -1 : 1;
  if (a.currentBalance !== b.currentBalance) return b.currentBalance - a.currentBalance;
  if (a.pointCount !== b.pointCount) return b.pointCount - a.pointCount;
  const aLabel = a.symbol ?? a.name ?? a.mint ?? a.assetId;
  const bLabel = b.symbol ?? b.name ?? b.mint ?? b.assetId;
  return aLabel.localeCompare(bLabel);
}

function normalizeTimestamp(timestamp) {
  return timestamp > 0 ? timestamp : null;
}

function buildSyntheticPoint(assetId, observation, currentRawAmount, fallbackTimestamp, decimals) {
  const latestBalanceRaw = observation?.latestBalanceRaw ?? currentRawAmount ?? 0n;
  const earliestBalanceRaw = observation?.earliestBalanceRaw ?? latestBalanceRaw;
  if (latestBalanceRaw === 0n && earliestBalanceRaw === 0n) return null;

  return {
    signature: `snapshot:${assetId}`,
    slot: 0,
    timestamp: observation?.latestTimestamp ?? fallbackTimestamp ?? 0,
    decimals,
    preBalanceRaw: earliestBalanceRaw,
    balanceRaw: latestBalanceRaw,
    deltaRaw: latestBalanceRaw - earliestBalanceRaw,
  };
}

export function analyzeWalletAssetBalanceHistory(address, deps = {}) {
  const fetchTransactionsImpl = deps.fetchTransactions ?? fetchTransactions;
  const getCurrentTokenBalancesByOwnerImpl =
    deps.getCurrentTokenBalancesByOwner ?? getCurrentTokenBalancesByOwner;
  const getTokenMetadataBatchImpl = deps.getTokenMetadataBatch ?? getTokenMetadataBatch;

  return Promise.all([
    Promise.resolve(fetchTransactionsImpl(address)),
    Promise.resolve(getCurrentTokenBalancesByOwnerImpl(address)).catch(() => new Map()),
  ]).then(async ([transactions, currentTokenBalances]) => {
    const ordered = deduplicateTransactions(transactions)
      .filter((tx) => tx?.meta && !tx.meta.err)
      .sort(compareTransactions);

    if (ordered.length === 0) {
      return {
        address,
        strategy: "gtfa-wallet-assets",
        txCount: 0,
        estimatedTxCount: 0,
        assetCount: 0,
        currentAssetCount: 0,
        historicalAssetCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        assets: [],
      };
    }

    const descending = [...ordered].reverse();
    const runningTokenBalances = new Map();
    for (const [mint, balance] of currentTokenBalances.entries()) {
      runningTokenBalances.set(mint, {
        rawAmount: BigInt(balance.rawAmount ?? 0n),
        decimals: Number(balance.decimals ?? 0),
      });
    }

    const tokenPointsByMint = new Map();
    const tokenObservations = new Map();
    const trackedMints = new Set(currentTokenBalances.keys());

    for (const tx of descending) {
      const signature = tx?.transaction?.signatures?.[0];
      if (!signature) continue;

      const timestamp = Number(tx.blockTime ?? 0);
      const touchedMints = collectWalletMintActivity(tx, address);

      for (const [mint, activity] of touchedMints.entries()) {
        const running = runningTokenBalances.get(mint) ?? {
          rawAmount: 0n,
          decimals: Number(activity.decimals ?? 0),
        };
        const decimals = Number(activity.decimals ?? running.decimals ?? 0);
        const afterRaw = running.rawAmount;
        const deltaRaw = activity.postRaw - activity.preRaw;
        const beforeRaw = afterRaw - deltaRaw;

        trackedMints.add(mint);

        const observation = tokenObservations.get(mint);
        if (!observation) {
          tokenObservations.set(mint, {
            decimals,
            latestTimestamp: normalizeTimestamp(timestamp),
            earliestTimestamp: normalizeTimestamp(timestamp),
            latestBalanceRaw: afterRaw,
            earliestBalanceRaw: beforeRaw,
          });
        } else {
          observation.decimals = observation.decimals || decimals;
          observation.earliestTimestamp = normalizeTimestamp(timestamp) ?? observation.earliestTimestamp;
          observation.earliestBalanceRaw = beforeRaw;
        }

        if (activity.preRaw > 0n || activity.postRaw > 0n || beforeRaw > 0n || afterRaw > 0n) {
          trackedMints.add(mint);
        }

        if (deltaRaw !== 0n) {
          const points = tokenPointsByMint.get(mint) ?? [];
          points.push({
            signature,
            slot: Number(tx.slot ?? 0),
            timestamp,
            decimals,
            preBalanceRaw: beforeRaw,
            balanceRaw: afterRaw,
            deltaRaw,
          });
          tokenPointsByMint.set(mint, points);
        }

        if (beforeRaw !== 0n || decimals > 0) {
          runningTokenBalances.set(mint, { rawAmount: beforeRaw, decimals });
        } else {
          runningTokenBalances.delete(mint);
        }
      }
    }

    const tokenMints = [...trackedMints];
    const tokenMetaMap = tokenMints.length > 0
      ? await getTokenMetadataBatchImpl(tokenMints).catch(() => new Map())
      : new Map();

    const firstTimestamp = normalizeTimestamp(ordered[0]?.blockTime ?? 0);
    const lastTimestamp = normalizeTimestamp(ordered[ordered.length - 1]?.blockTime ?? 0);
    const pointBudget = assetPointBudget(tokenMints.length + 1);

    const solPoints = ordered
      .map((tx) => extractSolPoint(tx, address))
      .filter(Boolean);

    const histories = [];
    const solHistory = buildAssetHistory({
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      mint: null,
      symbol: "SOL",
      name: "Native SOL",
      logoUri: undefined,
      decimals: LAMPORTS_DECIMALS,
    }, solPoints, pointBudget);
    if (solHistory) histories.push(solHistory);

    for (const mint of tokenMints) {
      const meta = tokenMetaMap.get(mint);
      const observation = tokenObservations.get(mint);
      const current = currentTokenBalances.get(mint);
      const decimals = Number(
        observation?.decimals
        ?? current?.decimals
        ?? 0,
      );

      const rawPoints = (tokenPointsByMint.get(mint) ?? []).slice().reverse();
      if (rawPoints.length === 0) {
        const syntheticPoint = buildSyntheticPoint(
          mint,
          observation,
          current?.rawAmount,
          lastTimestamp,
          decimals,
        );
        if (syntheticPoint) rawPoints.push(syntheticPoint);
      }

      const history = buildAssetHistory({
        assetId: mint,
        kind: "token",
        mint,
        symbol: meta?.symbol,
        name: meta?.name,
        logoUri: meta?.logoUri,
        decimals,
      }, rawPoints, pointBudget);

      if (history) histories.push(history);
    }

    histories.sort(compareAssetHistories);
    const currentAssetCount = histories.filter((asset) => asset.currentlyHeld).length;

    return {
      address,
      strategy: "gtfa-wallet-assets",
      txCount: ordered.length,
      estimatedTxCount: ordered.length,
      assetCount: histories.length,
      currentAssetCount,
      historicalAssetCount: histories.length - currentAssetCount,
      firstTimestamp,
      lastTimestamp,
      assets: histories,
    };
  });
}
