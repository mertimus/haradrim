import { memo } from "react";
import {
  type Edge,
  type EdgeProps,
  BaseEdge,
  getStraightPath,
} from "@xyflow/react";

export interface ConnectionEdgeData {
  txCount: number;
  bidirectional: boolean;
  sourceToTargetTxCount: number;
  targetToSourceTxCount: number;
  thickness: number;
  opacity: number;
  firstSeen: number;
  lastSeen: number;
  [key: string]: unknown;
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "rgba(13, 19, 33, 0.95)",
  border: "1px solid #1e2a3a",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  color: "#c8d6e5",
  textAlign: "center",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

export const ConnectionEdge = memo(function ConnectionEdge({
  id,
  source,
  sourceX,
  sourceY,
  target,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<ConnectionEdgeData>>) {
  const d = data as ConnectionEdgeData;
  const shortAddr = (address: string | null | undefined) =>
    address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "unknown";

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const strokeColor = "#ffffff"; // White — matches Bubblemaps style
  const fmtDate = (timestamp: number) =>
    timestamp > 0 ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "unknown";

  return (
    <g
      className="connection-edge-group connection-edge-reveal"
      style={
        {
          "--edge-opacity": d.opacity,
        } as React.CSSProperties
      }
    >
      {/* Invisible fat hit area for hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        pointerEvents="all"
        style={{ cursor: "default" }}
      />
      {/* Visible edge */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: d.thickness,
          opacity: d.opacity,
        }}
      />
      {/* Tooltip — CSS toggles opacity on hover */}
      <foreignObject
        x={labelX - 80}
        y={labelY - 34}
        width={160}
        height={72}
        className="conn-edge-tooltip"
        style={{ overflow: "visible" }}
      >
        <div style={TOOLTIP_STYLE}>
          <div>{d.txCount} unique tx{d.txCount !== 1 ? "s" : ""}</div>
          <div style={{ color: "#6b7b8d" }}>
            {shortAddr(source)} → {shortAddr(target)}: {d.sourceToTargetTxCount}
          </div>
          <div style={{ color: "#6b7b8d" }}>
            {shortAddr(target)} → {shortAddr(source)}: {d.targetToSourceTxCount}
          </div>
          <div style={{ color: "#6b7b8d" }}>
            {d.bidirectional ? "Bidirectional flow" : "One-way flow"} | last {fmtDate(d.lastSeen)}
          </div>
        </div>
      </foreignObject>
    </g>
  );
});
