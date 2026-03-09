import {
  bigintToUiAmount,
  NATIVE_SOL_ASSET_ID,
  parseTraceTransferEvents,
} from "./analysis-core.mjs";
import {
  fetchTransactions,
  getAccountTypesParallel,
  getBatchIdentity,
  getTokenAccountAddressesByOwner,
  getTokenMetadataBatch,
} from "./providers.mjs";
import { KNOWN_EXCHANGES } from "./address-taxonomy.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CANDIDATE_LIMIT = 4;

function resolveKey(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

function compareTransactionsAsc(a, b) {
  const aTime = a?.blockTime ?? 0;
  const bTime = b?.blockTime ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  const aSlot = a?.slot ?? 0;
  const bSlot = b?.slot ?? 0;
  if (aSlot !== bSlot) return aSlot - bSlot;
  const aSig = a?.transaction?.signatures?.[0] ?? "";
  const bSig = b?.transaction?.signatures?.[0] ?? "";
  return aSig.localeCompare(bSig);
}

function deduplicateTransactions(txs) {
  const unique = [];
  const seen = new Set();
  for (const tx of txs.sort(compareTransactionsAsc)) {
    const signature = tx?.transaction?.signatures?.[0];
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(tx);
  }
  return unique;
}

function aggregateOwnerMintBalance(balances, owner, mint) {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance?.owner !== owner || balance?.mint !== mint) continue;
    try {
      total += BigInt(balance.uiTokenAmount?.amount ?? "0");
    } catch {
      // Ignore malformed balances from upstream.
    }
  }
  return total;
}

function getOwnerMintDecimals(tx, owner, mint) {
  for (const balance of tx?.meta?.postTokenBalances ?? []) {
    if (balance?.owner === owner && balance?.mint === mint) {
      return balance.uiTokenAmount?.decimals ?? 0;
    }
  }
  for (const balance of tx?.meta?.preTokenBalances ?? []) {
    if (balance?.owner === owner && balance?.mint === mint) {
      return balance.uiTokenAmount?.decimals ?? 0;
    }
  }
  return 0;
}

function computeOwnerMintDelta(tx, owner, mint) {
  if (!tx?.meta) return 0n;
  const pre = aggregateOwnerMintBalance(tx.meta.preTokenBalances, owner, mint);
  const post = aggregateOwnerMintBalance(tx.meta.postTokenBalances, owner, mint);
  return post - pre;
}

function getOwnerAssetBalanceBefore(tx, owner, assetId) {
  if (!tx?.meta) {
    return { rawAmount: 0n, decimals: assetId === NATIVE_SOL_ASSET_ID ? 9 : 0 };
  }

  if (assetId === NATIVE_SOL_ASSET_ID) {
    const accountKeys = (tx.transaction?.message?.accountKeys ?? []).map(resolveKey);
    const ownerIndex = accountKeys.indexOf(owner);
    const lamports = ownerIndex >= 0 ? BigInt(tx.meta.preBalances?.[ownerIndex] ?? 0) : 0n;
    return {
      rawAmount: lamports,
      decimals: 9,
    };
  }

  return {
    rawAmount: aggregateOwnerMintBalance(tx.meta.preTokenBalances, owner, assetId),
    decimals: getOwnerMintDecimals(tx, owner, assetId),
  };
}

