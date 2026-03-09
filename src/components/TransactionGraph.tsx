import { useCallback, useState, useEffect, useRef, useMemo, memo } from "react";
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
  BaseEdge,
  getStraightPath,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// ---- Node ----

interface WalletNodeData {
  address: string;
  label?: string;
  category?: string;
  isCenter: boolean;
  nodeSize: number;
  tier: number; // 0 = center, 1 = top5, 2 = top6-15, 3 = rest
  volume: number;
  maxVolume: number;
  txCount?: number;
  solSent?: number;
  solReceived?: number;
  walletColor?: string;
  walletIndex?: number;
  accountType?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenLogoUri?: string;
  connectedWalletColors?: string[];
  layoutMode?: "single-wallet" | "multi-wallet";
  [key: string]: unknown;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 3)}...${addr.slice(-3)}`;
}

function categoryColor(category?: string): string {
  switch (category) {
    case "exchange":
      return "#ffb800";
    case "defi":
      return "#00ff88";
    case "nft":
      return "#a855f7";
    case "domain":
    case "SNS":
      return "#00d4ff";
    default:
      return "#6b7b8d";
  }
}

function colorToRgb(hex: string): string {
  switch (hex) {
    case "#00d4ff": return "0, 212, 255";
    case "#ffb800": return "255, 184, 0";
    case "#00ff88": return "0, 255, 136";
    case "#a855f7": return "168, 85, 247";
    case "#ff6b35": return "255, 107, 53";
    default: return "107, 123, 141";
  }
}

// Invisible handle shared by all nodes
const HIDDEN_HANDLE_CLASS = "!opacity-0 !pointer-events-none !w-0 !h-0";
const CENTER_HANDLE_CLASS = "!opacity-0 !pointer-events-none";
const CENTER_HANDLE_STYLE = {
  left: "50%",
  top: "50%",
  right: "auto",
  bottom: "auto",
  width: 1,
  height: 1,
  opacity: 0,
  border: "none",
  background: "transparent",
  transform: "translate(-50%, -50%)",
} as const;

/**
 * WalletNode — wrapped in React.memo to prevent re-rendering when other nodes change.
 * Hover effects are pure CSS (no useState) to avoid triggering React re-renders.
 * CSS custom property --ring-rgb drives glow color; data-tier drives glow intensity via CSS.
 */
const WalletNode = memo(function WalletNode({ data }: NodeProps<Node<WalletNodeData>>) {
  const d = data as WalletNodeData;

  if (d.isCenter) {
    // ---- Center / Hub node ----
    const size = d.nodeSize;
    const color = d.walletColor ?? "#00d4ff";
    const rgb = colorToRgb(color);
    const hubLabel = d.walletIndex != null && d.walletIndex > 0 ? "Overlay" : "Target";
    return (
      <>
        <Handle
          type="target"
          position={Position.Left}
          className={CENTER_HANDLE_CLASS}
          style={CENTER_HANDLE_STYLE}
        />
        <div
          className="center-node-pulse relative flex flex-col items-center justify-center"
          style={{
            width: size,
            borderRadius: 6,
            border: `2px solid ${color}`,
            outline: `2px solid rgba(${rgb}, 0.3)`,
            outlineOffset: 2,
            backgroundColor: "#0d1321",
            boxShadow: `0 0 0 1px rgba(${rgb}, 0.18) inset`,
            padding: "8px 6px",
          }}
        >
          <div
            className="solo-drag absolute top-0 right-0 flex items-center justify-center"
            style={{
              width: 18, height: 18,
              borderRadius: "0 4px 0 4px",
              backgroundColor: `rgba(${rgb}, 0.15)`,
              cursor: "grab", fontSize: 9,
              color: `rgba(${rgb}, 0.5)`,
              transition: "background-color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = `rgba(${rgb}, 0.35)`; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = `rgba(${rgb}, 0.15)`; }}
            title="Drag solo (without group)"
          >
            ⊹
          </div>
          <div className="font-mono text-[8px] uppercase tracking-[0.2em]" style={{ color: `rgba(${rgb}, 0.5)` }}>
            {hubLabel}
          </div>
          {d.label && (
            <div className="truncate font-mono text-[11px] font-bold" style={{ maxWidth: size - 16, color }}>
              {d.label}
            </div>
          )}
          <div className="font-mono text-[10px] text-muted-foreground">
            {truncAddr(d.address)}
          </div>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          className={CENTER_HANDLE_CLASS}
          style={CENTER_HANDLE_STYLE}
        />
      </>
    );
  }

  // ---- Counterparty node: CSS-driven hover, no useState ----
  const ringColor = categoryColor(d.category);
  const rgb = colorToRgb(ringColor);
  const size = d.nodeSize;
  const tier = d.tier;
  const acctType = d.accountType;
  const isSingleWalletLayout = d.layoutMode === "single-wallet";
  const vol = d.volume;
  const volStr = vol >= 1000 ? `${(vol / 1000).toFixed(1)}k` : vol >= 1 ? vol.toFixed(1) : vol >= 0.01 ? vol.toFixed(2) : "<0.01";
  const connectedColors = d.connectedWalletColors;
  const showMultiDot = connectedColors && connectedColors.length > 1;

  // CSS custom property for glow color; tier-based intensity handled by CSS
  const cssVars = { '--ring-rgb': rgb } as React.CSSProperties;

  // Label — always rendered, CSS controls visibility by tier + :hover
  const labelEl = d.label ? (
    <div className="node-label truncate font-mono text-[9px] font-bold leading-tight text-center"
      style={{ color: ringColor, maxWidth: size - 16 }}>
      {d.label}
    </div>
  ) : null;

  const addrEl = (
    <div className="node-addr font-mono text-[9px] text-muted-foreground leading-tight">
      {truncAddr(d.address)}
    </div>
  );

  const statsEl = (
    <div className="node-stats font-mono text-[8px] leading-tight mt-0.5">
      <span className="text-foreground">{volStr} SOL</span>
      <span className="text-muted-foreground/50 mx-0.5">|</span>
      <span className="text-muted-foreground/70">{d.txCount} tx</span>
    </div>
  );

  // Multi-dot indicator for shared counterparties
  const multiDotEl = showMultiDot ? (
    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 flex gap-0.5">
      {connectedColors.map((c, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      ))}
    </div>
  ) : null;

  if (isSingleWalletLayout) {
    return (
      <>
        <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE_CLASS} />
        <div className="relative">
          <div
            className="node-shape flex flex-col items-center justify-center"
            data-tier={2}
            style={{
              ...cssVars,
              width: size,
              borderRadius: 4,
              border: "1px solid rgba(107, 123, 141, 0.65)",
              backgroundColor: "rgba(13, 19, 33, 0.96)",
              overflow: "hidden",
              padding: "6px 6px",
            }}
          >
            {d.label ? (
              <div
                className="truncate font-mono text-[9px] font-bold leading-tight text-center text-foreground"
                style={{ maxWidth: size - 16 }}
              >
                {d.label}
              </div>
            ) : null}
            <div className="font-mono text-[9px] text-muted-foreground leading-tight">
              {truncAddr(d.address)}
            </div>
            <div className="font-mono text-[8px] leading-tight mt-0.5">
              <span className="text-foreground">{d.txCount} tx</span>
            </div>
          </div>
        </div>
        <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE_CLASS} />
      </>
    );
  }

  if (acctType === "token") {
    const tokenDisplay = d.tokenSymbol ?? d.tokenName;
    const logoSize = Math.max(Math.round(size * 0.28), 22);
    return (
      <>
        <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE_CLASS} />
        <div className="relative">
          {multiDotEl}
          <div className="node-shape flex flex-col items-center justify-center gap-0.5" data-tier={tier}
            style={{ ...cssVars, width: size, height: size, borderRadius: "50%", border: `1px solid ${ringColor}`,
              backgroundColor: "rgba(13, 19, 33, 0.95)", overflow: "hidden", padding: "6px 6px" }}>
            {d.tokenLogoUri && (
              <img src={d.tokenLogoUri} alt="" draggable={false}
                style={{ width: logoSize, height: logoSize, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            )}
            {tokenDisplay && (
              <div className="truncate font-mono font-bold leading-tight text-center"
                style={{ fontSize: size >= 140 ? 11 : 9, color: "#ffb800", maxWidth: size * 0.6 }}>
                {tokenDisplay}
              </div>
            )}
            <div className="node-addr font-mono text-[8px] text-muted-foreground leading-tight">
              {truncAddr(d.address)}
            </div>
            <div className="node-stats font-mono text-[7px] leading-tight">
              <span className="text-foreground">{volStr} SOL</span>
              <span className="text-muted-foreground/50 mx-0.5">|</span>
              <span className="text-muted-foreground/70">{d.txCount} tx</span>
            </div>
          </div>
        </div>
        <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE_CLASS} />
      </>
    );
  }

  if (acctType === "program") {
    const triH = size * 0.87;
    return (
      <>
        <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE_CLASS} style={{ top: "65%", left: "10%" }} />
        <div className="relative">
          {multiDotEl}
          <div className="node-shape relative flex items-end justify-center" data-tier={tier}
            style={{ ...cssVars, width: size, height: triH }}>
            <svg viewBox={`0 0 ${size} ${triH}`} width={size} height={triH}
              style={{ position: "absolute", top: 0, left: 0 }}>
              <polygon
                points={`${size / 2},2 ${size - 2},${triH - 2} 2,${triH - 2}`}
                fill="rgba(13, 19, 33, 0.95)"
                stroke={ringColor}
                strokeWidth="1"
                className="node-polygon"
              />
            </svg>
            <div className="relative flex flex-col items-center justify-center"
              style={{ paddingBottom: 6, width: size - 16 }}>
              {labelEl}
              {addrEl}
              {statsEl}
            </div>
          </div>
        </div>
        <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE_CLASS} style={{ top: "65%", right: "10%" }} />
      </>
    );
  }

  // Default: rounded rectangle (wallets, other, unknown)
  return (
    <>
      <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE_CLASS} />
      <div className="relative">
        {multiDotEl}
        <div className="node-shape flex flex-col items-center justify-center" data-tier={tier}
          style={{ ...cssVars, width: size, borderRadius: 4, border: `1px solid ${ringColor}`,
            backgroundColor: "rgba(13, 19, 33, 0.95)", overflow: "hidden", padding: "6px 6px" }}>
          {labelEl}
          {addrEl}
          {statsEl}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE_CLASS} />
    </>
  );
});

// ---- Edge with hover tooltip (CSS-only hover, no useState) ----

interface FlowEdgeData {
  solSent: number;
  solReceived: number;
  txCount: number;
  isOutflow: boolean;
  thickness: number;
  intensity?: number;
  volume: number;
  maxVolume: number;
  [key: string]: unknown;
}

function fmtSol(sol: number): string {
  if (sol < 0.001) return "<0.001";
  if (sol >= 1000) return sol.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return sol.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "rgba(13, 19, 33, 0.95)",
  border: "1px solid #1e2a3a",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  color: "#c8d6e5",
  whiteSpace: "nowrap",
  textAlign: "center",
};

const FlowEdge = memo(function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<FlowEdgeData>>) {
  const d = data as FlowEdgeData;

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX, sourceY, targetX, targetY,
  });

  const strokeColor = d.isOutflow ? "#ff2d2d" : "#00ff88";
  const opacity = 0.18 + Math.min(Math.max(d.intensity ?? 0, 0), 1) * 0.72;

  return (
    <g className="flow-edge-group"
      style={{ '--edge-opacity': opacity, '--edge-hover-opacity': Math.min(opacity + 0.3, 1) } as React.CSSProperties}>
      {/* Invisible fat hit area for hover — pointerEvents="all" ensures transparent stroke is hoverable */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={20} pointerEvents="all" style={{ cursor: "default" }} />
      {/* Visible edge — opacity/animation controlled by CSS */}
      <BaseEdge id={id} path={edgePath} style={{
        stroke: strokeColor,
        strokeWidth: d.thickness,
        strokeLinecap: "round",
      }} />
      {/* Tooltip — always rendered, CSS toggles opacity on .flow-edge-group:hover */}
      <foreignObject x={labelX - 55} y={labelY - 30} width={110} height={60}
        className="edge-tooltip" style={{ overflow: "visible" }}>
        <div style={TOOLTIP_STYLE}>
          <div>
            <span style={{ color: "#ff2d2d" }}>{fmtSol(d.solSent)}</span>
            {" sent / "}
            <span style={{ color: "#00ff88" }}>{fmtSol(d.solReceived)}</span>
            {" recv"}
          </div>
          <div style={{ color: "#6b7b8d" }}>{d.txCount} tx</div>
        </div>
      </foreignObject>
    </g>
  );
});

const nodeTypes = { walletNode: WalletNode };
const edgeTypes = { flowEdge: FlowEdge };

// ---- Static config objects (hoisted to avoid re-creation on every render) ----

const FIT_VIEW_OPTIONS = { padding: 0.06, maxZoom: 1.7 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

// ---- Graph container ----

interface TransactionGraphProps {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  onNavigate: (address: string) => void;
  onAddOverlay: (address: string) => void;
  onRemoveNode: (address: string) => void;
  canAddOverlay: boolean;
  selectedAddress: string | null;
  onSelectAddress: (address: string) => void;
}

interface ContextMenuState {
  address: string;
  label?: string;
  isHub: boolean;
  screenX: number;
  screenY: number;
}

export function TransactionGraph({
  nodes: propNodes,
  edges: propEdges,
  loading,
  onNavigate,
  onAddOverlay,
  onRemoveNode,
  canAddOverlay,
  selectedAddress,
  onSelectAddress,
}: TransactionGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(propNodes);
  const [edges, setEdges] = useEdgesState(propEdges);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    setNodes(
      propNodes.map((n) => {
        const className = n.id === selectedAddress
          ? `${n.className ?? ""} wallet-node-selected`.trim()
          : n.className;
        return { ...n, className };
      }),
    );
  }, [propNodes, selectedAddress, setNodes]);

  useEffect(() => {
    setEdges(propEdges);
  }, [propEdges, setEdges]);

  // Precompute which counterparties are exclusive to each hub
  const exclusiveMap = useMemo(() => {
    const hubIds = new Set(
      propNodes.filter((n) => (n.data as WalletNodeData).isCenter).map((n) => n.id),
    );
    const nodeToHubs = new Map<string, Set<string>>();
    for (const edge of propEdges) {
      if (hubIds.has(edge.source) && !hubIds.has(edge.target)) {
        if (!nodeToHubs.has(edge.target)) nodeToHubs.set(edge.target, new Set());
        nodeToHubs.get(edge.target)!.add(edge.source);
      }
      if (hubIds.has(edge.target) && !hubIds.has(edge.source)) {
        if (!nodeToHubs.has(edge.source)) nodeToHubs.set(edge.source, new Set());
        nodeToHubs.get(edge.source)!.add(edge.target);
      }
    }
    const map = new Map<string, Set<string>>();
    for (const hubId of hubIds) map.set(hubId, new Set());
    for (const [nodeId, hubs] of nodeToHubs) {
      if (hubs.size === 1) {
        const hubId = hubs.values().next().value as string;
        map.get(hubId)?.add(nodeId);
      }
    }
    return map;
  }, [propNodes, propEdges]);

  // ---- Drag / click interaction ----
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);
  const dragOccurred = useRef(false);
  const soloDrag = useRef(false);
  const pendingDelta = useRef<{ dx: number; dy: number } | null>(null);
  const rafId = useRef(0);

  // Clean up rAF on unmount
  useEffect(() => () => { cancelAnimationFrame(rafId.current); }, []);

  const handleNodeDragStart = useCallback((event: React.MouseEvent, node: Node) => {
    lastDragPos.current = { x: node.position.x, y: node.position.y };
    dragOccurred.current = false;
    const target = event.target as HTMLElement;
    soloDrag.current = !!target.closest(".solo-drag");
  }, []);

  const handleNodeDrag = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!lastDragPos.current) return;

      const dx = node.position.x - lastDragPos.current.x;
      const dy = node.position.y - lastDragPos.current.y;
      if (dx === 0 && dy === 0) return;

      dragOccurred.current = true;
      lastDragPos.current = { x: node.position.x, y: node.position.y };

      const data = node.data as WalletNodeData;
      if (!data.isCenter || soloDrag.current) return;

      const exclusive = exclusiveMap.get(node.id);
      if (!exclusive || exclusive.size === 0) return;

      // Batch with rAF — accumulate deltas, apply once per animation frame
      if (pendingDelta.current) {
        pendingDelta.current.dx += dx;
        pendingDelta.current.dy += dy;
      } else {
        pendingDelta.current = { dx, dy };
        rafId.current = requestAnimationFrame(() => {
          const delta = pendingDelta.current;
          if (!delta) return;
          pendingDelta.current = null;
          setNodes((nds) =>
            nds.map((n) =>
              exclusive.has(n.id)
                ? { ...n, position: { x: n.position.x + delta.dx, y: n.position.y + delta.dy } }
                : n,
            ),
          );
        });
      }
    },
    [exclusiveMap, setNodes],
  );

  const handleNodeDragStop = useCallback(() => {
    setTimeout(() => {
      dragOccurred.current = false;
    }, 0);
  }, []);

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (dragOccurred.current) return;

      const data = node.data as WalletNodeData;
      if (!data.isCenter) {
        onSelectAddress(node.id);
      }
      setContextMenu({
        address: node.id,
        label: data.label,
        isHub: data.isCenter,
        screenX: event.clientX,
        screenY: event.clientY,
      });
    },
    [onSelectAddress],
  );

  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  // Clamp menu position to viewport
  const menuStyle = useMemo(() => {
    if (!contextMenu) return null;
    const menuW = 180;
    const menuH = 100;
    const x = Math.min(contextMenu.screenX, window.innerWidth - menuW - 8);
    const y = Math.min(contextMenu.screenY, window.innerHeight - menuH - 8);
    return { left: x, top: y };
  }, [contextMenu]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <div className="scanning-text font-mono text-sm uppercase tracking-[0.4em] text-primary/80">
          Scanning...
        </div>
      </div>
    );
  }

  if (propNodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card graph-grid-bg">
        <p className="font-mono text-xs text-muted-foreground">
          No graph data
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
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={PRO_OPTIONS}
        nodesDraggable
        nodesConnectable={false}
        minZoom={0.3}
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

      {/* Node context menu */}
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
          {/* Address + label header */}
          <div style={{ padding: "2px 12px 6px" }}>
            <div style={{ fontSize: 10, color: "#c8d6e5", letterSpacing: "0.03em" }}>
              {truncAddr(contextMenu.address)}
            </div>
            {contextMenu.label && (
              <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 600, marginTop: 1 }}>
                {contextMenu.label}
              </div>
            )}
          </div>

          {/* Separator */}
          <div style={{ height: 1, background: "#1e2a3a", margin: "0 8px 4px" }} />

          {/* Navigate */}
          <button
            onClick={() => { onNavigate(contextMenu.address); setContextMenu(null); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "6px 12px", background: "none", border: "none",
              color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <span style={{ fontSize: 13 }}>→</span>
            Navigate
          </button>

          {/* Add to Compare */}
          {!contextMenu.isHub && (
            <button
              onClick={() => { if (!canAddOverlay) return; onAddOverlay(contextMenu.address); setContextMenu(null); }}
              disabled={!canAddOverlay}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 12px", background: "none", border: "none",
                color: canAddOverlay ? "#c8d6e5" : "#3a4a5a", fontSize: 11,
                fontFamily: "var(--font-mono)", cursor: canAddOverlay ? "pointer" : "default", textAlign: "left",
              }}
              onMouseEnter={(e) => { if (canAddOverlay) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <span style={{ fontSize: 13 }}>+</span>
              Add to Compare
            </button>
          )}

          {/* Remove from Graph */}
          {!contextMenu.isHub && (
            <button
              onClick={() => { onRemoveNode(contextMenu.address); setContextMenu(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 12px", background: "none", border: "none",
                color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
                cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255, 45, 45, 0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <span style={{ fontSize: 13, color: "#ff2d2d" }}>&times;</span>
              Remove from Graph
            </button>
          )}
        </div>
      )}
    </div>
  );
}
