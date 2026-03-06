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
  thickness: number;
  opacity: number;
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
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<ConnectionEdgeData>>) {
  const d = data as ConnectionEdgeData;

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const strokeColor = "#ffffff"; // White — matches Bubblemaps style

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
        x={labelX - 60}
        y={labelY - 28}
        width={120}
        height={56}
        className="conn-edge-tooltip"
        style={{ overflow: "visible" }}
      >
        <div style={TOOLTIP_STYLE}>
          <div>{d.txCount} shared tx{d.txCount !== 1 ? "s" : ""}</div>
          <div style={{ color: "#6b7b8d" }}>
            {d.bidirectional ? "Bidirectional" : "One-way"}
          </div>
        </div>
      </foreignObject>
    </g>
  );
});