function discoverOwnerMintTokenAccountsFromTxs(txs, owner, mint) {
  const addresses = new Set();
  for (const tx of txs) {
    const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map(resolveKey);
    for (const balance of tx?.meta?.preTokenBalances ?? []) {
      if (balance?.owner !== owner || balance?.mint !== mint) continue;
      const key = accountKeys[balance.accountIndex];
      if (key) addresses.add(key);
    }
    for (const balance of tx?.meta?.postTokenBalances ?? []) {
      if (balance?.owner !== owner || balance?.mint !== mint) continue;
      const key = accountKeys[balance.accountIndex];
      if (key) addresses.add(key);
    }
  }
  return [...addresses];
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function buildUiAmount(rawAmount, decimals) {
  return bigintToUiAmount(rawAmount, decimals);
}

function summarizeAssetOutflows(events, excludedAssetId) {
  const byAsset = new Map();

  for (const event of events) {
    if (event.direction !== "outflow" || event.assetId === excludedAssetId) continue;
    const key = event.assetId;
    const current = byAsset.get(key) ?? {
      assetId: event.assetId,
      kind: event.kind,
      mint: event.mint,
      decimals: event.decimals,
      rawAmount: 0n,
      counterparties: new Set(),
    };
    current.rawAmount += BigInt(event.rawAmount);
    current.counterparties.add(event.counterparty);
    byAsset.set(key, current);
  }

  return [...byAsset.values()].map((item) => ({
    assetId: item.assetId,
    kind: item.kind,
    mint: item.mint,
    decimals: item.decimals,
    rawAmount: item.rawAmount.toString(),
    uiAmount: buildUiAmount(item.rawAmount, item.decimals),
    counterparties: [...item.counterparties],
  }));
}

export function findFirstMintAcquisitionInTransactions(owner, mint, txs) {
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const acquiredRawAmount = computeOwnerMintDelta(tx, owner, mint);
    if (acquiredRawAmount <= 0n) continue;

    const events = parseTraceTransferEvents([tx], owner);
    const acquisitionTransfers = events.filter(
      (event) => event.direction === "inflow" && event.assetId === mint,
    );
    const paymentRequirements = summarizeAssetOutflows(events, mint);
    const decimals = getOwnerMintDecimals(tx, owner, mint);

    let classification = "unknown";
    if (acquisitionTransfers.length > 0 && paymentRequirements.length > 0) {
      classification = "purchase_or_swap";
    } else if (acquisitionTransfers.length > 0) {
      classification = "transfer_or_airdrop";
    } else if (paymentRequirements.length > 0) {
      classification = "programmatic_acquisition";
    } else {
      classification = "balance_delta_only";
    }

    return {
      signature: tx.transaction?.signatures?.[0] ?? "",
      slot: tx.slot ?? 0,
      timestamp: tx.blockTime ?? 0,
      decimals,
      acquiredRawAmount: acquiredRawAmount.toString(),
      acquiredUiAmount: buildUiAmount(acquiredRawAmount, decimals),
      classification,
      acquisitionTransfers: acquisitionTransfers.map((event) => ({
        address: event.counterparty,
        signature: event.signature,
        timestamp: event.timestamp,
        rawAmount: event.rawAmount,
        uiAmount: event.uiAmount,
        assetId: event.assetId,
        kind: event.kind,
        mint: event.mint,
        decimals: event.decimals,
      })),
      paymentRequirements,
      networkFeeSol: Number(BigInt(tx.meta.fee ?? 0)) / Number(LAMPORTS_PER_SOL),
    };
  }
  return null;
}

function chooseCandidateInflows(events, requiredRawAmount, candidateLimit) {
  const sorted = [...events].sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return b.signature.localeCompare(a.signature);
  });

  const selected = [];
  let coveredRawAmount = 0n;
  for (const event of sorted) {
    selected.push(event);
    coveredRawAmount += BigInt(event.rawAmount);
    if (coveredRawAmount >= requiredRawAmount || selected.length >= candidateLimit) break;
  }

  return {
    selected,
    coveredRawAmount,
  };
}

function classifyAttribution(requiredRawAmount, coveredRawAmount, pooledBalanceBeforeRaw, sourceCount) {
  if (sourceCount === 0 || coveredRawAmount <= 0n) return "unknown";
  if (coveredRawAmount >= requiredRawAmount && pooledBalanceBeforeRaw === 0n && sourceCount === 1) {
    return "exact";
  }
  return "possible";
}

function createContext(deps = {}) {
  return {
    fetchTransactions: deps.fetchTransactions ?? fetchTransactions,
    getTokenAccountAddressesByOwner:
      deps.getTokenAccountAddressesByOwner ?? getTokenAccountAddressesByOwner,
    getAccountTypesParallel: deps.getAccountTypesParallel ?? getAccountTypesParallel,
    getBatchIdentity: deps.getBatchIdentity ?? getBatchIdentity,
    getTokenMetadataBatch: deps.getTokenMetadataBatch ?? getTokenMetadataBatch,
    walletTxCache: new Map(),
    assetTxCache: new Map(),
    addressMetaCache: new Map(),
  };
}

async function getCachedWalletTransactions(context, address) {
  if (context.walletTxCache.has(address)) {
    return context.walletTxCache.get(address);
  }
  const promise = context.fetchTransactions(address)
    .then((txs) => deduplicateTransactions(txs))
    .catch(() => []);
  context.walletTxCache.set(address, promise);
  return promise;
}

