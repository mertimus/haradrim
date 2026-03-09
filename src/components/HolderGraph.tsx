import { useCallback, useState, useEffect, useMemo, memo } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CLUSTER_COLORS,
  TIER_COLORS,
  TIER_LABELS,
  type HolderTier,
} from "@/lib/parse-holders";
import { ConnectionEdge } from "@/components/ConnectionEdge";
import { EvidenceEdge } from "@/components/EvidenceEdge";
import { FunderNode, IntermediateNode, FundingEdge } from "@/components/FundingNodes";
import type { HolderCluster } from "@/lib/scan-holder-connections";
import type { FundingNode } from "@/lib/funding-walk";
import type { BundleGroup } from "@/lib/bundle-scan";
import type { SuspiciousCluster } from "@/lib/suspicious-clusters";

// ---- Helpers ----

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/** Generic hex color → "r, g, b" string for rgba() usage */
function hexToRgb(hex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return "107, 123, 141";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// ---- Bubble Node ----

interface BubbleNodeData {
  isCenter: boolean;
  image?: string;
  symbol?: string;
  holderCount?: number;
  address?: string;
  label?: string;
  percentage?: number;
  uiAmount?: number;
  tier?: HolderTier;
  color?: string;
  nodeSize: number;
  inCluster?: boolean;
  outOfScope?: boolean;
  suppressTierPulse?: boolean;
  [key: string]: unknown;
}

const BubbleNode = memo(function BubbleNode({
  data,
}: NodeProps<Node<BubbleNodeData>>) {
  const d = data as BubbleNodeData;
  const size = d.nodeSize;

  if (d.isCenter) {
    const rgb = "0, 212, 255";
    return (
      <div
        className="center-node-pulse relative flex flex-col items-center justify-center"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: "2px solid #00d4ff",
          outline: `2px solid rgba(${rgb}, 0.3)`,
          outlineOffset: 2,
          backgroundColor: `rgba(${rgb}, 0.1)`,
        }}
      >
        {d.image && (
          <img
            src={d.image}
            alt=""
            draggable={false}
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              objectFit: "cover",
              marginBottom: 2,
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        {d.symbol && (
          <div
            className="font-mono text-[11px] font-bold"
            style={{ color: "#00d4ff" }}
          >
            {d.symbol}
          </div>
        )}
        <div
          className="font-mono text-[9px]"
          style={{ color: "#6b7b8d" }}
        >
          {(d.holderCount ?? 0).toLocaleString()} holders
        </div>
      </div>
    );
  }

  // Holder bubble
  const color = d.color ?? "#6b7b8d";
  const rgb = hexToRgb(color);
  const pct = d.percentage ?? 0;
  const pctStr =
    pct >= 1
      ? `${pct.toFixed(1)}%`
      : pct >= 0.01
        ? `${pct.toFixed(2)}%`
        : "<0.01%";
  // Whale pulse only in tier mode, not in cluster mode
  const isWhale = d.tier === "whale" && !d.inCluster && !d.outOfScope && !d.suppressTierPulse;
  const cssVars = { "--ring-rgb": rgb } as React.CSSProperties;

  return (
    <div
      className={`node-shape flex flex-col items-center justify-center ${isWhale ? "whale-pulse" : ""}`}
      data-tier={isWhale ? "1" : "2"}
      style={{
        ...cssVars,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `1.5px solid ${color}`,
        borderStyle: d.outOfScope ? "dashed" : "solid",
        backgroundColor: `rgba(${rgb}, ${d.outOfScope ? 0.04 : d.inCluster ? 0.15 : 0.08})`,
        overflow: "hidden",
        padding: 4,
        opacity: d.outOfScope ? 0.6 : 1,
      }}
    >
      {d.label && size >= 60 && (
        <div
          className="truncate font-mono font-bold leading-tight text-center"
          style={{
            fontSize: size >= 100 ? 10 : 8,
            color,
            maxWidth: size - 12,
          }}
        >
          {d.label}
        </div>
      )}
      <div
        className="font-mono font-bold leading-tight"
        style={{ fontSize: size >= 80 ? 12 : size >= 50 ? 10 : 8, color }}
      >
        {pctStr}
      </div>
      {size >= 50 && d.address && (
        <div
          className="font-mono text-muted-foreground leading-tight"
          style={{ fontSize: size >= 80 ? 9 : 7 }}
        >
          {truncAddr(d.address)}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
});

// ---- Config ----

// ---- Config ----

const nodeTypes = { bubbleNode: BubbleNode, funderNode: FunderNode, intermediateNode: IntermediateNode };
const edgeTypes = {
  connectionEdge: ConnectionEdge,
  evidenceEdge: EvidenceEdge,
  fundingEdge: FundingEdge,
};
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1.2 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

// ---- Context menu ----

interface ContextMenuState {
  address: string;
  screenX: number;
  screenY: number;
}

// ---- HolderGraph ----

// Bundle color palette — matches HolderTable
const BUNDLE_COLORS = [
  "#a855f7", "#f97316", "#06b6d4", "#ec4899",
  "#84cc16", "#eab308", "#14b8a6", "#f43f5e",
];
const EMPTY_EDGES: Edge[] = [];
const EMPTY_CLUSTERS: HolderCluster[] = [];
const EMPTY_FUNDERS: FundingNode[] = [];
const EMPTY_BUNDLES: BundleGroup[] = [];
const EMPTY_FORENSIC_CLUSTERS: SuspiciousCluster[] = [];

interface HolderGraphProps {
  nodes: Node[];
  edges?: Edge[];
  clusters?: HolderCluster[];
  showConnections?: boolean;
  commonFunders?: FundingNode[];
  showFunding?: boolean;
  loading: boolean;
  onFundCluster?: (memberAddresses: string[]) => void;
  walkingFunding?: boolean;
  bundleGroups?: BundleGroup[];
  showBundles?: boolean;
  forensicClusters?: SuspiciousCluster[];
  showForensics?: boolean;
  selectedForensicsClusterId?: number | null;
  onSelectForensicsCluster?: (clusterId: number | null) => void;
}

export function HolderGraph({
  nodes: propNodes,
  edges: propEdges = EMPTY_EDGES,
  clusters = EMPTY_CLUSTERS,
  showConnections = false,
  commonFunders = EMPTY_FUNDERS,
  showFunding = false,
  loading,
  onFundCluster,
  walkingFunding = false,
  bundleGroups = EMPTY_BUNDLES,
  showBundles = false,
  forensicClusters = EMPTY_FORENSIC_CLUSTERS,
  showForensics = false,
  selectedForensicsClusterId = null,
  onSelectForensicsCluster,
}: HolderGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(propNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(propEdges);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [highlightedCluster, setHighlightedCluster] = useState<number | null>(null);
  const [highlightedFunder, setHighlightedFunder] = useState<string | null>(null);

  useEffect(() => {
    setNodes(propNodes);
  }, [propNodes, setNodes]);

  useEffect(() => {
    setEdges(propEdges);
  }, [propEdges, setEdges]);

  useEffect(() => {
    setHighlightedCluster(selectedForensicsClusterId);
  }, [selectedForensicsClusterId]);

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      const d = node.data as BubbleNodeData;
      if (d.isCenter || !d.address) return;
      setContextMenu({
        address: d.address,
        screenX: event.clientX,
        screenY: event.clientY,
      });
    },
    [setContextMenu],
  );

  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, [setContextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  const menuStyle = useMemo(() => {
    if (!contextMenu) return null;
    const menuW = 180;
    const menuH = 80;
    const x = Math.min(contextMenu.screenX, window.innerWidth - menuW - 8);
    const y = Math.min(contextMenu.screenY, window.innerHeight - menuH - 8);
    return { left: x, top: y };
  }, [contextMenu]);

  // Cluster highlight — apply CSS class to member nodes
  const highlightedMembers = useMemo(() => {
    if (highlightedCluster == null) return new Set<string>();
    const activeClusters = showForensics ? forensicClusters : clusters;
    const cluster = activeClusters.find((c) => c.id === highlightedCluster);
    return cluster ? new Set(cluster.members) : new Set<string>();
  }, [forensicClusters, highlightedCluster, showForensics, clusters]);

  useEffect(() => {
    const container = document.querySelector(".react-flow");
    if (!container) return;
    container
      .querySelectorAll(".node-cluster-highlight")
      .forEach((el) => el.classList.remove("node-cluster-highlight"));
    if (highlightedMembers.size > 0) {
      for (const addr of highlightedMembers) {
        const el = container.querySelector(
          `.react-flow__node[data-id="${CSS.escape(addr)}"]`,
        );
        if (el) el.classList.add("node-cluster-highlight");
      }
    }
  }, [highlightedMembers]);

  // Funder highlight — dim all, pop funder + funded holders
  useEffect(() => {
    const container = document.querySelector(".react-flow");
    if (!container) return;
    // Clear previous
    container.classList.remove("has-funder-highlight");
    container
      .querySelectorAll(".node-funder-highlight")
      .forEach((el) => el.classList.remove("node-funder-highlight"));
    if (highlightedFunder) {
      container.classList.add("has-funder-highlight");
      // Highlight the funder node itself
      const funderEl = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(highlightedFunder)}"]`,
      );
      if (funderEl) funderEl.classList.add("node-funder-highlight");
      // Highlight all holders this funder funded (via edges)
      for (const edge of propEdges) {
        if (edge.source === highlightedFunder) {
          const targetEl = container.querySelector(
            `.react-flow__node[data-id="${CSS.escape(edge.target)}"]`,
          );
          if (targetEl) targetEl.classList.add("node-funder-highlight");
        }
      }
    }
  }, [highlightedFunder, propEdges]);

  // Bundle highlight — dim non-bundle nodes, color bundle members
  const [highlightedBundle, setHighlightedBundle] = useState<number | null>(null);

  const bundleMembers = useMemo(() => {
    if (!showBundles) return new Set<string>();
    const set = new Set<string>();
    for (const g of bundleGroups) {
      for (const m of g.members) set.add(m);
    }
    return set;
  }, [showBundles, bundleGroups]);

  // Build address → bundle color map
  const bundleColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < bundleGroups.length; i++) {
      const color = BUNDLE_COLORS[i % BUNDLE_COLORS.length];
      for (const addr of bundleGroups[i].members) {
        map.set(addr, color);
      }
    }
    return map;
  }, [bundleGroups]);

  useEffect(() => {
    const container = document.querySelector(".react-flow");
    if (!container) return;

    container.classList.remove("has-bundle-highlight");
    container
      .querySelectorAll(".node-bundle-highlight")
      .forEach((el) => {
        el.classList.remove("node-bundle-highlight");
        (el as HTMLElement).style.removeProperty("--bundle-color");
      });

    if (!showBundles || bundleMembers.size === 0) return;

    container.classList.add("has-bundle-highlight");
    const activeMembers =
      highlightedBundle == null
        ? bundleMembers
        : new Set(bundleGroups[highlightedBundle]?.members ?? []);

    for (const addr of activeMembers) {
      const el = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(addr)}"]`,
      );
      if (el) {
        el.classList.add("node-bundle-highlight");
        const color = bundleColorMap.get(addr);
        if (color) (el as HTMLElement).style.setProperty("--bundle-color", color);
      }
    }
  }, [showBundles, bundleMembers, bundleGroups, bundleColorMap, highlightedBundle]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <div className="scanning-text font-mono text-sm uppercase tracking-[0.4em] text-primary/80">
          Analyzing Holders...
        </div>
      </div>
    );
  }

  if (propNodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <p className="font-mono text-xs text-muted-foreground">
          No holder data
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full graph-grid-bg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={PRO_OPTIONS}
        nodesDraggable
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={3}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={40}
          lineWidth={0.5}
          color="#141c2b"
        />
        <Controls
          className="!border-border !bg-card [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&>button:hover]:!bg-muted"
          position="bottom-right"
        />
      </ReactFlow>

      {/* Cluster summary overlay */}
      {showForensics && forensicClusters.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 38,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.9)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            maxWidth: 340,
            maxHeight: 260,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: "#6b7b8d",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 2,
            }}
          >
            Suspicious Clusters
          </div>
          {forensicClusters.slice(0, 10).map((cluster) => {
            const clusterColor = CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length];
            return (
              <div key={cluster.id} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                <button
                  onClick={() =>
                    {
                      const nextClusterId = highlightedCluster === cluster.id ? null : cluster.id;
                      setHighlightedCluster(nextClusterId);
                      onSelectForensicsCluster?.(nextClusterId);
                    }
                  }
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 2,
                    flex: 1,
                    background:
                      highlightedCluster === cluster.id
                        ? `rgba(${hexToRgb(clusterColor)}, 0.12)`
                        : "none",
                    border: "none",
                    padding: "3px 4px",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "#c8d6e5",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (highlightedCluster !== cluster.id) {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        `rgba(${hexToRgb(clusterColor)}, 0.06)`;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (highlightedCluster !== cluster.id) {
                      (e.currentTarget as HTMLButtonElement).style.background = "none";
                    }
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: clusterColor,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: clusterColor }}>{cluster.label}</span>
                    <span style={{ marginLeft: "auto", color: "#6b7b8d" }}>
                      {cluster.riskScore.toFixed(1)}
                    </span>
                  </div>
                  <div>
                    {cluster.members.length} wallets, {cluster.totalPct.toFixed(1)}% supply
                  </div>
                  {cluster.reasons.slice(0, 2).map((reason) => (
                    <div key={reason} style={{ color: "#6b7b8d" }}>
                      {reason}
                    </div>
                  ))}
                </button>
                {onFundCluster && (
                  <button
                    onClick={() => onFundCluster(cluster.members)}
                    disabled={walkingFunding}
                    style={{
                      background: "rgba(255, 45, 45, 0.1)",
                      border: "1px solid rgba(255, 45, 45, 0.3)",
                      borderRadius: 3,
                      padding: "1px 5px",
                      cursor: walkingFunding ? "default" : "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 8,
                      color: "#ff2d2d",
                      flexShrink: 0,
                      opacity: walkingFunding ? 0.4 : 1,
                    }}
                  >
                    Fund
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForensics && forensicClusters.length === 0 && edges.length === 0 && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.9)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "8px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            maxWidth: 260,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: "#6b7b8d",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            Forensics
          </div>
          <div style={{ color: "#c8d6e5" }}>
            No controller, funding, entry, or wash-like links cleared the current threshold.
          </div>
          <div style={{ color: "#6b7b8d" }}>
            The graph is still showing the top holders. It is not showing a suspicious cluster.
          </div>
        </div>
      )}

      {showConnections && clusters.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 38,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.9)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            maxWidth: 280,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: "#6b7b8d",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 2,
            }}
          >
            Direct Transfer Clusters
          </div>
          {clusters.slice(0, 8).map((c) => {
            const clusterColor =
              CLUSTER_COLORS[c.id % CLUSTER_COLORS.length];
            return (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <button
                  onClick={() =>
                    setHighlightedCluster(
                      highlightedCluster === c.id ? null : c.id,
                    )
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flex: 1,
                    background:
                      highlightedCluster === c.id
                        ? `rgba(${hexToRgb(clusterColor)}, 0.12)`
                        : "none",
                    border: "none",
                    padding: "2px 4px",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "#c8d6e5",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (highlightedCluster !== c.id)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        `rgba(${hexToRgb(clusterColor)}, 0.06)`;
                  }}
                  onMouseLeave={(e) => {
                    if (highlightedCluster !== c.id)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "none";
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: clusterColor,
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    Cluster {c.id + 1}:{" "}
                    <span style={{ color: clusterColor }}>
                      {c.members.length} wallets
                    </span>
                    ,{" "}
                    <span style={{ color: clusterColor }}>
                      {c.totalPct.toFixed(1)}%
                    </span>
                  </span>
                </button>
                {onFundCluster && (
                  <button
                    onClick={() => onFundCluster(c.members)}
                    disabled={walkingFunding}
                    style={{
                      background: "rgba(255, 45, 45, 0.1)",
                      border: "1px solid rgba(255, 45, 45, 0.3)",
                      borderRadius: 3,
                      padding: "1px 5px",
                      cursor: walkingFunding ? "default" : "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 8,
                      color: "#ff2d2d",
                      flexShrink: 0,
                      opacity: walkingFunding ? 0.4 : 1,
                    }}
                  >
                    Fund
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Common funders overlay */}
      {showFunding && commonFunders.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 38,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.9)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            maxWidth: 300,
            maxHeight: 240,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: "#6b7b8d",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 2,
            }}
          >
            Common Funding Ancestors
          </div>
          {commonFunders.slice(0, 12).map((cf) => (
            <button
              key={cf.address}
              onClick={() =>
                setHighlightedFunder(
                  highlightedFunder === cf.address ? null : cf.address,
                )
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background:
                  highlightedFunder === cf.address
                    ? "rgba(255, 45, 45, 0.12)"
                    : "none",
                border: "none",
                padding: "2px 4px",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "#c8d6e5",
                textAlign: "left",
                width: "100%",
              }}
              onMouseEnter={(e) => {
                if (highlightedFunder !== cf.address)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "rgba(255, 45, 45, 0.06)";
              }}
              onMouseLeave={(e) => {
                if (highlightedFunder !== cf.address)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "none";
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: "#ff2d2d",
                  flexShrink: 0,
                }}
              />
              <span className="truncate" style={{ flex: 1 }}>
                {cf.label || truncAddr(cf.address)}
              </span>
              <span style={{ color: "#ff2d2d", flexShrink: 0 }}>
                {cf.holdersFunded} holders ({cf.holdersPctFunded.toFixed(1)}%)
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Bundle groups overlay */}
      {showBundles && bundleGroups.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 38,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.9)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            maxWidth: 300,
            maxHeight: 240,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 8,
              color: "#6b7b8d",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 2,
            }}
          >
            Synchronized Acquisitions (within 4 slots)
          </div>
          {bundleGroups.slice(0, 12).map((g, i) => {
            const color = BUNDLE_COLORS[i % BUNDLE_COLORS.length];
            return (
              <button
                key={g.slot}
                onClick={() =>
                  setHighlightedBundle(highlightedBundle === i ? null : i)
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background:
                    highlightedBundle === i
                      ? `rgba(${hexToRgb(color)}, 0.12)`
                      : "none",
                  border: "none",
                  padding: "2px 4px",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "#c8d6e5",
                  textAlign: "left",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  if (highlightedBundle !== i)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      `rgba(${hexToRgb(color)}, 0.06)`;
                }}
                onMouseLeave={(e) => {
                  if (highlightedBundle !== i)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "none";
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: color,
                    flexShrink: 0,
                  }}
                />
                <span className="truncate" style={{ flex: 1 }}>
                  Slot {g.slot.toLocaleString()}
                </span>
                <span style={{ color, flexShrink: 0 }}>
                  {g.members.length} wallets ({g.totalPct.toFixed(1)}%)
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Concentration legend — hide when showing connections or funding */}
      {!showConnections && !showFunding && !showBundles && !showForensics && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.85)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "6px 10px",
            display: "flex",
            gap: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "#6b7b8d",
          }}
        >
          {(Object.keys(TIER_COLORS) as HolderTier[]).map((tier) => (
            <div
              key={tier}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: TIER_COLORS[tier],
                  opacity: 0.8,
                }}
              />
              <span style={{ color: TIER_COLORS[tier] }}>
                {TIER_LABELS[tier]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && menuStyle && (
        <div
          style={{
            position: "fixed",
            left: menuStyle.left,
            top: menuStyle.top,
            zIndex: 50,
            background: "rgba(13, 19, 33, 0.95)",
            border: "1px solid #1e2a3a",
            borderRadius: 6,
            padding: "8px 0",
            fontFamily: "var(--font-mono)",
            minWidth: 170,
            boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
          }}
        >
          <div style={{ padding: "2px 12px 6px" }}>
            <div
              style={{
                fontSize: 10,
                color: "#c8d6e5",
                letterSpacing: "0.03em",
              }}
            >
              {truncAddr(contextMenu.address)}
            </div>
          </div>
          <div
            style={{ height: 1, background: "#1e2a3a", margin: "0 8px 4px" }}
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.address);
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "#c8d6e5",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "rgba(0, 212, 255, 0.08)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            Copy Address
          </button>
          <button
            onClick={() => {
              window.open(
                `https://solscan.io/account/${contextMenu.address}`,
                "_blank",
              );
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "#c8d6e5",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "rgba(0, 212, 255, 0.08)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            View on Solscan
          </button>
        </div>
      )}
    </div>
  );
}
