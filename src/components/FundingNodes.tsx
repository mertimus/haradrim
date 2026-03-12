import { memo } from "react";
import {
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  Handle,
  Position,
  BaseEdge,
  getStraightPath,
} from "@xyflow/react";

// ---- Helpers ----

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function hexToRgb(hex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return "107, 123, 141";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// ---- Funder Node ----

interface FunderNodeData {
  address: string;
  label?: string;
  holdersFunded: number;
  holdersPctFunded: number;
  nodeSize: number;
  color: string;
  isPrimary: boolean;
  [key: string]: unknown;
}

export const FunderNode = memo(function FunderNode({
  data,
}: NodeProps<Node<FunderNodeData>>) {
  const d = data as FunderNodeData;
  const size = d.nodeSize;
  const rgb = hexToRgb(d.color);

  return (
    <div
      className={`node-shape flex flex-col items-center justify-center ${d.isPrimary ? "funder-pulse" : ""}`}
      data-tier="1"
      style={{
        "--ring-rgb": rgb,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${d.color}`,
        backgroundColor: `rgba(${rgb}, 0.12)`,
        padding: 4,
      } as React.CSSProperties}
    >
      {d.label && size >= 70 && (
        <div
          className="truncate font-mono font-bold leading-tight text-center"
          style={{
            fontSize: size >= 120 ? 11 : 9,
            color: d.color,
            maxWidth: size - 16,
          }}
        >
          {d.label}
        </div>
      )}
      <div
        className="font-mono leading-tight"
        style={{ fontSize: size >= 100 ? 10 : 8, color: "#c8d6e5" }}
      >
        {truncAddr(d.address)}
      </div>
      <div
        className="font-mono font-bold leading-tight"
        style={{
          fontSize: size >= 100 ? 9 : 7,
          color: d.color,
          marginTop: 2,
        }}
      >
        {d.holdersFunded} holders ({d.holdersPctFunded.toFixed(1)}%)
      </div>
      <Handle type="source" position={Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="target" position={Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
});

// ---- Intermediate Node ----

interface IntermediateNodeData {
  address: string;
  label?: string;
  nodeSize: number;
  color: string;
  [key: string]: unknown;
}

export const IntermediateNode = memo(function IntermediateNode({
  data,
}: NodeProps<Node<IntermediateNodeData>>) {
  const d = data as IntermediateNodeData;
  const size = d.nodeSize;

  return (
    <div
      className="group relative"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: d.color,
        border: "1px solid #3a4555",
      }}
    >
      {/* Tooltip on hover */}
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          bottom: size + 4,
          background: "rgba(13, 19, 33, 0.95)",
          border: "1px solid #1e2a3a",
          borderRadius: 4,
          padding: "3px 6px",
          fontFamily: "var(--font-mono)",
          fontSize: 8,
          color: "#c8d6e5",
          whiteSpace: "nowrap",
          zIndex: 20,
        }}
      >
        {d.label || truncAddr(d.address)}
      </div>
    </div>
  );
});

// ---- Funding Edge ----

interface FundingEdgeData {
  amount: number;
  isHighlight: boolean;
  thickness: number;
  opacity: number;
  [key: string]: unknown;
}

export const FundingEdge = memo(function FundingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<FundingEdgeData>>) {
  const d = data as FundingEdgeData;

  const [edgePath] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <g
      className="funding-edge-group funding-edge-reveal"
      style={{ "--edge-opacity": d.opacity } as React.CSSProperties}
    >
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: d.isHighlight ? "#ffb800" : "#6b7b8d",
          strokeWidth: d.thickness,
          opacity: d.opacity,
        }}
      />
    </g>
  );
});
