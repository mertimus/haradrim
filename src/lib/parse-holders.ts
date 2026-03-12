import type { Node, Edge } from "@xyflow/react";
import type { TokenOverview, TokenHolder } from "@/birdeye-api";
import type {
  HolderConnection,
  HolderCluster,
} from "@/lib/scan-holder-connections";
import type {
  ForensicEvidenceEdge,
  SuspiciousCluster,
} from "@/lib/suspicious-clusters";

// ---- Concentration tiers ----

export type HolderTier = "whale" | "large" | "medium" | "small" | "micro";

export function getHolderTier(pct: number): HolderTier {
  if (pct >= 5) return "whale";
  if (pct >= 1) return "large";
  if (pct >= 0.1) return "medium";
  if (pct >= 0.01) return "small";
  return "micro";
}

export const TIER_COLORS: Record<HolderTier, string> = {
  whale: "#ffb800",
  large: "#ffb800",
  medium: "#00d4ff",
  small: "#6b7b8d",
  micro: "#6b7b8d",
};

export const TIER_LABELS: Record<HolderTier, string> = {
  whale: "Whale (≥5%)",
  large: "Large (1–5%)",
  medium: "Medium (0.1–1%)",
  small: "Small (0.01–0.1%)",
  micro: "Micro (<0.01%)",
};

// ---- Cluster colors (Bubblemaps-style) ----

export const CLUSTER_COLORS = [
  "#00d4ff",
  "#ffb800",
  "#7cc6fe",
  "#ffd966",
  "#94a3b8",
  "#4a9eff",
  "#e6a200",
  "#b0c4de",
  "#3b82f6",
  "#d4a00a",
];

const DIMMED_COLOR = "#2a3545"; // unconnected holders in connection mode
const OUT_OF_SCOPE_COLOR = "#18222e";

// ---- Bubble sizing ----

const MIN_BUBBLE = 30;
const MAX_BUBBLE = 200;

function bubbleSize(pct: number): number {
  if (pct <= 0) return MIN_BUBBLE;
  const logMin = Math.log(0.001);
  const logMax = Math.log(100);
  const logVal = Math.log(Math.max(pct, 0.001));
  const t = (logVal - logMin) / (logMax - logMin);
  return MIN_BUBBLE + t * (MAX_BUBBLE - MIN_BUBBLE);
}

// ---- Log scale for edge styling ----

function logScale(
  value: number,
  max: number,
  minOut: number,
  maxOut: number,
): number {
  if (max <= 0) return minOut;
  const norm = Math.log1p(value) / Math.log1p(max);
  return minOut + norm * (maxOut - minOut);
}

// ---- Build graph data ----
const CENTER_NODE_Y = -220;
const PYRAMID_START_Y = 0;
const PYRAMID_ROW_GAP = 36;
const PYRAMID_COL_GAP = 18;
const PYRAMID_ROW_CAP_GROWTH = 1;

export interface HolderGraphBuildOptions {
  connections?: HolderConnection[];
  clusters?: HolderCluster[];
  forensicEdges?: ForensicEvidenceEdge[];
  forensicClusters?: SuspiciousCluster[];
  mode?: "tiers" | "connections" | "funding" | "bundles" | "forensics";
  analysisScope?: Set<string>;
  holderCountOverride?: number;
}

