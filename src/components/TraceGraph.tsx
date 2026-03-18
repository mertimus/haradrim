import { useCallback, useRef, useState, useEffect, useMemo, memo } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeProps,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  getBezierPath,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { TraceAssetFlow } from "@/lib/trace-types";

// ---- Helpers ----

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function categoryColor(category?: string): string {
  switch (category) {
    case "exchange": return "#ffb800";
    case "defi": return "#7cc6fe";
    case "nft": return "#ffd966";
    case "domain":
    case "SNS": return "#00d4ff";
    default: return "#4a5a6a";
  }
}

function fmtCompact(value: number): string {
  if (value < 0.01 && value > 0) return "<0.01";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function assetTicker(asset: TraceAssetFlow): string {
  if (asset.symbol) return asset.symbol;
  if (asset.kind === "native") return "SOL";
  const addr = asset.mint ?? asset.assetId;
  if (!addr || addr.length < 8) return "";
  return truncAddr(addr);
}

const NODE_WIDTH = 200;

// ---- TraceNode ----

interface TraceNodeData {
  address: string;
  label?: string;
  category?: string;
  isSeed: boolean;
  txCount: number;
  transferCount: number;
  [key: string]: unknown;
}

const TraceNode = memo(function TraceNode({ data }: NodeProps<Node<TraceNodeData>>) {
  const d = data as TraceNodeData;
  const borderColor = d.isSeed ? "#00d4ff" : categoryColor(d.category);
  const txStr = d.txCount > 0 ? `${fmtCompact(d.txCount)} tx` : "";
  const transferStr = d.transferCount > 0 ? `${fmtCompact(d.transferCount)} moves` : "";

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: "#4a5a6a", width: 6, height: 6, border: "none" }} />
      <div
        className={d.isSeed ? "center-node-pulse" : undefined}
        style={{
          width: NODE_WIDTH,
          borderRadius: 4,
          border: `${d.isSeed ? 2 : 1}px solid ${borderColor}`,
          backgroundColor: "rgba(13, 19, 33, 0.95)",
          padding: "7px 10px",
          position: "relative",
        }}
      >
        {d.label && (
          <div
            className="font-mono text-[10px] font-bold truncate"
            style={{ color: d.isSeed ? "#00d4ff" : "#c8d6e5", maxWidth: NODE_WIDTH - 24 }}
          >
            {d.label}
          </div>
        )}
        <div className="font-mono text-[9px] text-muted-foreground">
          {truncAddr(d.address)}
        </div>
        {(txStr || transferStr) && (
          <div className="font-mono text-[9px] text-foreground/70 mt-0.5">
            {[txStr, transferStr].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#4a5a6a", width: 6, height: 6, border: "none" }} />
    </>
  );
});

// ---- TraceEdge: bezier curve with always-visible label ----

interface TraceEdgeData {
  assets: TraceAssetFlow[];
  txCount: number;
  transferCount: number;
  assetCount: number;
  firstSeen: number;
  lastSeen: number;
  weight: number;
  selected?: boolean;
  [key: string]: unknown;
}

function formatEdgeDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const EDGE_LABEL_STYLE: React.CSSProperties = {
  background: "rgba(13, 19, 33, 0.94)",
  border: "1px solid #1e2a3a",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  color: "#c8d6e5",
  textAlign: "left",
  lineHeight: "15px",
  width: "max-content",
  maxWidth: 220,
};

const EDGE_ROW_STYLE: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const TraceEdge = memo(function TraceEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<TraceEdgeData>>) {
  const d = data as TraceEdgeData;
  const strokeWidth = 1.5 + (d.weight ?? 0) * 4.5;
  const hitAreaRef = useRef<SVGPathElement>(null);

  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  const solAsset = d.assets.find((a) => a.kind === "native");
  const solLine = solAsset ? fmtCompact(solAsset.uiAmount) : "0";
  const tokens = d.assets
    .filter((a) => a.kind === "token")
    .filter((a) => {
      const ticker = assetTicker(a);
      return ticker && ticker !== "..." && ticker.length > 0;
    });
  const topTokens = tokens.slice(0, 3);
  const remainingCount = tokens.length - topTokens.length;
  const tokenLine = topTokens.map((a) => assetTicker(a)).join(", ")
    + (remainingCount > 0 ? ` +${remainingCount}` : "");
  const dateLine = formatEdgeDate(d.lastSeen);

  const handleLabelClick = useCallback((e: React.MouseEvent) => {
    // Dispatch a synthetic click on the SVG hit-area path so ReactFlow's onEdgeClick fires
    hitAreaRef.current?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
  }, []);

  return (
    <g>
      <path ref={hitAreaRef} d={path} fill="none" stroke="transparent" strokeWidth={16} pointerEvents="all" style={{ cursor: "pointer" }} />
      <path d={path} fill="none" stroke={d.selected ? "#00d4ff" : "#3a4a5a"} strokeWidth={strokeWidth} pointerEvents="none" />
      <foreignObject
        x={labelX - 110}
        y={labelY - 38}
        width={220}
        height={80}
        style={{ overflow: "visible", pointerEvents: "all", cursor: "pointer" }}
      >
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div style={{ ...EDGE_LABEL_STYLE, cursor: "pointer" }} onClick={handleLabelClick}>
          <div style={EDGE_ROW_STYLE}><span style={{ color: "#6b7b8d" }}>SOL: </span><span style={{ color: "#ffb800" }}>{solLine}</span></div>
          {tokens.length > 0 && <div style={EDGE_ROW_STYLE}><span style={{ color: "#6b7b8d" }}>Tokens: </span><span style={{ color: "#c8d6e5" }}>{tokenLine}</span></div>}
          <div style={EDGE_ROW_STYLE}><span style={{ color: "#6b7b8d" }}>Transactions: </span><span style={{ color: "#c8d6e5" }}>{d.txCount}</span></div>
          {dateLine && <div style={EDGE_ROW_STYLE}><span style={{ color: "#6b7b8d" }}>Last seen: </span><span style={{ color: "#c8d6e5" }}>{dateLine}</span></div>}
        </div>
      </foreignObject>
    </g>
  );
});