async function getOwnerAssetTransactions(context, owner, assetId) {
  const cacheKey = `${owner}:${assetId}`;
  if (context.assetTxCache.has(cacheKey)) {
    return context.assetTxCache.get(cacheKey);
  }

  const promise = (async () => {
    if (assetId === NATIVE_SOL_ASSET_ID) {
      return getCachedWalletTransactions(context, owner);
    }

    const walletTxs = await getCachedWalletTransactions(context, owner);
    const discoveredAccounts = discoverOwnerMintTokenAccountsFromTxs(walletTxs, owner, assetId);
    const currentAccounts = await context.getTokenAccountAddressesByOwner(owner, assetId).catch(() => []);
    const tokenAccounts = [...new Set([...discoveredAccounts, ...currentAccounts])];
    if (tokenAccounts.length === 0) return walletTxs;

    const tokenAccountTxs = await Promise.all(
      tokenAccounts.map((address) =>
        context.fetchTransactions(address).catch(() => []),
      ),
    );

    return deduplicateTransactions([walletTxs, ...tokenAccountTxs].flat());
  })();

  context.assetTxCache.set(cacheKey, promise);
  return promise;
}

async function getAddressMeta(context, address) {
  if (context.addressMetaCache.has(address)) {
    return context.addressMetaCache.get(address);
  }

  const promise = Promise.allSettled([
    context.getAccountTypesParallel([address]),
    context.getBatchIdentity([address]),
  ]).then(([accountTypeResult, identityResult]) => {
    const accountType =
      accountTypeResult.status === "fulfilled"
        ? accountTypeResult.value.get(address)
        : undefined;
    const identity =
      identityResult.status === "fulfilled"
        ? identityResult.value.get(address)
        : undefined;

    const category = identity?.category ?? "";
    const label = identity?.label ?? identity?.name;
    const isExchangeLike =
      KNOWN_EXCHANGES.has(address)
      || /exchange|cex|custody/i.test(category)
      || /binance|coinbase|kraken|okx|bybit|kucoin/i.test(label ?? "");

    return {
      label,
      category,
      accountType: accountType?.type,
      isExchangeLike,
    };
  });

  context.addressMetaCache.set(address, promise);
  return promise;
}

async function buildSourceRecord(context, event, upstream, stopReason) {
  const meta = await getAddressMeta(context, event.counterparty ?? event.address);
  return {
    address: event.counterparty ?? event.address,
    label: meta.label,
    category: meta.category,
    accountType: meta.accountType,
    signature: event.signature,
    timestamp: event.timestamp,
    rawAmount: event.rawAmount,
    uiAmount: event.uiAmount,
    stopReason: stopReason ?? null,
    upstream,
  };
}

