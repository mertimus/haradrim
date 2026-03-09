import { parseTraceTransferEvents } from "./analysis-core.mjs";
import { isLikelyExchangeOrCustody } from "./address-taxonomy.mjs";
import { analyzeWalletMintProvenance, findFirstMintAcquisitionInTransactions } from "./provenance-core.mjs";
import {
  fetchTransactions,
  fetchRecentTransactions,
  getAccountTypesParallel,
  getBatchIdentity,
  getTokenAccountAddressesByOwner,
  mapWithConcurrency,
} from "./providers.mjs";
import { buildTokenHolderSnapshot } from "./token-snapshot-core.mjs";

const DEFAULT_SCOPE_LIMIT = 10;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CANDIDATE_LIMIT = 3;
const HOLDER_FETCH_CONCURRENCY = 4;
const PROVENANCE_CONCURRENCY = 2;
const FORENSIC_ACTIVITY_TX_LIMIT = 400;
const PROVENANCE_TX_LIMIT = 500;
const MIN_VISIBLE_EDGE_SCORE = 1.5;
const MIN_CLUSTER_EDGE_SCORE = 3.0;
const ACQUISITION_SYNC_SLOT_WINDOW = 25;
const MIN_WASH_CHURN_RATIO = 4;
const MIN_WASH_TURNOVER_RATIO = 1.5;
const STRONG_SHARED_VENUE_WINDOW_SECS = 30 * 60;
const MEDIUM_SHARED_VENUE_WINDOW_SECS = 6 * 60 * 60;

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function truncAddr(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function getTxSignature(tx) {
  return tx?.transaction?.signatures?.[0] ?? "";
}

function resolveKey(key) {
  return typeof key === "string" ? key : key?.pubkey ?? "";
}

function compareTransactionsAsc(a, b) {
  const aTime = a?.blockTime ?? 0;
  const bTime = b?.blockTime ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  const aSlot = a?.slot ?? 0;
  const bSlot = b?.slot ?? 0;
  if (aSlot !== bSlot) return aSlot - bSlot;
  return getTxSignature(a).localeCompare(getTxSignature(b));
}

function dedupeTransactions(txs) {
  const unique = [];
  const seen = new Set();
  for (const tx of txs) {
    const signature = getTxSignature(tx);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(tx);
  }
  return unique;
}

function pickHolderLabel(address, identityMap) {
  const identity = identityMap.get(address);
  return identity?.name ?? identity?.label ?? undefined;
}

function normalizeControllerAddresses(addresses, owner, feePayer = null) {
  return [...new Set(addresses.filter(Boolean))]
    .filter((address) => address !== owner && address !== feePayer);
}

function extractControllers(tx, owner) {
  if (!tx?.transaction?.message?.accountKeys) {
    return {
      feePayer: null,
      signers: [],
    };
  }

  const accountKeys = tx.transaction.message.accountKeys;
  const feePayer = resolveKey(accountKeys[0]) || null;
  const explicitSigners = accountKeys
    .filter((key) => typeof key === "object" && key?.signer)
    .map(resolveKey)
    .filter(Boolean);
  const signerSet = explicitSigners.length > 0
    ? explicitSigners
    : feePayer
      ? [feePayer]
      : [];

  return {
    feePayer,
    signers: normalizeControllerAddresses(signerSet, owner, feePayer),
  };
}

function mergeSourceSource(existing, next) {
  if (!existing) return next;

  const attributionRank = (value) => {
    if (value === "exact") return 3;
    if (value === "possible") return 2;
    return 1;
  };

  return {
    ...existing,
    label: existing.label ?? next.label,
    category: existing.category ?? next.category,
    pathKind: existing.pathKind === "funding" ? existing.pathKind : next.pathKind,
    attribution:
      attributionRank(next.attribution) > attributionRank(existing.attribution)
        ? next.attribution
        : existing.attribution,
    minDepth: Math.min(existing.minDepth, next.minDepth),
    sourceCount: existing.sourceCount + 1,
  };
}

function collectTrailSources(trail, sink, depth = 1) {
  if (!trail) return;
  const attribution = trail.attribution ?? "unknown";
  for (const source of trail.candidateSources ?? []) {
    if (!source?.address) continue;
    const current = sink.get(source.address);
    sink.set(source.address, mergeSourceSource(current, {
      address: source.address,
      label: source.label,
      category: source.category,
      attribution,
      minDepth: depth,
      pathKind: "funding",
      sourceCount: 1,
    }));

    if (source.upstream) {
      collectTrailSources(source.upstream, sink, depth + 1);
    }
  }
}

function collectFundingSources(provenance) {
  const sink = new Map();
  const acquisition = provenance?.acquisition;
  if (!acquisition) return sink;

  for (const requirement of acquisition.paymentRequirements ?? []) {
    if (requirement.upstream) {
      collectTrailSources(requirement.upstream, sink, 1);
    }
  }

  for (const transfer of acquisition.acquisitionTransfers ?? []) {
    if (!transfer?.address) continue;
    const current = sink.get(transfer.address);
    sink.set(transfer.address, mergeSourceSource(current, {
      address: transfer.address,
      label: transfer.label,
      category: transfer.category,
      attribution: "exact",
      minDepth: 1,
      pathKind: "acquisition_source",
      sourceCount: 1,
    }));
  }

  return sink;
}

function amountSimilarity(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

function acquisitionSyncScore(slotDelta) {
  if (slotDelta == null || slotDelta > ACQUISITION_SYNC_SLOT_WINDOW) return 0;
  if (slotDelta === 0) return 2.6;
  if (slotDelta <= 2) return 2.2;
  if (slotDelta <= 10) return 1.7;
  return 1.1;
}

function amountSimilarityScore(closeness) {
  if (closeness >= 0.98) return 1.0;
  if (closeness >= 0.9) return 0.6;
  return 0;
}

function sharedFundingScore(sourceA, sourceB, holdersFunded) {
  const exactRank = (value) => {
    if (value === "exact") return 3;
    if (value === "possible") return 2;
    return 1;
  };
  const pairRank = Math.min(exactRank(sourceA.attribution), exactRank(sourceB.attribution));
  const base = pairRank === 3 ? 3.5 : pairRank === 2 ? 2.1 : 0.8;
  const depthFactor = 1 / Math.max(1, sourceA.minDepth + sourceB.minDepth - 1);
  const exclusivityFactor = Math.min(1, 2 / Math.max(2, holdersFunded));
  return Math.min(4.2, base * depthFactor * exclusivityFactor);
}

function directTransferScore(txCount, bidirectional) {
  const base = Math.min(4.0, txCount * 1.5);
  return base + (bidirectional ? 1.0 : 0);
}

function dominantSignal(signals) {
  return [...signals]
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))[0]?.kind
    ?? "shared_funding_ancestor";
}