// ---- Registrations ----

const nodeTypes = { traceNode: TraceNode };
const edgeTypes = { traceEdge: TraceEdge };

const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.5 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

// ---- TraceGraph component ----

interface TraceGraphProps {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  selectedNodeAddr: string | null;
  selectedEdgeId: string | null;
  onNodeClick: (address: string) => void;
  onEdgeClick: (source: string, target: string) => void;
  onNavigateToWallet?: (address: string) => void;
}

export function TraceGraph({
  nodes: propNodes,
  edges: propEdges,
  loading,
  selectedNodeAddr,
  selectedEdgeId,
  onNodeClick,
  onEdgeClick,
  onNavigateToWallet,
}: TraceGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(propNodes);
  const [edges, setEdges] = useEdgesState(propEdges);
  const [contextMenu, setContextMenu] = useState<{
    address: string; label?: string; screenX: number; screenY: number;
  } | null>(null);

  // Sync nodes — preserve positions of existing nodes, use computed for new
  useEffect(() => {
    setNodes((current) => {
      const posMap = new Map(current.map((n) => [n.id, n.position]));
      return propNodes.map((n) => ({
        ...n,
        position: posMap.get(n.id) ?? n.position,
        className: n.id === selectedNodeAddr ? "trace-node-selected" : undefined,
      }));
    });
  }, [propNodes, setNodes, selectedNodeAddr]);

  useEffect(() => {
    setEdges(propEdges.map((e) => ({
      ...e,
      data: { ...e.data, selected: selectedEdgeId === `${e.source}:${e.target}` },
    })));
  }, [propEdges, setEdges, selectedEdgeId]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setContextMenu(null);
      onNodeClick(node.id);
    },
    [onNodeClick],
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setContextMenu(null);
      onEdgeClick(edge.source, edge.target);
    },
    [onEdgeClick],
  );

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const d = node.data as TraceNodeData;
      setContextMenu({ address: node.id, label: d.label, screenX: event.clientX, screenY: event.clientY });
    },
    [],
  );

  const handlePaneClick = useCallback(() => { setContextMenu(null); }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  const menuStyle = useMemo(() => {
    if (!contextMenu) return null;
    return {
      left: Math.min(contextMenu.screenX, window.innerWidth - 190),
      top: Math.min(contextMenu.screenY, window.innerHeight - 120),
    };
  }, [contextMenu]);

  if (loading && propNodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <div className="scanning-text font-mono text-sm uppercase tracking-[0.4em] text-primary/80">
          Tracing...
        </div>
      </div>
    );
  }

  if (propNodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <p className="font-mono text-xs text-muted-foreground">No trace data</p>
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
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={PRO_OPTIONS}
        nodesDraggable
        nodesConnectable={false}
        minZoom={0.1}
        maxZoom={2.5}
      >
        <Background variant={BackgroundVariant.Lines} gap={40} lineWidth={0.5} color="#141c2b" />
        <Controls
          className="!border-border !bg-card [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&>button:hover]:!bg-muted"
          position="bottom-right"
        />
      </ReactFlow>

      {/* Right-click context menu */}
      {contextMenu && menuStyle && (
        <div
          style={{
            position: "fixed", left: menuStyle.left, top: menuStyle.top, zIndex: 50,
            background: "rgba(13, 19, 33, 0.95)", border: "1px solid #1e2a3a",
            borderRadius: 6, padding: "8px 0", fontFamily: "var(--font-mono)",
            minWidth: 170, boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
          }}
        >
          <div style={{ padding: "2px 12px 6px" }}>
            <div style={{ fontSize: 10, color: "#c8d6e5" }}>
              {truncAddr(contextMenu.address)}
            </div>
            {contextMenu.label && (
              <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 600, marginTop: 1 }}>
                {contextMenu.label}
              </div>
            )}
          </div>
          <div style={{ height: 1, background: "#1e2a3a", margin: "0 8px 4px" }} />
          {[
            { icon: "⊡", text: "Copy Address", action: () => navigator.clipboard.writeText(contextMenu.address) },
            { icon: "↗", text: "View on Solscan", action: () => window.open(`https://solscan.io/account/${contextMenu.address}`, "_blank") },
            ...(onNavigateToWallet
              ? [{ icon: "→", text: "Open in Wallet View", action: () => onNavigateToWallet!(contextMenu.address) }]
              : []),
          ].map((item) => (
            <button
              key={item.text}
              onClick={() => { item.action(); setContextMenu(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 12px", background: "none", border: "none",
                color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
                cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <span style={{ fontSize: 13 }}>{item.icon}</span>
              {item.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