async function traceAssetTrail(
  context,
  wallet,
  assetId,
  requiredRawAmount,
  spendSignature,
  depth,
  maxDepth,
  candidateLimit,
  visitedAddresses,
) {
  const assetTxs = await getOwnerAssetTransactions(context, wallet, assetId);
  const spendIndex = assetTxs.findIndex(
    (tx) => (tx?.transaction?.signatures?.[0] ?? "") === spendSignature,
  );

  if (spendIndex < 0) {
    return {
      wallet,
      assetId,
      depth,
      attribution: "unknown",
      stopReason: "spend_signature_not_visible",
      requiredRawAmount: requiredRawAmount.toString(),
      requiredUiAmount: 0,
      balanceBeforeRawAmount: "0",
      balanceBeforeUiAmount: 0,
      pooledBalanceBeforeRawAmount: "0",
      pooledBalanceBeforeUiAmount: 0,
      coveredByCandidateSourcesRawAmount: "0",
      coveredByCandidateSourcesUiAmount: 0,
      candidateSources: [],
    };
  }

  const spendTx = assetTxs[spendIndex];
  const { rawAmount: balanceBeforeRawAmount, decimals } = getOwnerAssetBalanceBefore(
    spendTx,
    wallet,
    assetId,
  );

  const priorTxs = assetTxs.slice(0, spendIndex);
  const priorInflows = parseTraceTransferEvents(priorTxs, wallet).filter(
    (event) => event.direction === "inflow" && event.assetId === assetId,
  );

  const { selected, coveredRawAmount } = chooseCandidateInflows(
    priorInflows,
    requiredRawAmount,
    candidateLimit,
  );
  const pooledBalanceBeforeRawAmount =
    balanceBeforeRawAmount > coveredRawAmount
      ? balanceBeforeRawAmount - coveredRawAmount
      : 0n;
  const attribution = classifyAttribution(
    requiredRawAmount,
    coveredRawAmount,
    pooledBalanceBeforeRawAmount,
    selected.length,
  );

  const candidateSources = [];
  for (const event of selected) {
    const sourceAddress = event.counterparty;
    const sourceMeta = await getAddressMeta(context, sourceAddress);

    let stopReason = null;
    let upstream = null;

    if (depth >= maxDepth) {
      stopReason = "max_depth";
    } else if (visitedAddresses.has(sourceAddress)) {
      stopReason = "cycle";
    } else if (sourceMeta.isExchangeLike) {
      stopReason = "exchange_or_custody";
    } else if (sourceMeta.accountType && !["wallet", "unknown"].includes(sourceMeta.accountType)) {
      stopReason = "non_wallet_account";
    } else {
      upstream = await traceAssetTrail(
        context,
        sourceAddress,
        assetId,
        BigInt(event.rawAmount),
        event.signature,
        depth + 1,
        maxDepth,
        candidateLimit,
        new Set([...visitedAddresses, sourceAddress]),
      );
    }

    candidateSources.push(await buildSourceRecord(context, event, upstream, stopReason));
  }

  return {
    wallet,
    assetId,
    depth,
    attribution,
    stopReason: candidateSources.length === 0 ? "no_prior_inflows" : null,
    requiredRawAmount: requiredRawAmount.toString(),
    requiredUiAmount: buildUiAmount(requiredRawAmount, decimals),
    balanceBeforeRawAmount: balanceBeforeRawAmount.toString(),
    balanceBeforeUiAmount: buildUiAmount(balanceBeforeRawAmount, decimals),
    pooledBalanceBeforeRawAmount: pooledBalanceBeforeRawAmount.toString(),
    pooledBalanceBeforeUiAmount: buildUiAmount(pooledBalanceBeforeRawAmount, decimals),
    coveredByCandidateSourcesRawAmount: minBigInt(requiredRawAmount, coveredRawAmount).toString(),
    coveredByCandidateSourcesUiAmount: buildUiAmount(
      minBigInt(requiredRawAmount, coveredRawAmount),
      decimals,
    ),
    candidateSources,
  };
}

function collectAllAssetIdsFromTrail(trail, bucket = new Set()) {
  if (!trail) return bucket;
  if (trail.assetId && trail.assetId !== NATIVE_SOL_ASSET_ID) {
    bucket.add(trail.assetId);
  }
  for (const source of trail.candidateSources ?? []) {
    collectAllAssetIdsFromTrail(source.upstream, bucket);
  }
  return bucket;
}

function collectAllAssetIds(result) {
  const assetIds = new Set();
  if (result.mint) assetIds.add(result.mint);
  for (const requirement of result.acquisition?.paymentRequirements ?? []) {
    if (requirement.assetId !== NATIVE_SOL_ASSET_ID) {
      assetIds.add(requirement.assetId);
    }
    collectAllAssetIdsFromTrail(requirement.upstream, assetIds);
  }
  for (const transfer of result.acquisition?.acquisitionTransfers ?? []) {
    collectAllAssetIdsFromTrail(transfer.upstream, assetIds);
  }
  return [...assetIds];
}

function annotateTrailAssets(trail, metadataMap) {
  if (!trail) return;
  if (trail.assetId === NATIVE_SOL_ASSET_ID) {
    trail.symbol = "SOL";
    trail.name = "Native SOL";
  } else {
    const meta = metadataMap.get(trail.assetId);
    trail.symbol = meta?.symbol;
    trail.name = meta?.name;
    trail.logoUri = meta?.logoUri;
  }
  for (const source of trail.candidateSources ?? []) {
    annotateTrailAssets(source.upstream, metadataMap);
  }
}

