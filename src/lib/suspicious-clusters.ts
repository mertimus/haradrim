import type { TokenHolder } from "@/birdeye-api";
import type { BundleGroup } from "@/lib/bundle-scan";
import type { FundingWalkResult } from "@/lib/funding-walk";
import type { HolderConnection } from "@/lib/scan-holder-connections";

export type ForensicSignalKind =
  | "direct_transfer"
  | "reciprocal_transfer"
  | "synchronized_acquisition"
  | "shared_funding_ancestor"
  | "shared_fee_payer"
  | "shared_signer"
  | "shared_trading_venue"
  | "amount_similarity"
  | "shared_token_source";

export interface ForensicSignal {
  kind: ForensicSignalKind;
  score: number;
  summary: string;
}

export interface SharedFundingEvidence {
  address: string;
  label?: string;
  depthFromSource: number;
  depthFromTarget: number;
  holdersFunded: number;
  score: number;
}

export interface SharedControllerEvidence {
  address: string;
  label?: string;
  holdersSharing: number;
  score: number;
}

export interface ForensicEvidenceEdge {
  source: string;
  target: string;
  totalScore: number;
  directTransferTxCount: number;
  bidirectional: boolean;
  sourceToTargetTxCount: number;
  targetToSourceTxCount: number;
  firstSeen: number;
  lastSeen: number;
  synchronizedAcquisition: boolean;
  acquisitionSlotDelta: number | null;
  sharedFundingCount: number;
  strongestSharedFunding: SharedFundingEvidence | null;
  sharedFeePayer?: SharedControllerEvidence | null;
  sharedSigners?: SharedControllerEvidence[] | null;
  sharedTradingVenues?: SharedControllerEvidence[] | null;
  sharedTokenSource?: SharedControllerEvidence | null;
  signalKinds: ForensicSignalKind[];
  signals: ForensicSignal[];
  dominantSignal: ForensicSignalKind;
  summaryLines: string[];
  evidenceScore: number;
}

export interface SuspiciousCluster {
  id: number;
  members: string[];
  totalPct: number;
  edgeCount: number;
  internalScore: number;
  riskScore: number;
  label: string;
  reasons: string[];
  directTransferEdges: number;
  reciprocalTransferEdges: number;
  synchronizedPairs: number;
  sharedFundingPairs: number;
  sharedFeePayerPairs?: number;
  sharedSignerPairs?: number;
  sharedTradingVenuePairs?: number;
  twoWayTradeWallets?: number;
  sharedTradingVenueCount?: number;
  grossTradeUiAmount?: number;
  netTradeUiAmount?: number;
  churnRatio?: number;
  sharedTokenSourcePairs?: number;
  sharedControlPairs?: number;
  multiSignalEdges: number;
}

export interface SuspiciousClusterBuildOptions {
  holders: TokenHolder[];
  connections?: HolderConnection[];
  bundleGroups?: BundleGroup[];
  firstAcquisitionSlots?: Map<string, number> | null;
  fundingResult?: FundingWalkResult | null;
  scope?: Set<string>;
}

export interface SuspiciousClusterBuildResult {
  scopeAddresses: string[];
  edges: ForensicEvidenceEdge[];
  clusters: SuspiciousCluster[];
}

const DIRECT_TRANSFER_SCORE_PER_TX = 1.25;
const DIRECT_TRANSFER_MAX_SCORE = 3.25;
const RECIPROCAL_TRANSFER_BONUS = 1.25;
const ACQUISITION_BASE_SCORE = 2.6;
const MAX_FUNDING_SCORE = 2.8;
const MIN_VISIBLE_EDGE_SCORE = 1.2;
const MIN_CLUSTER_EDGE_SCORE = 2.25;
const LABEL_PROPAGATION_ITERATIONS = 16;

interface FundingAncestorInfo {
  address: string;
  label?: string;
  depth: number;
  holdersFunded: number;
}

