import type { Node, Edge } from "@xyflow/react";
import {
  forceSimulation,
  forceCollide,
  forceRadial,
  forceCenter,
  forceManyBody,
  forceLink,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { TokenOverview, TokenHolder } from "@/birdeye-api";
import type {
  HolderConnection,
  HolderCluster,
} from "@/lib/scan-holder-connections";

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
  whale: "#ff2d2d",
  large: "#ffb800",
  medium: "#00d4ff",
  small: "#00ff88",
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
  "#00ff88", // emerald
  "#a855f7", // purple
  "#ff2d8a", // hot pink
  "#ff8c00", // orange
  "#22d3ee", // cyan
  "#84cc16", // lime
  "#f43f5e", // rose
  "#6366f1", // indigo
  "#eab308", // yellow
  "#14b8a6", // teal
];

const DIMMED_COLOR = "#2a3545"; // unconnected holders in connection mode

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

interface SimNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

export function buildHolderGraphData(
  holders: TokenHolder[],
  overview: TokenOverview | null,
  connections?: HolderConnection[],
  clusters?: HolderCluster[],
): { nodes: Node[]; edges: Edge[] } {
  if (holders.length === 0) return { nodes: [], edges: [] };

  const hasConnections = connections && connections.length > 0;

  // Build cluster membership map: address → clusterId
  const clusterMap = new Map<string, number>();
  if (clusters && clusters.length > 0) {
    for (const c of clusters) {
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
    position: { x: 0, y: 0 },
    data: {
      isCenter: true,
      image: overview?.image ?? "",
      symbol: overview?.symbol ?? "",
      holderCount: overview?.holder ?? holders.length,
      nodeSize: centerSize,
    },
  };

  // Holder bubble nodes
  const simNodes: SimNode[] = holders.map((h, i) => {
    const size = bubbleSize(h.percentage);
    return {
      id: h.owner,
      index: i,
      radius: size / 2,
      x: 0,
      y: 0,
    };
  });

  const idToIndex = new Map(simNodes.map((n, i) => [n.id, i]));

  // Force simulation — parameters change based on connection mode
  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      "collide",
      forceCollide<SimNode>((d) => d.radius + 4).iterations(4),
    )
    .force(
      "radial",
      forceRadial<SimNode>(
        (d) => {
          const maxR = MAX_BUBBLE / 2;
          const normR = d.radius / maxR;
          return 150 + (1 - normR) * 300;
        },
        0,
        0,
      ).strength(hasConnections ? 0.15 : 0.8), // Much weaker radial in connection mode
    )
    .force("center", forceCenter(0, 0).strength(0.05))
    .force(
      "charge",
      forceManyBody().strength(hasConnections ? -100 : -30), // Stronger repulsion in connection mode
    );

  // Link forces — pull connected wallets tightly together
  if (hasConnections) {
    const maxTx = Math.max(...connections!.map((c) => c.txCount));
    const links: SimulationLinkDatum<SimNode>[] = connections!
      .filter(
        (c) => idToIndex.has(c.source) && idToIndex.has(c.target),
      )
      .map((c) => ({
        source: idToIndex.get(c.source)!,
        target: idToIndex.get(c.target)!,
        txCount: c.txCount,
      }));

    if (links.length > 0) {
      sim.force(
        "link",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
          .distance((l) => {
            const tc = (l as unknown as { txCount: number }).txCount;
            return logScale(tc, maxTx, 60, 25); // Very tight: 60 → 25
          })
          .strength((l) => {
            const tc = (l as unknown as { txCount: number }).txCount;
            return logScale(tc, maxTx, 0.7, 1.0); // Very strong attraction
          }),
      );
    }
  }

  sim.stop();
  for (let i = 0; i < 300; i++) sim.tick();

  const holderNodes: Node[] = simNodes.map((sn, i) => {
    const h = holders[i];
    const tier = getHolderTier(h.percentage);
    const size = sn.radius * 2;

    // In connection mode: cluster color or dimmed gray
    const clusterId = clusterMap.get(h.owner);
    const inCluster = clusterId != null;
    const color = hasConnections
      ? inCluster
        ? CLUSTER_COLORS[clusterId! % CLUSTER_COLORS.length]
        : DIMMED_COLOR
      : TIER_COLORS[tier];

    return {
      id: h.owner,
      type: "bubbleNode",
      position: { x: sn.x ?? 0, y: sn.y ?? 0 },
      data: {
        isCenter: false,
        address: h.owner,
        label: h.label,
        percentage: h.percentage,
        uiAmount: h.uiAmount,
        tier,
        color,
        nodeSize: size,
        inCluster, // used by BubbleNode to disable whale pulse
      },
    };
  });

  // Build edges
  let edges: Edge[] = [];
  if (hasConnections) {
    const maxTx = Math.max(...connections!.map((c) => c.txCount));
    edges = connections!
      .filter(
        (c) => idToIndex.has(c.source) && idToIndex.has(c.target),
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

  return { nodes: [centerNode, ...holderNodes], edges };
}