async function annotateResultAssets(context, result) {
  const assetIds = collectAllAssetIds(result);
  const metadataMap = assetIds.length > 0
    ? await context.getTokenMetadataBatch(assetIds).catch(() => new Map())
    : new Map();

  for (const transfer of result.acquisition?.acquisitionTransfers ?? []) {
    const meta = metadataMap.get(result.mint);
    transfer.symbol = meta?.symbol;
    transfer.name = meta?.name;
    transfer.logoUri = meta?.logoUri;
    annotateTrailAssets(transfer.upstream, metadataMap);
  }

  for (const requirement of result.acquisition?.paymentRequirements ?? []) {
    if (requirement.assetId === NATIVE_SOL_ASSET_ID) {
      requirement.symbol = "SOL";
      requirement.name = "Native SOL";
    } else {
      const meta = metadataMap.get(requirement.assetId);
      requirement.symbol = meta?.symbol;
      requirement.name = meta?.name;
      requirement.logoUri = meta?.logoUri;
    }
    annotateTrailAssets(requirement.upstream, metadataMap);
  }
}

export async function analyzeWalletMintProvenance(
  wallet,
  mint,
  options = {},
  deps = {},
) {
  const maxDepth = Math.max(1, Math.min(Number(options.maxDepth ?? DEFAULT_MAX_DEPTH), 5));
  const candidateLimit = Math.max(
    1,
    Math.min(Number(options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT), 8),
  );
  const context = createContext(deps);

  const mintTxs = await getOwnerAssetTransactions(context, wallet, mint);
  const acquisition = findFirstMintAcquisitionInTransactions(wallet, mint, mintTxs);

  if (!acquisition) {
    return {
      wallet,
      mint,
      maxDepth,
      candidateLimit,
      acquisition: null,
      notes: [
        "No positive owner-level mint acquisition was found in the fetched transaction history.",
      ],
    };
  }

  const notes = [];
  const paymentRequirements = [];
  for (const requirement of acquisition.paymentRequirements) {
    const upstream = await traceAssetTrail(
      context,
      wallet,
      requirement.assetId,
      BigInt(requirement.rawAmount),
      acquisition.signature,
      1,
      maxDepth,
      candidateLimit,
      new Set([wallet]),
    );

    paymentRequirements.push({
      ...requirement,
      attribution: upstream.attribution,
      balanceBeforeRawAmount: upstream.balanceBeforeRawAmount,
      balanceBeforeUiAmount: upstream.balanceBeforeUiAmount,
      pooledBalanceBeforeRawAmount: upstream.pooledBalanceBeforeRawAmount,
      pooledBalanceBeforeUiAmount: upstream.pooledBalanceBeforeUiAmount,
      coveredByCandidateSourcesRawAmount: upstream.coveredByCandidateSourcesRawAmount,
      coveredByCandidateSourcesUiAmount: upstream.coveredByCandidateSourcesUiAmount,
      upstream,
    });
  }

  const acquisitionTransfers = [];
  for (const transfer of acquisition.acquisitionTransfers) {
    const sourceMeta = await getAddressMeta(context, transfer.address);

    let stopReason = null;
    let upstream = null;
    if (sourceMeta.isExchangeLike) {
      stopReason = "exchange_or_custody";
    } else if (sourceMeta.accountType && !["wallet", "unknown"].includes(sourceMeta.accountType)) {
      stopReason = "non_wallet_account";
    } else if (transfer.address === wallet) {
      stopReason = "self_transfer";
    } else {
      upstream = await traceAssetTrail(
        context,
        transfer.address,
        mint,
        BigInt(transfer.rawAmount),
        transfer.signature,
        1,
        maxDepth,
        candidateLimit,
        new Set([wallet, transfer.address]),
      );
    }

    acquisitionTransfers.push({
      ...transfer,
      label: sourceMeta.label,
      category: sourceMeta.category,
      accountType: sourceMeta.accountType,
      stopReason,
      upstream,
    });
  }

  if (paymentRequirements.length === 0) {
    notes.push(
      "No explicit payment-asset outflow was detected in the acquisition transaction; token origin is shown instead.",
    );
  }
  if (acquisition.classification === "balance_delta_only") {
    notes.push(
      "The acquisition was detected from owner-level balance delta only, so direct transfer counterparties were not visible in parsed instructions.",
    );
  }

  const result = {
    wallet,
    mint,
    maxDepth,
    candidateLimit,
    acquisition: {
      ...acquisition,
      acquisitionTransfers,
      paymentRequirements,
    },
    notes,
  };

  await annotateResultAssets(context, result);
  return result;
}

export const provenanceInternals = {
  classifyAttribution,
  computeOwnerMintDelta,
  deduplicateTransactions,
  discoverOwnerMintTokenAccountsFromTxs,
  findFirstMintAcquisitionInTransactions,
  getOwnerAssetBalanceBefore,
  summarizeAssetOutflows,
};