interface EdgeAccumulator {
  source: string;
  target: string;
  directTransferTxCount: number;
  bidirectional: boolean;
  sourceToTargetTxCount: number;
  targetToSourceTxCount: number;
  firstSeen: number;
  lastSeen: number;
  synchronizedAcquisition: boolean;
  acquisitionSlotDelta: number | null;
  sharedFundingAncestors: SharedFundingEvidence[];
  signals: ForensicSignal[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function ensureEdge(
  edgeMap: Map<string, EdgeAccumulator>,
  a: string,
  b: string,
): EdgeAccumulator {
  const [source, target] = a < b ? [a, b] : [b, a];
  const key = pairKey(source, target);
  const existing = edgeMap.get(key);
  if (existing) return existing;

  const created: EdgeAccumulator = {
    source,
    target,
    directTransferTxCount: 0,
    bidirectional: false,
    sourceToTargetTxCount: 0,
    targetToSourceTxCount: 0,
    firstSeen: 0,
    lastSeen: 0,
    synchronizedAcquisition: false,
    acquisitionSlotDelta: null,
    sharedFundingAncestors: [],
    signals: [],
  };
  edgeMap.set(key, created);
  return created;
}

function addSignal(edge: EdgeAccumulator, signal: ForensicSignal): void {
  edge.signals.push(signal);
}

function buildFundingAncestorMap(
  holders: string[],
  fundingResult: FundingWalkResult | null | undefined,
): Map<string, Map<string, FundingAncestorInfo>> {
  const result = new Map<string, Map<string, FundingAncestorInfo>>();
  if (!fundingResult) return result;

  const reverseAdj = new Map<string, string[]>();
  for (const edge of fundingResult.edges) {
    if (!reverseAdj.has(edge.target)) reverseAdj.set(edge.target, []);
    reverseAdj.get(edge.target)!.push(edge.source);
  }

  for (const holder of holders) {
    const ancestors = new Map<string, FundingAncestorInfo>();
    const queue: Array<{ address: string; depth: number }> = [{ address: holder, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.address)) continue;
      visited.add(current.address);

      for (const funder of reverseAdj.get(current.address) ?? []) {
        if (!visited.has(funder)) {
          const nextDepth = current.depth + 1;
          const node = fundingResult.nodes.get(funder);
          const existing = ancestors.get(funder);
          if (!existing || nextDepth < existing.depth) {
            ancestors.set(funder, {
              address: funder,
              label: node?.label,
              depth: nextDepth,
              holdersFunded: node?.holdersFunded ?? 0,
            });
          }
          queue.push({ address: funder, depth: nextDepth });
        }
      }
    }

    result.set(holder, ancestors);
  }

  return result;
}

function fundingAncestorScore(
  sourceDepth: number,
  targetDepth: number,
  holdersFunded: number,
): number {
  const distance = sourceDepth + targetDepth;
  const closeness = 1 / Math.max(1, distance - 1);
  const exclusivity = Math.min(1.3, 2.6 / Math.max(2, holdersFunded || 2));
  return Math.min(MAX_FUNDING_SCORE, 1.8 * closeness * exclusivity);
}

function edgeDominantSignal(signals: ForensicSignal[]): ForensicSignalKind {
  return [...signals]
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))[0]?.kind
    ?? "direct_transfer";
}

function evidenceSummaryLines(
  edge: EdgeAccumulator,
  totalScore: number,
): string[] {
  const lines = [`Score ${totalScore.toFixed(1)}`];
  if (edge.directTransferTxCount > 0) {
    lines.push(
      edge.bidirectional
        ? `Direct transfers: ${edge.directTransferTxCount} tx, reciprocal`
        : `Direct transfers: ${edge.directTransferTxCount} tx, one-way`,
    );
  }
  if (edge.synchronizedAcquisition && edge.acquisitionSlotDelta != null) {
    lines.push(`Acquisition timing: within ${edge.acquisitionSlotDelta} slots`);
  }
  if (edge.sharedFundingAncestors.length > 0) {
    const strongest = [...edge.sharedFundingAncestors].sort(
      (a, b) => b.score - a.score,
    )[0];
    lines.push(
      `Shared funding: ${edge.sharedFundingAncestors.length} ancestor${edge.sharedFundingAncestors.length !== 1 ? "s" : ""}${
        strongest?.label ? ` (${strongest.label})` : strongest ? ` (${truncAddr(strongest.address)})` : ""
      }`,
    );
  }
  return lines;
}