function edgeSummaryLines(edge) {
  const lines = [`Score ${edge.totalScore.toFixed(1)}`];
  for (const signal of edge.signals
    .slice()
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))
    .slice(0, 4)) {
    lines.push(signal.summary);
  }
  return lines;
}

function classifyAddress(address, accountTypeMap, identityMap) {
  const accountType = accountTypeMap.get(address)?.type ?? "unknown";
  const identity = identityMap.get(address);
  const category = identity?.category ?? "";
  const label = identity?.label ?? identity?.name ?? "";
  return {
    accountType,
    category,
    label,
    excluded:
      accountType !== "wallet"
      || isLikelyExchangeOrCustody(address, category, label),
  };
}

function classifyVenueAddress(address, accountTypeMap, identityMap) {
  const accountType = accountTypeMap.get(address)?.type ?? "unknown";
  const identity = identityMap.get(address);
  const category = identity?.category ?? "";
  const label = identity?.label ?? identity?.name ?? "";
  const exchangeLike = isLikelyExchangeOrCustody(address, category, label);

  return {
    accountType,
    category,
    label,
    exchangeLike,
    isVenue: (accountType === "program" || accountType === "other") && !exchangeLike,
  };
}

function intervalGapSeconds(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) {
    return Number.POSITIVE_INFINITY;
  }

  if (aEnd >= bStart && bEnd >= aStart) return 0;
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return Number.POSITIVE_INFINITY;
}

function sharedVenueTimingFactor(venueA, venueB) {
  const gapSeconds = intervalGapSeconds(
    venueA.firstSeen,
    venueA.lastSeen,
    venueB.firstSeen,
    venueB.lastSeen,
  );

  if (gapSeconds <= STRONG_SHARED_VENUE_WINDOW_SECS) return 1.2;
  if (gapSeconds <= MEDIUM_SHARED_VENUE_WINDOW_SECS) return 0.85;
  return 0.45;
}

function sharedVenueExclusivityFactor(holdersSharingVenue) {
  if (holdersSharingVenue <= 2) return 1.25;
  if (holdersSharingVenue <= 4) return 0.95;
  if (holdersSharingVenue <= 8) return 0.65;
  return 0.35;
}

function sharedTokenSourceScore(holdersSharing) {
  const exclusivity = Math.min(1.3, 6 / Math.max(3, holdersSharing + 1));
  return Math.min(5, 4.4 * exclusivity);
}

function buildTradeProfile(holder, transferEvents, mint, accountTypeMap, identityMap) {
  const venueMap = new Map();
  const buySignatures = new Set();
  const sellSignatures = new Set();
  let venueBuyUiAmount = 0;
  let venueSellUiAmount = 0;
  let firstVenueTradeAt = null;
  let lastVenueTradeAt = null;

  for (const event of transferEvents) {
    if (event.assetId !== mint || !event.counterparty) continue;
    const venueMeta = classifyVenueAddress(event.counterparty, accountTypeMap, identityMap);
    if (!venueMeta.isVenue) continue;

    const current = venueMap.get(event.counterparty) ?? {
      address: event.counterparty,
      label: venueMeta.label,
      buyTxCount: 0,
      sellTxCount: 0,
      buyUiAmount: 0,
      sellUiAmount: 0,
      buySignatures: new Set(),
      sellSignatures: new Set(),
      firstSeen: null,
      lastSeen: null,
    };

    if (event.direction === "inflow") {
      venueBuyUiAmount += event.uiAmount;
      current.buyUiAmount += event.uiAmount;
      buySignatures.add(event.signature);
      current.buySignatures.add(event.signature);
    } else {
      venueSellUiAmount += event.uiAmount;
      current.sellUiAmount += event.uiAmount;
      sellSignatures.add(event.signature);
      current.sellSignatures.add(event.signature);
    }

    current.buyTxCount = current.buySignatures.size;
    current.sellTxCount = current.sellSignatures.size;
    current.firstSeen =
      current.firstSeen == null ? event.timestamp : Math.min(current.firstSeen, event.timestamp);
    current.lastSeen =
      current.lastSeen == null ? event.timestamp : Math.max(current.lastSeen, event.timestamp);
    venueMap.set(event.counterparty, current);

    firstVenueTradeAt =
      firstVenueTradeAt == null ? event.timestamp : Math.min(firstVenueTradeAt, event.timestamp);
    lastVenueTradeAt =
      lastVenueTradeAt == null ? event.timestamp : Math.max(lastVenueTradeAt, event.timestamp);
  }

  const grossTradeUiAmount = venueBuyUiAmount + venueSellUiAmount;
  const netTradeUiAmount = Math.abs(venueBuyUiAmount - venueSellUiAmount);

  return {
    venueMap,
    venueBuyUiAmount,
    venueSellUiAmount,
    grossTradeUiAmount,
    netTradeUiAmount,
    twoWayTrade: buySignatures.size > 0 && sellSignatures.size > 0,
    venueTradeTxCount: buySignatures.size + sellSignatures.size,
    firstVenueTradeAt,
    lastVenueTradeAt,
    turnoverRatio: grossTradeUiAmount / Math.max(holder.uiAmount, 1e-9),
  };
}

