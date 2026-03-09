import { memo } from "react";
import {
  type Edge,
  type EdgeProps,
  BaseEdge,
  getStraightPath,
} from "@xyflow/react";
import type { ForensicSignalKind } from "@/lib/suspicious-clusters";

export interface EvidenceEdgeData {
  totalScore: number;
  thickness: number;
  opacity: number;
  dominantSignal: ForensicSignalKind;
  summaryLines: string[];
  [key: string]: unknown;
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "rgba(13, 19, 33, 0.96)",
  border: "1px solid #1e2a3a",
  borderRadius: 4,
  padding: "5px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  color: "#c8d6e5",
  textAlign: "left",
  pointerEvents: "none",
};

function edgeColor(kind: ForensicSignalKind): string {
  switch (kind) {
    case "shared_funding_ancestor":
      return "#ff2d2d";
    case "shared_fee_payer":
      return "#ec4899";
    case "shared_signer":
      return "#f97316";
    case "shared_trading_venue":
      return "#60a5fa";
    case "amount_similarity":
      return "#00ff88";
    case "shared_token_source":
      return "#84cc16";
    case "synchronized_acquisition":
      return "#a855f7";
    case "reciprocal_transfer":
      return "#22d3ee";
    case "direct_transfer":
    default:
      return "#ffb800";
  }
}

export const EvidenceEdge = memo(function EvidenceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<EvidenceEdgeData>>) {
  const d = data as EvidenceEdgeData;
  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const stroke = edgeColor(d.dominantSignal);
  const tooltipHeight = Math.max(50, 24 + d.summaryLines.length * 12);

  return (
    <g
      className="connection-edge-group connection-edge-reveal"
      style={
        {
          "--edge-opacity": d.opacity,
        } as React.CSSProperties
      }
    >
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        pointerEvents="all"
        style={{ cursor: "default" }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke,
          strokeWidth: d.thickness,
          opacity: d.opacity,
        }}
      />
      <foreignObject
        x={labelX - 95}
        y={labelY - tooltipHeight / 2}
        width={190}
        height={tooltipHeight}
        className="conn-edge-tooltip"
        style={{ overflow: "visible" }}
      >
        <div style={TOOLTIP_STYLE}>
          {d.summaryLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </foreignObject>
    </g>
  );
});