function classifyCluster(cluster: Omit<SuspiciousCluster, "id" | "label" | "reasons">): {
  label: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (cluster.synchronizedPairs > 0) {
    reasons.push(
      `${cluster.synchronizedPairs} synchronized acquisition pair${cluster.synchronizedPairs !== 1 ? "s" : ""}`,
    );
  }
  if (cluster.sharedFundingPairs > 0) {
    reasons.push(
      `${cluster.sharedFundingPairs} shared-funding pair${cluster.sharedFundingPairs !== 1 ? "s" : ""}`,
    );
  }
  if (cluster.directTransferEdges > 0) {
    reasons.push(
      `${cluster.directTransferEdges} direct-transfer edge${cluster.directTransferEdges !== 1 ? "s" : ""}`,
    );
  }
  if (cluster.reciprocalTransferEdges > 0) {
    reasons.push(
      `${cluster.reciprocalTransferEdges} reciprocal-transfer edge${cluster.reciprocalTransferEdges !== 1 ? "s" : ""}`,
    );
  }

  if (cluster.synchronizedPairs > 0 && cluster.sharedFundingPairs > 0) {
    return {
      label: "Shared-Funding Bundle",
      reasons,
    };
  }
  if (cluster.synchronizedPairs > 0 && cluster.synchronizedPairs >= cluster.directTransferEdges) {
    return {
      label: "Launch Bundle",
      reasons,
    };
  }
  if (cluster.reciprocalTransferEdges > 0) {
    return {
      label: "Reciprocal Transfer Ring",
      reasons,
    };
  }
  if (cluster.sharedFundingPairs > 0 && cluster.sharedFundingPairs >= cluster.directTransferEdges) {
    return {
      label: "Shared Funding Ring",
      reasons,
    };
  }
  if (cluster.directTransferEdges > 0) {
    return {
      label: "Distributor Ring",
      reasons,
    };
  }
  return {
    label: "Mixed Coordination",
    reasons,
  };
}