function rankSharedTradingVenues(profileA, profileB, venueHolderCounts) {
  const ranked = [];

  for (const [address, venueA] of profileA.venueMap.entries()) {
    const venueB = profileB.venueMap.get(address);
    if (!venueB) continue;
    const twoWayShared =
      venueA.buyUiAmount > 0
      && venueA.sellUiAmount > 0
      && venueB.buyUiAmount > 0
      && venueB.sellUiAmount > 0;
    const holdersSharingVenue = venueHolderCounts.get(address) ?? 2;
    const score = Number(
      (
        (twoWayShared ? 1.4 : 0.55)
        * sharedVenueExclusivityFactor(holdersSharingVenue)
        * sharedVenueTimingFactor(venueA, venueB)
      ).toFixed(2)
    );
    if (score < 0.45) continue;
    ranked.push({
      address,
      label: venueA.label ?? venueB.label,
      holdersSharing: holdersSharingVenue,
      score,
      twoWayShared,
    });
  }

  return ranked.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

function ensureEdge(edgeMap, a, b) {
  const [source, target] = a < b ? [a, b] : [b, a];
  const key = pairKey(source, target);
  let edge = edgeMap.get(key);
  if (!edge) {
    edge = {
      source,
      target,
      transferPairs: new Set(),
      sourceToTargetSignatures: new Set(),
      targetToSourceSignatures: new Set(),
      firstSeen: 0,
      lastSeen: 0,
      synchronizedAcquisition: false,
      acquisitionSlotDelta: null,
      amountSimilarityCloseness: null,
      sharedFundingAncestors: [],
      sharedFeePayer: null,
      sharedSigners: [],
      sharedTradingVenues: [],
      sharedTokenSource: null,
      signals: [],
    };
    edgeMap.set(key, edge);
  }
  return edge;
}

function addTransferEvidence(edgeMap, holders, holderAnalyses, mint) {
  const scope = new Set(holders.map((holder) => holder.address));

  for (const holder of holders) {
    const analysis = holderAnalyses.get(holder.address);
    if (!analysis) continue;

    for (const event of analysis.transferEvents) {
      if (event.assetId !== mint || !scope.has(event.counterparty)) continue;

      const eventSource =
        event.direction === "outflow"
          ? holder.address
          : event.counterparty;
      const eventTarget =
        event.direction === "outflow"
          ? event.counterparty
          : holder.address;
      const edge = ensureEdge(edgeMap, eventSource, eventTarget);
      edge.transferPairs.add(`${event.signature}:${eventSource}->${eventTarget}`);

      if (edge.source === eventSource) {
        edge.sourceToTargetSignatures.add(event.signature);
      } else {
        edge.targetToSourceSignatures.add(event.signature);
      }

      edge.firstSeen = edge.firstSeen === 0
        ? event.timestamp
        : Math.min(edge.firstSeen, event.timestamp);
      edge.lastSeen = Math.max(edge.lastSeen, event.timestamp);
    }
  }
}

function buildClusters(edges, holdersByAddress, holderAnalyses) {
  const clusterEdges = edges.filter((edge) => edge.totalScore >= MIN_CLUSTER_EDGE_SCORE);
  if (clusterEdges.length === 0) return [];

  const adjacency = new Map();
  for (const edge of clusterEdges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }

  const visited = new Set();
  const clusters = [];

  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack = [start];
    const members = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      members.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }

    if (members.length < 2) continue;

    const memberSet = new Set(members);
    const internalEdges = clusterEdges.filter(
      (edge) => memberSet.has(edge.source) && memberSet.has(edge.target),
    );
    const totalPct = members.reduce(
      (sum, address) => sum + (holdersByAddress.get(address)?.percentage ?? 0),
      0,
    );

    const sharedFundingPairs = internalEdges.filter((edge) => edge.sharedFundingCount > 0).length;
    const synchronizedPairs = internalEdges.filter((edge) => edge.synchronizedAcquisition).length;
    const directTransferEdges = internalEdges.filter((edge) => edge.directTransferTxCount > 0).length;
    const reciprocalTransferEdges = internalEdges.filter((edge) => edge.bidirectional).length;
    const feePayerPairs = internalEdges.filter((edge) => edge.signalKinds.includes("shared_fee_payer")).length;
    const signerPairs = internalEdges.filter((edge) => edge.signalKinds.includes("shared_signer")).length;
    const sharedTokenSourcePairs = internalEdges.filter((edge) => edge.signalKinds.includes("shared_token_source")).length;
    const sharedTradingVenuePairs = internalEdges.filter((edge) => edge.signalKinds.includes("shared_trading_venue")).length;
    const sharedControlPairs = internalEdges.filter(
      (edge) => edge.signalKinds.includes("shared_fee_payer") || edge.signalKinds.includes("shared_signer"),
    ).length;
    const multiSignalEdges = internalEdges.filter((edge) => edge.signalKinds.length > 1).length;
    const totalUiAmount = members.reduce(
      (sum, address) => sum + (holdersByAddress.get(address)?.uiAmount ?? 0),
      0,
    );
    const tradeProfiles = members
      .map((address) => holderAnalyses.get(address)?.tradeProfile)
      .filter(Boolean);
    const venueUsageCounts = new Map();
    for (const profile of tradeProfiles) {
      for (const address of profile.venueMap.keys()) {
        venueUsageCounts.set(address, (venueUsageCounts.get(address) ?? 0) + 1);
      }
    }
    const sharedTradingVenueCount = [...venueUsageCounts.values()].filter((count) => count >= 2).length;
    const twoWayTradeWallets = tradeProfiles.filter((profile) => profile.twoWayTrade).length;
    const grossTradeUiAmount = tradeProfiles.reduce((sum, profile) => sum + profile.grossTradeUiAmount, 0);
    const netTradeUiAmount = Math.abs(
      tradeProfiles.reduce(
        (sum, profile) => sum + (profile.venueBuyUiAmount - profile.venueSellUiAmount),
        0,
      ),
    );
    const churnRatio = Number(
      (
        grossTradeUiAmount
        / Math.max(netTradeUiAmount, totalUiAmount * 0.05, 1e-9)
      ).toFixed(2)
    );
    const turnoverRatio = Number((grossTradeUiAmount / Math.max(totalUiAmount, 1e-9)).toFixed(2));
    const internalScore = internalEdges.reduce((sum, edge) => sum + edge.totalScore, 0);
    const washLike =
      twoWayTradeWallets >= 2
      && sharedTradingVenueCount > 0
      && (churnRatio >= MIN_WASH_CHURN_RATIO || turnoverRatio >= MIN_WASH_TURNOVER_RATIO)
      && (sharedTradingVenuePairs > 0 || sharedControlPairs > 0 || sharedFundingPairs > 0 || sharedTokenSourcePairs > 0 || reciprocalTransferEdges > 0);
    const washBonus = washLike
      ? Math.min(3, sharedTradingVenuePairs * 0.6 + twoWayTradeWallets * 0.5 + Math.max(0, churnRatio - MIN_WASH_CHURN_RATIO) * 0.15)
      : 0;
    const riskScore = Number(
      (
        internalScore / Math.max(1, members.length - 1)
        + multiSignalEdges * 0.6
        + feePayerPairs * 0.9
        + signerPairs * 0.8
        + sharedTokenSourcePairs * 0.7
        + washBonus
      ).toFixed(1)
    );

    let label = "Mixed Coordination";
    const controllerSupportPairs =
      sharedFundingPairs
      + sharedTokenSourcePairs
      + synchronizedPairs
      + directTransferEdges
      + sharedTradingVenuePairs;
    const controllerDominates =
      sharedControlPairs > 0
      && sharedControlPairs >= Math.ceil(internalEdges.length * 0.6)
      && (multiSignalEdges > 0 || controllerSupportPairs > 0);
    if (washLike) {
      label = "Wash-Like Trading";
    } else if (sharedControlPairs > 0 && sharedTokenSourcePairs > 0) {
      label = "Controller-Linked Distribution";
    } else if (controllerDominates) {
      label = "Controller-Linked Cluster";
    } else if (sharedTokenSourcePairs > 0 && synchronizedPairs > 0) {
      label = "Shared-Source Bundle";
    } else if (sharedFundingPairs > 0 && synchronizedPairs > 0) {
      label = "Shared-Funding Bundle";
    } else if (synchronizedPairs > 0) {
      label = "Launch Coordination";
    } else if (sharedTokenSourcePairs > 0) {
      label = "Direct Distribution Ring";
    } else if (reciprocalTransferEdges > 0) {
      label = "Transfer Ring";
    } else if (directTransferEdges > 0) {
      label = "Distributor Ring";
    } else if (sharedFundingPairs > 0) {
      label = "Shared Funding Ring";
    }

    const reasons = [];
    if (washLike) reasons.push(`${twoWayTradeWallets} wallet${twoWayTradeWallets === 1 ? "" : "s"} show two-way venue trading with churn ${churnRatio.toFixed(1)}x`);
    if (feePayerPairs > 0) reasons.push(`${feePayerPairs} pair${feePayerPairs === 1 ? "" : "s"} share an external fee payer`);
    if (signerPairs > 0) reasons.push(`${signerPairs} pair${signerPairs === 1 ? "" : "s"} share external signers`);
    if (sharedTokenSourcePairs > 0) reasons.push(`${sharedTokenSourcePairs} pair${sharedTokenSourcePairs === 1 ? "" : "s"} share a direct token source`);
    if (sharedFundingPairs > 0) reasons.push(`${sharedFundingPairs} pair${sharedFundingPairs === 1 ? "" : "s"} share acquisition funding sources`);
    if (synchronizedPairs > 0) reasons.push(`${synchronizedPairs} pair${synchronizedPairs === 1 ? "" : "s"} entered in a tight acquisition window`);
    if (directTransferEdges > 0) reasons.push(`${directTransferEdges} direct token transfer edge${directTransferEdges === 1 ? "" : "s"} inside the cluster`);
    if (sharedTradingVenueCount > 0) reasons.push(`${sharedTradingVenueCount} shared non-wallet trading venue${sharedTradingVenueCount === 1 ? "" : "s"} across the cluster`);
    if (multiSignalEdges > 0) reasons.push(`${multiSignalEdges} edge${multiSignalEdges === 1 ? "" : "s"} carry multiple signals`);

    clusters.push({
      id: clusters.length,
      members: members.sort((a, b) => (holdersByAddress.get(b)?.percentage ?? 0) - (holdersByAddress.get(a)?.percentage ?? 0)),
      totalPct,
      edgeCount: internalEdges.length,
      internalScore,
      riskScore,
      label,
      reasons: reasons.slice(0, 4),
      directTransferEdges,
      reciprocalTransferEdges,
      synchronizedPairs,
      sharedFundingPairs,
      multiSignalEdges,
      sharedTokenSourcePairs,
      sharedControlPairs,
      sharedFeePayerPairs: feePayerPairs,
      sharedSignerPairs: signerPairs,
      sharedTradingVenuePairs,
      twoWayTradeWallets,
      sharedTradingVenueCount,
      grossTradeUiAmount,
      netTradeUiAmount,
      churnRatio,
    });
  }

  return clusters.sort((a, b) => b.riskScore - a.riskScore || b.totalPct - a.totalPct);
}

