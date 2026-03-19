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

// ---- Holder shape classification ----

export type HolderShape = "circle" | "triangle" | "square";

const EXCHANGE_KEYWORDS = [
  "binance", "coinbase", "kraken", "kucoin", "okx", "bybit", "bitfinex",
  "gemini", "bitstamp", "huobi", "htx", "gate.io", "crypto.com",
  "bitget", "mexc", "upbit", "bithumb", "robinhood", "jupiter",
  "raydium", "orca", "whitebit", "lbank", "backpack",
];

export function getHolderShape(holder: TokenHolder): HolderShape {
  // Programs → square
  if (holder.ownerAccountType === "program") return "square";

  // Exchange detection via identity category
  if (holder.identityCategory?.toLowerCase() === "exchange") return "triangle";

  // Exchange detection via label keywords
  if (holder.label) {
    const lower = holder.label.toLowerCase();
    if (EXCHANGE_KEYWORDS.some((kw) => lower.includes(kw))) return "triangle";
    if (lower.includes("hot wallet") || lower.includes("cold wallet")) return "triangle";
  }

  return "circle";
}

// ---- Bubble sizing ----

const MIN_BUBBLE = 24;
const MAX_BUBBLE = 120;

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
  _overview: TokenOverview | null,
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

  const sizes = holders.map((holder) => bubbleSize(holder.percentage));
  const positions = buildConcentrationPositions(sizes);

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
        address: holder.owner,
        label: holder.label,
        percentage: holder.percentage,
        uiAmount: holder.uiAmount,
        tier,
        color,
        nodeSize: size,
        holderShape: getHolderShape(holder),
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

  return { nodes: holderNodes, edges };
}

// Golden angle in radians — prevents visual banding between rings
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RING_PAD = 4; // px gap between rings

function buildConcentrationPositions(
  sizes: number[],
): Array<{ x: number; y: number }> {
  if (sizes.length === 0) return [];

  const positions: Array<{ x: number; y: number }> = new Array(sizes.length);

  // Largest holder at origin
  positions[0] = { x: 0, y: 0 };
  if (sizes.length === 1) return positions;

  // Define concentric rings: [startIndex, endIndex) per ring
  const ringBounds: Array<[number, number]> = [];
  let cursor = 1;
  let ringCapacity = 5;
  while (cursor < sizes.length) {
    const end = Math.min(cursor + ringCapacity, sizes.length);
    ringBounds.push([cursor, end]);
    cursor = end;
    ringCapacity = Math.ceil(ringCapacity * 1.6);
  }

  // Build rings with tight radii based on actual node sizes
  let prevOuterEdge = sizes[0] / 2; // half the center node

  for (let r = 0; r < ringBounds.length; r++) {
    const [start, end] = ringBounds[r];
    const count = end - start;
    const maxNodeInRing = Math.max(...sizes.slice(start, end));

    // Radius = previous outer edge + gap + half the biggest node in this ring
    // But also ensure nodes in the ring don't overlap each other
    // Min circumference needed = sum of diameters + small gaps
    const circumferenceNeeded = sizes.slice(start, end).reduce((s, sz) => s + sz, 0) + count * 6;
    const radiusFromCircumference = circumferenceNeeded / (2 * Math.PI);
    const radiusFromPacking = prevOuterEdge + RING_PAD + maxNodeInRing / 2;
    const radius = Math.max(radiusFromPacking, radiusFromCircumference);

    const angleOffset = r * GOLDEN_ANGLE;

    for (let i = 0; i < count; i++) {
      const angle = angleOffset + (i / count) * 2 * Math.PI;
      const jitterR = radius * (1 + (((i * 7 + r * 13) % 17) / 17 - 0.5) * 0.06);
      positions[start + i] = {
        x: Math.cos(angle) * jitterR,
        y: Math.sin(angle) * jitterR,
      };
    }

    prevOuterEdge = radius + maxNodeInRing / 2;
  }

  return positions;
}