function runWeightedLabelPropagation(
  holders: TokenHolder[],
  adjacency: Map<string, Array<{ neighbor: string; weight: number }>>,
): Map<string, string> {
  const ordered = [...holders].sort(
    (a, b) => b.percentage - a.percentage || a.owner.localeCompare(b.owner),
  );
  const labels = new Map(ordered.map((holder) => [holder.owner, holder.owner]));

  for (let iteration = 0; iteration < LABEL_PROPAGATION_ITERATIONS; iteration += 1) {
    let changed = false;

    for (const holder of ordered) {
      const neighbors = adjacency.get(holder.owner) ?? [];
      if (neighbors.length === 0) continue;

      const scoresByLabel = new Map<string, number>();
      for (const neighbor of neighbors) {
        const label = labels.get(neighbor.neighbor) ?? neighbor.neighbor;
        scoresByLabel.set(label, (scoresByLabel.get(label) ?? 0) + neighbor.weight);
      }

      let bestLabel = labels.get(holder.owner) ?? holder.owner;
      let bestScore = scoresByLabel.get(bestLabel) ?? 0;
      for (const [label, score] of scoresByLabel) {
        if (
          score > bestScore
          || (score === bestScore && label === holder.owner)
          || (score === bestScore && label < bestLabel)
        ) {
          bestLabel = label;
          bestScore = score;
        }
      }

      if (bestLabel !== labels.get(holder.owner)) {
        labels.set(holder.owner, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

function connectedComponents(
  members: string[],
  edges: ForensicEvidenceEdge[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const member of members) adjacency.set(member, new Set());
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const member of members) {
    if (visited.has(member)) continue;
    const queue = [member];
    const component: string[] = [];
    visited.add(member);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

export function buildSuspiciousClusters(
  options: SuspiciousClusterBuildOptions,
): SuspiciousClusterBuildResult {
  const scopeAddresses = [
    ...(options.scope ?? new Set(options.holders.map((holder) => holder.owner))),
  ];
  const scopeSet = new Set(scopeAddresses);
  const scopeHolders = options.holders.filter((holder) => scopeSet.has(holder.owner));
  const pctMap = new Map(scopeHolders.map((holder) => [holder.owner, holder.percentage]));
  const edgeMap = new Map<string, EdgeAccumulator>();

  for (const connection of options.connections ?? []) {
    if (!scopeSet.has(connection.source) || !scopeSet.has(connection.target)) continue;
    const edge = ensureEdge(edgeMap, connection.source, connection.target);
    edge.directTransferTxCount = connection.txCount;
    edge.bidirectional = connection.bidirectional;
    edge.sourceToTargetTxCount = connection.sourceToTargetTxCount;
    edge.targetToSourceTxCount = connection.targetToSourceTxCount;
    edge.firstSeen = connection.firstSeen;
    edge.lastSeen = connection.lastSeen;

    const directTransferScore = Math.min(
      DIRECT_TRANSFER_MAX_SCORE,
      connection.txCount * DIRECT_TRANSFER_SCORE_PER_TX,
    );
    addSignal(edge, {
      kind: "direct_transfer",
      score: directTransferScore,
      summary: `${connection.txCount} direct transfer tx${connection.txCount !== 1 ? "s" : ""}`,
    });
    if (connection.bidirectional) {
      addSignal(edge, {
        kind: "reciprocal_transfer",
        score: RECIPROCAL_TRANSFER_BONUS,
        summary: "Reciprocal holder-to-holder flow",
      });
    }
  }

  for (const group of options.bundleGroups ?? []) {
    const members = group.members.filter((member) => scopeSet.has(member));
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const source = members[i];
        const target = members[j];
        const slotA = options.firstAcquisitionSlots?.get(source);
        const slotB = options.firstAcquisitionSlots?.get(target);
        const slotDelta =
          slotA != null && slotB != null ? Math.abs(slotA - slotB) : null;
        const proximity =
          slotDelta == null ? 0.7 : Math.max(0.4, 1 - slotDelta / 6);
        const specificity =
          members.length <= 4 ? 1.15 : members.length <= 8 ? 1.0 : 0.85;
        const score = ACQUISITION_BASE_SCORE * proximity * specificity;

        const edge = ensureEdge(edgeMap, source, target);
        edge.synchronizedAcquisition = true;
        edge.acquisitionSlotDelta =
          edge.acquisitionSlotDelta == null
            ? slotDelta
            : Math.min(edge.acquisitionSlotDelta, slotDelta ?? edge.acquisitionSlotDelta);
        addSignal(edge, {
          kind: "synchronized_acquisition",
          score,
          summary:
            slotDelta == null
              ? "Synchronized first acquisition cohort"
              : `Synchronized acquisition within ${slotDelta} slots`,
        });
      }
    }
  }

  const ancestorMap = buildFundingAncestorMap(scopeAddresses, options.fundingResult);
  for (let i = 0; i < scopeAddresses.length; i += 1) {
    for (let j = i + 1; j < scopeAddresses.length; j += 1) {
      const source = scopeAddresses[i];
      const target = scopeAddresses[j];
      const sourceAncestors = ancestorMap.get(source);
      const targetAncestors = ancestorMap.get(target);
      if (!sourceAncestors || !targetAncestors) continue;

      const commonEvidence: SharedFundingEvidence[] = [];
      for (const [ancestorAddress, sourceInfo] of sourceAncestors) {
        const targetInfo = targetAncestors.get(ancestorAddress);
        if (!targetInfo) continue;
        const score = fundingAncestorScore(
          sourceInfo.depth,
          targetInfo.depth,
          Math.max(sourceInfo.holdersFunded, targetInfo.holdersFunded),
        );
        if (score <= 0.35) continue;

        commonEvidence.push({
          address: ancestorAddress,
          label: sourceInfo.label ?? targetInfo.label,
          depthFromSource: sourceInfo.depth,
          depthFromTarget: targetInfo.depth,
          holdersFunded: Math.max(sourceInfo.holdersFunded, targetInfo.holdersFunded),
          score,
        });
      }

      if (commonEvidence.length === 0) continue;
      commonEvidence.sort((a, b) => b.score - a.score);
      const strongest = commonEvidence[0];
      const totalFundingScore = Math.min(
        MAX_FUNDING_SCORE,
        commonEvidence.slice(0, 2).reduce((sum, evidence) => sum + evidence.score, 0),
      );

      const edge = ensureEdge(edgeMap, source, target);
      edge.sharedFundingAncestors = commonEvidence;
      addSignal(edge, {
        kind: "shared_funding_ancestor",
        score: totalFundingScore,
        summary: strongest.label
          ? `Shared funding ancestor: ${strongest.label}`
          : `Shared funding ancestor: ${truncAddr(strongest.address)}`,
      });
    }
  }

  const edges: ForensicEvidenceEdge[] = [];
  for (const edge of edgeMap.values()) {
    const totalScore = edge.signals.reduce((sum, signal) => sum + signal.score, 0);
    if (totalScore < MIN_VISIBLE_EDGE_SCORE) continue;

    const dominantSignal = edgeDominantSignal(edge.signals);
    const strongestSharedFunding = edge.sharedFundingAncestors.length > 0
      ? [...edge.sharedFundingAncestors].sort((a, b) => b.score - a.score)[0]
      : null;

    edges.push({
      source: edge.source,
      target: edge.target,
      totalScore,
      directTransferTxCount: edge.directTransferTxCount,
      bidirectional: edge.bidirectional,
      sourceToTargetTxCount: edge.sourceToTargetTxCount,
      targetToSourceTxCount: edge.targetToSourceTxCount,
      firstSeen: edge.firstSeen,
      lastSeen: edge.lastSeen,
      synchronizedAcquisition: edge.synchronizedAcquisition,
      acquisitionSlotDelta: edge.acquisitionSlotDelta,
      sharedFundingCount: edge.sharedFundingAncestors.length,
      strongestSharedFunding,
      signalKinds: [...new Set(edge.signals.map((signal) => signal.kind))],
      signals: [...edge.signals].sort((a, b) => b.score - a.score),
      dominantSignal,
      summaryLines: evidenceSummaryLines(edge, totalScore),
      evidenceScore: totalScore,
    });
  }

  edges.sort((a, b) => b.totalScore - a.totalScore || b.lastSeen - a.lastSeen);

  const adjacency = new Map<string, Array<{ neighbor: string; weight: number }>>();
  for (const holder of scopeHolders) adjacency.set(holder.owner, []);
  for (const edge of edges) {
    if (edge.totalScore < MIN_CLUSTER_EDGE_SCORE) continue;
    adjacency.get(edge.source)?.push({ neighbor: edge.target, weight: edge.totalScore });
    adjacency.get(edge.target)?.push({ neighbor: edge.source, weight: edge.totalScore });
  }

  const labels = runWeightedLabelPropagation(scopeHolders, adjacency);
  const groups = new Map<string, string[]>();
  for (const holder of scopeHolders) {
    const label = labels.get(holder.owner) ?? holder.owner;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(holder.owner);
  }

  const clusters: SuspiciousCluster[] = [];
  let clusterId = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const strongEdges = edges.filter(
      (edge) =>
        edge.totalScore >= MIN_CLUSTER_EDGE_SCORE
        && members.includes(edge.source)
        && members.includes(edge.target),
    );
    if (strongEdges.length === 0) continue;

    for (const component of connectedComponents(members, strongEdges)) {
      if (component.length < 2) continue;
      const componentSet = new Set(component);
      const internalEdges = strongEdges.filter(
        (edge) => componentSet.has(edge.source) && componentSet.has(edge.target),
      );
      if (internalEdges.length === 0) continue;

      const totalPct = component.reduce(
        (sum, member) => sum + (pctMap.get(member) ?? 0),
        0,
      );
      const internalScore = internalEdges.reduce((sum, edge) => sum + edge.totalScore, 0);
      const directTransferEdges = internalEdges.filter(
        (edge) => edge.directTransferTxCount > 0,
      ).length;
      const reciprocalTransferEdges = internalEdges.filter(
        (edge) => edge.bidirectional,
      ).length;
      const synchronizedPairs = internalEdges.filter(
        (edge) => edge.synchronizedAcquisition,
      ).length;
      const sharedFundingPairs = internalEdges.filter(
        (edge) => edge.sharedFundingCount > 0,
      ).length;
      const multiSignalEdges = internalEdges.filter(
        (edge) => edge.signalKinds.length >= 2,
      ).length;
      const riskScore =
        internalScore
        + multiSignalEdges * 0.75
        + Math.min(totalPct / 10, 4);

      const baseCluster = {
        members: component.sort((a, b) => {
          const pctDiff = (pctMap.get(b) ?? 0) - (pctMap.get(a) ?? 0);
          return pctDiff !== 0 ? pctDiff : a.localeCompare(b);
        }),
        totalPct,
        edgeCount: internalEdges.length,
        internalScore,
        riskScore,
        directTransferEdges,
        reciprocalTransferEdges,
        synchronizedPairs,
        sharedFundingPairs,
        multiSignalEdges,
      };
      const classification = classifyCluster(baseCluster);

      clusters.push({
        id: clusterId++,
        ...baseCluster,
        label: classification.label,
        reasons: classification.reasons,
      });
    }
  }

  clusters.sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    if (b.totalPct !== a.totalPct) return b.totalPct - a.totalPct;
    return b.members.length - a.members.length;
  });

  return {
    scopeAddresses,
    edges,
    clusters,
  };
}