export function buildHolderGraphData(
  holders: TokenHolder[],
  overview: TokenOverview | null,
  options: HolderGraphBuildOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  if (holders.length === 0) return { nodes: [], edges: [] };

  const {
    connections,
    clusters,
    forensicEdges,
    forensicClusters,
    mode = connections && connections.length > 0 ? "connections" : "tiers",
    analysisScope,
    holderCountOverride,
  } = options;
  const connectionEdges =
    mode === "forensics" ? forensicEdges : connections;
  const clusterList =
    mode === "forensics" ? forensicClusters : clusters;
  const hasConnections = connectionEdges && connectionEdges.length > 0;
  const holderIds = new Set(holders.map((holder) => holder.owner));

  // Build cluster membership map: address → clusterId
  const clusterMap = new Map<string, number>();
  if (clusterList && clusterList.length > 0) {
    for (const c of clusterList) {
      for (const member of c.members) {
        clusterMap.set(member, c.id);
      }
    }
  }

  // Center node
  const centerSize = 80;
  const centerNode: Node = {
    id: "token-center",
    type: "bubbleNode",
    position: { x: 0, y: CENTER_NODE_Y },
    data: {
      isCenter: true,
      image: overview?.image ?? "",
      symbol: overview?.symbol ?? "",
      holderCount: holderCountOverride ?? overview?.holder ?? holders.length,
      nodeSize: centerSize,
    },
  };

  const sizes = holders.map((holder) => bubbleSize(holder.percentage));
  const positions = buildPyramidPositions(sizes);

  const holderNodes: Node[] = holders.map((holder, i) => {
    const tier = getHolderTier(holder.percentage);
    const size = sizes[i];
    const inAnalysisScope = !analysisScope || analysisScope.has(holder.owner);
    const outOfScope = !inAnalysisScope;

    const clusterId = clusterMap.get(holder.owner);
    const inCluster = clusterId != null;
    const color =
      mode === "connections" || mode === "forensics"
        ? outOfScope
          ? OUT_OF_SCOPE_COLOR
          : inCluster
            ? CLUSTER_COLORS[clusterId! % CLUSTER_COLORS.length]
            : mode === "forensics"
              ? "#1f2b39"
              : DIMMED_COLOR
        : TIER_COLORS[tier];

    return {
      id: holder.owner,
      type: "bubbleNode",
      position: positions[i],
      data: {
        isCenter: false,
        address: holder.owner,
        label: holder.label,
        percentage: holder.percentage,
        uiAmount: holder.uiAmount,
        tier,
        color,
        nodeSize: size,
        inCluster,
        outOfScope,
        suppressTierPulse: mode === "forensics",
      },
    };
  });

  // Build edges
  let edges: Edge[] = [];
  if (hasConnections) {
    if (mode === "forensics") {
      const maxScore = Math.max(...(forensicEdges ?? []).map((edge) => edge.totalScore));
      edges = (forensicEdges ?? [])
        .filter(
          (edge) => holderIds.has(edge.source) && holderIds.has(edge.target),
        )
        .map((edge) => ({
          id: `forensic-${edge.source}-${edge.target}`,
          source: edge.source,
          target: edge.target,
          type: "evidenceEdge",
          animated: false,
          data: {
            ...edge,
            thickness: logScale(edge.totalScore, maxScore, 1.5, 4.8),
            opacity: logScale(edge.totalScore, maxScore, 0.38, 0.88),
          },
        }));
    } else {
      const maxTx = Math.max(...connections!.map((c) => c.txCount));
      edges = connections!
      .filter(
        (c) => holderIds.has(c.source) && holderIds.has(c.target),
      )
      .map((c) => ({
        id: `conn-${c.source}-${c.target}`,
        source: c.source,
        target: c.target,
        type: "connectionEdge",
        animated: false,
        data: {
          ...c,
          thickness: logScale(c.txCount, maxTx, 1.5, 4),
          opacity: logScale(c.txCount, maxTx, 0.5, 0.9),
        },
      }));
    }
  }

  return { nodes: [centerNode, ...holderNodes], edges };
}

function rowCapacityFor(index: number): number {
  return Math.max(1, index + PYRAMID_ROW_CAP_GROWTH);
}

function buildPyramidPositions(sizes: number[]): Array<{ x: number; y: number }> {
  const rows: number[][] = [];
  let cursor = 0;
  let rowIndex = 0;

  while (cursor < sizes.length) {
    const capacity = rowCapacityFor(rowIndex);
    rows.push(sizes.slice(cursor, cursor + capacity));
    cursor += capacity;
    rowIndex += 1;
  }

  const positions: Array<{ x: number; y: number }> = new Array(sizes.length);
  let runningIndex = 0;
  let currentY = PYRAMID_START_Y;

  for (const row of rows) {
    const rowWidth = row.reduce((sum, size) => sum + size, 0)
      + Math.max(0, row.length - 1) * PYRAMID_COL_GAP;
    let currentX = -rowWidth / 2;
    const rowMaxSize = Math.max(...row);

    for (const size of row) {
      positions[runningIndex] = {
        x: currentX + size / 2,
        y: currentY,
      };
      currentX += size + PYRAMID_COL_GAP;
      runningIndex += 1;
    }

    currentY += rowMaxSize + PYRAMID_ROW_GAP;
  }

  return positions;
}