function rankSharedFunding(commonSources, sourceHolderCounts) {
  const ranked = [];
  for (const [address, sourceA, sourceB] of commonSources) {
    const holdersFunded = sourceHolderCounts.get(address) ?? 2;
    const score = sharedFundingScore(sourceA, sourceB, holdersFunded);
    if (score <= 0.75) continue;

    ranked.push({
      address,
      label: sourceA.label ?? sourceB.label,
      depthFromSource: sourceA.minDepth,
      depthFromTarget: sourceB.minDepth,
      holdersFunded,
      score,
    });
  }

  return ranked.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

function findTransactionBySignature(txs, signature) {
  if (!signature) return null;
  return txs.find((tx) => getTxSignature(tx) === signature) ?? null;
}

export async function analyzeTokenForensics(mint, options = {}, deps = {}) {
  const scopeLimit = clampInt(options.scopeLimit, 5, 50, DEFAULT_SCOPE_LIMIT);
  const maxDepth = clampInt(options.maxDepth, 1, 5, DEFAULT_MAX_DEPTH);
  const candidateLimit = clampInt(options.candidateLimit, 1, 6, DEFAULT_CANDIDATE_LIMIT);

  const buildSnapshot = deps.buildTokenHolderSnapshot ?? buildTokenHolderSnapshot;
  const fetchTxs = deps.fetchTransactions ?? fetchTransactions;
  const fetchRecentTxs = deps.fetchRecentTransactions ?? fetchRecentTransactions;
  const batchIdentity = deps.getBatchIdentity ?? getBatchIdentity;
  const getAccountTypes = deps.getAccountTypesParallel ?? getAccountTypesParallel;
  const getTokenAccountsByOwner = deps.getTokenAccountAddressesByOwner ?? getTokenAccountAddressesByOwner;
  const provenanceFn = deps.analyzeWalletMintProvenance ?? analyzeWalletMintProvenance;
  const useBudgetedFetches = deps.fetchRecentTransactions != null || deps.fetchTransactions == null;
  const addressTxCache = new Map();

  async function fetchAddressTxs(address) {
    if (!addressTxCache.has(address)) {
      addressTxCache.set(
        address,
        Promise.resolve(
          useBudgetedFetches
            ? fetchRecentTxs(address, { limit: FORENSIC_ACTIVITY_TX_LIMIT })
            : fetchTxs(address),
        )
          .then((txs) => [...txs].sort(compareTransactionsAsc))
          .catch(() => []),
      );
    }
    return addressTxCache.get(address);
  }

  async function fetchMintActivityTxs(owner) {
    const tokenAccounts = await getTokenAccountsByOwner(owner, mint).catch(() => []);
    if (tokenAccounts.length === 0) {
      return fetchAddressTxs(owner);
    }

    const tokenAccountTxs = await mapWithConcurrency(
      tokenAccounts,
      HOLDER_FETCH_CONCURRENCY,
      (address) => fetchAddressTxs(address),
    );
    const combined = dedupeTransactions(tokenAccountTxs.flat()).sort(compareTransactionsAsc);
    if (combined.length > 0) return combined;
    return fetchAddressTxs(owner);
  }

  async function resolveAcquisitionTx(owner, acquisitionSignature, mintActivityTxs = null) {
    if (!acquisitionSignature) return null;
    const directMatch = findTransactionBySignature(
      mintActivityTxs ?? await fetchMintActivityTxs(owner),
      acquisitionSignature,
    );
    if (directMatch) return directMatch;

    const walletTxs = await fetchAddressTxs(owner);
    return findTransactionBySignature(walletTxs, acquisitionSignature);
  }

  const snapshot = await buildSnapshot(mint);
  const scopedHolders = snapshot.holders.slice(0, scopeLimit);
  const scopeAddresses = scopedHolders.map((holder) => holder.owner);
  const holderPctByAddress = new Map(scopedHolders.map((holder) => [holder.owner, holder]));

  const holderIdentityMap = await batchIdentity(scopeAddresses).catch(() => new Map());

  const txEntries = await mapWithConcurrency(
    scopedHolders,
    HOLDER_FETCH_CONCURRENCY,
    async (holder) => [holder.owner, await fetchMintActivityTxs(holder.owner)],
  );
  const txsByHolder = new Map(txEntries);

  const holderAnalyses = new Map();
  const relatedAddresses = new Set();
  const sourceHolderCounts = new Map();

  for (const holder of scopedHolders) {
    const txs = txsByHolder.get(holder.owner) ?? [];
    const acquisition = findFirstMintAcquisitionInTransactions(holder.owner, mint, txs);
    const acquisitionTx = acquisition
      ? findTransactionBySignature(txs, acquisition.signature)
        ?? await resolveAcquisitionTx(holder.owner, acquisition.signature, txs)
      : null;
    const controllers = extractControllers(acquisitionTx, holder.owner);
    const transferEvents = parseTraceTransferEvents(txs, holder.owner);

    if (controllers.feePayer) relatedAddresses.add(controllers.feePayer);
    for (const signer of controllers.signers) relatedAddresses.add(signer);
    for (const transfer of acquisition?.acquisitionTransfers ?? []) {
      if (transfer.address) relatedAddresses.add(transfer.address);
    }
    for (const event of transferEvents) {
      if (event.assetId === mint && event.counterparty) {
        relatedAddresses.add(event.counterparty);
      }
    }

    holderAnalyses.set(holder.owner, {
      address: holder.owner,
      uiAmount: holder.uiAmount,
      percentage: holder.percentage,
      label: pickHolderLabel(holder.owner, holderIdentityMap),
      acquisition,
      feePayer: controllers.feePayer,
      signers: controllers.signers,
      fundingSources: new Map(),
      transferEvents,
      notes: [],
    });
  }

  const relatedIdentityMap = await batchIdentity([...relatedAddresses]).catch(() => new Map());
  const accountTypeMap = await getAccountTypes([...relatedAddresses]).catch(() => new Map());

  const venueHolderCounts = new Map();
  for (const holder of scopedHolders) {
    const analysis = holderAnalyses.get(holder.owner);
    if (!analysis) continue;
    analysis.tradeProfile = buildTradeProfile(
      holder,
      analysis.transferEvents,
      mint,
      accountTypeMap,
      relatedIdentityMap,
    );
    for (const venueAddress of analysis.tradeProfile.venueMap.keys()) {
      venueHolderCounts.set(venueAddress, (venueHolderCounts.get(venueAddress) ?? 0) + 1);
    }
  }

  const edgeMap = new Map();
  addTransferEvidence(edgeMap, scopedHolders.map((holder) => ({ address: holder.owner })), holderAnalyses, mint);

  for (let i = 0; i < scopedHolders.length; i += 1) {
    for (let j = i + 1; j < scopedHolders.length; j += 1) {
      const a = holderAnalyses.get(scopedHolders[i].owner);
      const b = holderAnalyses.get(scopedHolders[j].owner);
      if (!a || !b) continue;

      const edge = ensureEdge(edgeMap, a.address, b.address);

      if (a.acquisition?.slot != null && b.acquisition?.slot != null) {
        const slotDelta = Math.abs(a.acquisition.slot - b.acquisition.slot);
        edge.acquisitionSlotDelta = slotDelta;
        const syncScore = acquisitionSyncScore(slotDelta);
        if (syncScore > 0) {
          edge.synchronizedAcquisition = true;
          edge.signals.push({
            kind: "synchronized_acquisition",
            score: syncScore,
            summary: `${slotDelta === 0 ? "Same-slot" : `${slotDelta}-slot`} first acquisition window`,
          });
        }

        const closeness = amountSimilarity(
          a.acquisition.acquiredUiAmount,
          b.acquisition.acquiredUiAmount,
        );
        edge.amountSimilarityCloseness = closeness;
        const similarityScore = slotDelta <= ACQUISITION_SYNC_SLOT_WINDOW
          ? amountSimilarityScore(closeness)
          : 0;
        if (similarityScore > 0) {
          edge.signals.push({
            kind: "amount_similarity",
            score: similarityScore,
            summary: `Entry sizes within ${(100 - closeness * 100).toFixed(1)}%`,
          });
        }
      }

      if (a.feePayer && a.feePayer === b.feePayer) {
        const feePayerMeta = classifyAddress(a.feePayer, accountTypeMap, relatedIdentityMap);
        if (!feePayerMeta.excluded) {
          const feePayerScore = 4.4;
          edge.sharedFeePayer = {
            address: a.feePayer,
            label: relatedIdentityMap.get(a.feePayer)?.name,
            holdersSharing: 2,
            score: feePayerScore,
          };
          edge.signals.push({
            kind: "shared_fee_payer",
            score: feePayerScore,
            summary: `Shared external fee payer ${relatedIdentityMap.get(a.feePayer)?.name ?? truncAddr(a.feePayer)}`,
          });
        }
      }

      const commonSigners = a.signers.filter((signer) => b.signers.includes(signer));
      const strongSigners = commonSigners.filter((signer) => !classifyAddress(signer, accountTypeMap, relatedIdentityMap).excluded);
      if (strongSigners.length > 0) {
        const signerScore = Math.min(5, 3.3 + (strongSigners.length - 1) * 0.6);
        edge.sharedSigners = strongSigners.map((address) => ({
          address,
          label: relatedIdentityMap.get(address)?.name,
          holdersSharing: 2,
          score: signerScore,
        }));
        edge.signals.push({
          kind: "shared_signer",
          score: signerScore,
          summary: `${strongSigners.length} shared external signer${strongSigners.length === 1 ? "" : "s"}`,
        });
      }

      const commonFundingSources = [];
      const commonTokenSources = [];
      for (const [address, sourceA] of a.fundingSources.entries()) {
        const sourceB = b.fundingSources.get(address);
        if (!sourceB) continue;
        const sourceMeta = classifyAddress(address, accountTypeMap, relatedIdentityMap);
        if (sourceMeta.excluded) continue;
        if (sourceA.pathKind === "acquisition_source" && sourceB.pathKind === "acquisition_source") {
          commonTokenSources.push([address, sourceA, sourceB]);
          continue;
        }
        commonFundingSources.push([address, sourceA, sourceB]);
      }

      if (commonTokenSources.length > 0) {
        const rankedTokenSources = commonTokenSources
          .map(([address, sourceA, sourceB]) => {
            const holdersSharing = sourceHolderCounts.get(address) ?? 2;
            return {
              address,
              label: sourceA.label ?? sourceB.label,
              holdersSharing,
              score: sharedTokenSourceScore(holdersSharing),
            };
          })
          .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
        const topTokenSource = rankedTokenSources[0];
        edge.sharedTokenSource = {
          address: topTokenSource.address,
          label: topTokenSource.label,
          holdersSharing: topTokenSource.holdersSharing,
          score: topTokenSource.score,
        };
        edge.signals.push({
          kind: "shared_token_source",
          score: topTokenSource.score,
          summary: `Shared direct token source ${topTokenSource.label ?? truncAddr(topTokenSource.address)}`,
        });
      }

      const rankedFunding = rankSharedFunding(commonFundingSources, sourceHolderCounts);
      if (rankedFunding.length > 0) {
        edge.sharedFundingAncestors = rankedFunding.slice(0, 3);
        const strongestFunding = rankedFunding[0];
        edge.signals.push({
          kind: "shared_funding_ancestor",
          score: strongestFunding.score,
          summary: `Shared funding source ${strongestFunding.label ?? truncAddr(strongestFunding.address)}`,
        });
      }

      const rankedSharedVenues = rankSharedTradingVenues(a.tradeProfile, b.tradeProfile, venueHolderCounts);
      if (rankedSharedVenues.length > 0) {
        edge.sharedTradingVenues = rankedSharedVenues.slice(0, 3).map((venue) => ({
          address: venue.address,
          label: venue.label,
          holdersSharing: venue.holdersSharing,
          score: venue.score,
        }));
        const topSharedVenue = rankedSharedVenues[0];
        edge.signals.push({
          kind: "shared_trading_venue",
          score: topSharedVenue.score,
          summary: `Shared trading venue ${topSharedVenue.label ?? truncAddr(topSharedVenue.address)}`,
        });
      }
    }
  }

  const provenanceCandidateAddresses = new Set();
  for (const holder of scopedHolders) {
    const analysis = holderAnalyses.get(holder.owner);
    if (!analysis) continue;
    if (!analysis.acquisition && (txsByHolder.get(holder.owner)?.length ?? 0) > 0) {
      provenanceCandidateAddresses.add(holder.owner);
    }
  }
  for (const edge of edgeMap.values()) {
    const hasStrongPreliminarySignal =
      edge.transferPairs.size > 0
      || edge.signals.some((signal) => signal.kind !== "amount_similarity");
    if (!hasStrongPreliminarySignal) continue;
    provenanceCandidateAddresses.add(edge.source);
    provenanceCandidateAddresses.add(edge.target);
  }

  const provenanceEntries = await mapWithConcurrency(
    [...provenanceCandidateAddresses],
    PROVENANCE_CONCURRENCY,
    async (address) => {
      try {
        const result = await provenanceFn(
          address,
          mint,
          { maxDepth, candidateLimit },
          useBudgetedFetches
            ? {
                fetchTransactions: (txAddress) =>
                  fetchRecentTxs(txAddress, { limit: PROVENANCE_TX_LIMIT }),
                getTokenAccountAddressesByOwner: getTokenAccountsByOwner,
                getAccountTypesParallel: getAccountTypes,
                getBatchIdentity: batchIdentity,
              }
            : {},
        );
        return [address, result];
      } catch (error) {
        return [
          address,
          {
            wallet: address,
            mint,
            maxDepth,
            candidateLimit,
            acquisition: null,
            notes: [
              error instanceof Error
                ? error.message
                : "Provenance unavailable.",
            ],
          },
        ];
      }
    },
  );

  const newRelatedAddresses = new Set();
  for (const [address, provenance] of provenanceEntries) {
    const analysis = holderAnalyses.get(address);
    if (!analysis) continue;
    analysis.fundingSources = collectFundingSources(provenance);
    analysis.notes = [...new Set([...(analysis.notes ?? []), ...(provenance?.notes ?? [])])];
    const shouldAdoptProvenanceAcquisition =
      provenance?.acquisition
      && (
        !analysis.acquisition
        || analysis.acquisition.signature !== provenance.acquisition.signature
        || !analysis.feePayer
        || analysis.signers.length === 0
      );
    if (shouldAdoptProvenanceAcquisition) {
      analysis.acquisition = provenance.acquisition;
      const txs = txsByHolder.get(address) ?? [];
      const acquisitionTx = await resolveAcquisitionTx(address, provenance.acquisition.signature, txs);
      const controllers = extractControllers(acquisitionTx, address);
      if (controllers.feePayer) {
        analysis.feePayer = controllers.feePayer;
        newRelatedAddresses.add(controllers.feePayer);
      }
      if (controllers.signers.length > 0) {
        analysis.signers = controllers.signers;
        for (const signer of controllers.signers) {
          newRelatedAddresses.add(signer);
        }
      }
    }

    for (const sourceAddress of analysis.fundingSources.keys()) {
      newRelatedAddresses.add(sourceAddress);
      sourceHolderCounts.set(sourceAddress, (sourceHolderCounts.get(sourceAddress) ?? 0) + 1);
    }
  }

  if (newRelatedAddresses.size > 0) {
    const [extraIdentityMap, extraAccountTypeMap] = await Promise.all([
      batchIdentity([...newRelatedAddresses]).catch(() => new Map()),
      getAccountTypes([...newRelatedAddresses]).catch(() => new Map()),
    ]);
    for (const [address, identity] of extraIdentityMap.entries()) {
      relatedIdentityMap.set(address, identity);
    }
    for (const [address, accountType] of extraAccountTypeMap.entries()) {
      accountTypeMap.set(address, accountType);
    }
  }

  for (let i = 0; i < scopedHolders.length; i += 1) {
    for (let j = i + 1; j < scopedHolders.length; j += 1) {
      const a = holderAnalyses.get(scopedHolders[i].owner);
      const b = holderAnalyses.get(scopedHolders[j].owner);
      if (!a || !b) continue;

      const edge = ensureEdge(edgeMap, a.address, b.address);

      if (
        !edge.signals.some((signal) => signal.kind === "synchronized_acquisition")
        && a.acquisition?.slot != null
        && b.acquisition?.slot != null
      ) {
        const slotDelta = Math.abs(a.acquisition.slot - b.acquisition.slot);
        edge.acquisitionSlotDelta = slotDelta;
        const syncScore = acquisitionSyncScore(slotDelta);
        if (syncScore > 0) {
          edge.synchronizedAcquisition = true;
          edge.signals.push({
            kind: "synchronized_acquisition",
            score: syncScore,
            summary: `${slotDelta === 0 ? "Same-slot" : `${slotDelta}-slot`} first acquisition window`,
          });
        }

        const closeness = amountSimilarity(
          a.acquisition.acquiredUiAmount,
          b.acquisition.acquiredUiAmount,
        );
        edge.amountSimilarityCloseness = closeness;
        const similarityScore = slotDelta <= ACQUISITION_SYNC_SLOT_WINDOW
          ? amountSimilarityScore(closeness)
          : 0;
        if (similarityScore > 0 && !edge.signals.some((signal) => signal.kind === "amount_similarity")) {
          edge.signals.push({
            kind: "amount_similarity",
            score: similarityScore,
            summary: `Entry sizes within ${(100 - closeness * 100).toFixed(1)}%`,
          });
        }
      }

      if (!edge.sharedFeePayer && a.feePayer && a.feePayer === b.feePayer) {
        const feePayerMeta = classifyAddress(a.feePayer, accountTypeMap, relatedIdentityMap);
        if (!feePayerMeta.excluded) {
          const feePayerScore = 4.4;
          edge.sharedFeePayer = {
            address: a.feePayer,
            label: relatedIdentityMap.get(a.feePayer)?.name,
            holdersSharing: 2,
            score: feePayerScore,
          };
          edge.signals.push({
            kind: "shared_fee_payer",
            score: feePayerScore,
            summary: `Shared external fee payer ${relatedIdentityMap.get(a.feePayer)?.name ?? truncAddr(a.feePayer)}`,
          });
        }
      }

      if (!edge.sharedSigners?.length) {
        const commonSigners = a.signers.filter((signer) => b.signers.includes(signer));
        const strongSigners = commonSigners.filter((signer) => !classifyAddress(signer, accountTypeMap, relatedIdentityMap).excluded);
        if (strongSigners.length > 0) {
          const signerScore = Math.min(5, 3.3 + (strongSigners.length - 1) * 0.6);
          edge.sharedSigners = strongSigners.map((signerAddress) => ({
            address: signerAddress,
            label: relatedIdentityMap.get(signerAddress)?.name,
            holdersSharing: 2,
            score: signerScore,
          }));
          edge.signals.push({
            kind: "shared_signer",
            score: signerScore,
            summary: `${strongSigners.length} shared external signer${strongSigners.length === 1 ? "" : "s"}`,
          });
        }
      }

      const commonFundingSources = [];
      const commonTokenSources = [];
      for (const [address, sourceA] of a.fundingSources.entries()) {
        const sourceB = b.fundingSources.get(address);
        if (!sourceB) continue;
        const sourceMeta = classifyAddress(address, accountTypeMap, relatedIdentityMap);
        if (sourceMeta.excluded) continue;
        if (sourceA.pathKind === "acquisition_source" && sourceB.pathKind === "acquisition_source") {
          commonTokenSources.push([address, sourceA, sourceB]);
          continue;
        }
        commonFundingSources.push([address, sourceA, sourceB]);
      }

      if (!edge.sharedTokenSource && commonTokenSources.length > 0) {
        const rankedTokenSources = commonTokenSources
          .map(([address, sourceA, sourceB]) => {
            const holdersSharing = sourceHolderCounts.get(address) ?? 2;
            return {
              address,
              label: sourceA.label ?? sourceB.label,
              holdersSharing,
              score: sharedTokenSourceScore(holdersSharing),
            };
          })
          .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
        const topTokenSource = rankedTokenSources[0];
        edge.sharedTokenSource = {
          address: topTokenSource.address,
          label: topTokenSource.label,
          holdersSharing: topTokenSource.holdersSharing,
          score: topTokenSource.score,
        };
        edge.signals.push({
          kind: "shared_token_source",
          score: topTokenSource.score,
          summary: `Shared direct token source ${topTokenSource.label ?? truncAddr(topTokenSource.address)}`,
        });
      }

      if (edge.sharedFundingAncestors.length === 0) {
        const rankedFunding = rankSharedFunding(commonFundingSources, sourceHolderCounts);
        if (rankedFunding.length > 0) {
          edge.sharedFundingAncestors = rankedFunding.slice(0, 3);
          const strongestFunding = rankedFunding[0];
          edge.signals.push({
            kind: "shared_funding_ancestor",
            score: strongestFunding.score,
            summary: `Shared funding source ${strongestFunding.label ?? truncAddr(strongestFunding.address)}`,
          });
        }
      }
    }
  }

  const edges = [];
  for (const edge of edgeMap.values()) {
    const directTransferTxCount = edge.transferPairs.size;
    const sourceToTargetTxCount = edge.sourceToTargetSignatures.size;
    const targetToSourceTxCount = edge.targetToSourceSignatures.size;
    const bidirectional = sourceToTargetTxCount > 0 && targetToSourceTxCount > 0;

    if (directTransferTxCount > 0) {
      const transferScore = directTransferScore(directTransferTxCount, bidirectional);
      edge.signals.push({
        kind: bidirectional ? "reciprocal_transfer" : "direct_transfer",
        score: transferScore,
        summary: bidirectional
          ? `${directTransferTxCount} direct transfer txs with two-way flow`
          : `${directTransferTxCount} direct transfer tx${directTransferTxCount === 1 ? "" : "s"}`,
      });
    }

    const dedupedSignals = [];
    const seenSignalKinds = new Set();
    for (const signal of edge.signals
      .slice()
      .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))) {
      const key = `${signal.kind}:${signal.summary}`;
      if (seenSignalKinds.has(key)) continue;
      seenSignalKinds.add(key);
      dedupedSignals.push(signal);
    }

    const totalScore = Number(
      dedupedSignals.reduce((sum, signal) => sum + signal.score, 0).toFixed(2),
    );
    if (totalScore < MIN_VISIBLE_EDGE_SCORE) continue;

    const strongestSharedFunding = edge.sharedFundingAncestors
      .slice()
      .sort((a, b) => b.score - a.score)[0] ?? null;

    const finalized = {
      source: edge.source,
      target: edge.target,
      totalScore,
      directTransferTxCount,
      bidirectional,
      sourceToTargetTxCount,
      targetToSourceTxCount,
      firstSeen: edge.firstSeen,
      lastSeen: edge.lastSeen,
      synchronizedAcquisition: edge.synchronizedAcquisition,
      acquisitionSlotDelta: edge.acquisitionSlotDelta,
      sharedFundingCount: edge.sharedFundingAncestors.length,
      strongestSharedFunding,
      sharedFeePayer: edge.sharedFeePayer,
      sharedSigners: edge.sharedSigners,
      sharedTradingVenues: edge.sharedTradingVenues,
      sharedTokenSource: edge.sharedTokenSource ?? null,
      signalKinds: dedupedSignals.map((signal) => signal.kind),
      signals: dedupedSignals,
      dominantSignal: dominantSignal(dedupedSignals),
      evidenceScore: totalScore,
      summaryLines: [],
    };
    finalized.summaryLines = edgeSummaryLines(finalized);
    edges.push(finalized);
  }

  const clusters = buildClusters(edges, holderPctByAddress, holderAnalyses).map((cluster, index) => ({
    ...cluster,
    id: index,
  }));

  const analyzedHolders = scopedHolders.map((holder) => {
    const analysis = holderAnalyses.get(holder.owner);
    return {
      address: holder.owner,
      label: analysis?.label,
      uiAmount: holder.uiAmount,
      percentage: holder.percentage,
      firstAcquisitionSlot: analysis?.acquisition?.slot ?? null,
      firstAcquisitionTimestamp: analysis?.acquisition?.timestamp ?? null,
      firstAcquisitionUiAmount: analysis?.acquisition?.acquiredUiAmount ?? null,
      firstAcquisitionClassification: analysis?.acquisition?.classification ?? null,
      feePayer: analysis?.feePayer ?? null,
      signers: analysis?.signers ?? [],
      fundingSourceCount: analysis?.fundingSources?.size ?? 0,
      directTokenSourceCount: [...(analysis?.fundingSources?.values() ?? [])]
        .filter((source) => source.pathKind === "acquisition_source")
        .length,
      tradeVenueCount: analysis?.tradeProfile?.venueMap?.size ?? 0,
      mintVenueBuyUiAmount: analysis?.tradeProfile?.venueBuyUiAmount ?? 0,
      mintVenueSellUiAmount: analysis?.tradeProfile?.venueSellUiAmount ?? 0,
      twoWayVenueTrader: analysis?.tradeProfile?.twoWayTrade ?? false,
      notes: analysis?.notes ?? [],
    };
  });

  const implicatedWalletSet = new Set(clusters.flatMap((cluster) => cluster.members));
  const implicatedSupplyPct = Number(
    [...implicatedWalletSet]
      .reduce((sum, address) => sum + (holderPctByAddress.get(address)?.percentage ?? 0), 0)
      .toFixed(2)
  );
  const summary = {
    analyzedHolderCount: scopedHolders.length,
    visibleEdgeCount: edges.length,
    clusterCount: clusters.length,
    implicatedWalletCount: implicatedWalletSet.size,
    implicatedSupplyPct,
    controllerLinkedPairs: edges.filter(
      (edge) => edge.signalKinds.includes("shared_fee_payer") || edge.signalKinds.includes("shared_signer"),
    ).length,
    fundingLinkedPairs: edges.filter((edge) => edge.sharedFundingCount > 0).length,
    directDistributionPairs: edges.filter((edge) => edge.signalKinds.includes("shared_token_source")).length,
    coordinatedEntryPairs: edges.filter((edge) => edge.synchronizedAcquisition).length,
    washLikeClusters: clusters.filter((cluster) => cluster.label === "Wash-Like Trading").length,
  };

  const warnings = [
    `Cluster analysis is limited to the top ${scopeLimit} current holders.`,
    "Direct transfer and venue-trading signals are derived from bounded recent target-mint account history, not every wallet transaction ever seen.",
    "Shared-controller inference is evidence-based and not proof of common ownership.",
    "Shared-funding reuse counts are measured only within the analyzed scope.",
    "Shared-funding scores do not yet weight how much of an acquisition each source funded.",
    "Deep funding provenance is only expanded for holders that already share preliminary coordination signals inside the analyzed scope.",
    "Wash-like analysis is heuristic and based on target-mint flows against shared non-wallet venues.",
  ];

  return {
    mint,
    analysisVersion: "token-forensics-v2",
    snapshotAt: snapshot.snapshotAt,
    holderCount: snapshot.holderCount,
    supply: snapshot.supply,
    scopeLimit,
    maxDepth,
    candidateLimit,
    scopeAddresses,
    analyzedHolders,
    edges,
    clusters,
    summary,
    warnings,
  };
}
