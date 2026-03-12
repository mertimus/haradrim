import { useId, useState, type PointerEvent } from "react";
import type { SolBalanceHistoryPoint } from "@/lib/backend-api";

interface SolBalanceChartProps {
  points: SolBalanceHistoryPoint[];
}

interface ChartPoint extends SolBalanceHistoryPoint {
  x: number;
  y: number;
  chartIndex: number;
}

interface YTick {
  value: number;
  y: number;
}

const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_MARGIN = { top: 20, right: 20, bottom: 30, left: 68 };
const PLOT_WIDTH = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
const PLOT_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

function formatSol(value: number): string {
  if (Math.abs(value) >= 1_000) {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL`;
  }
  if (Math.abs(value) >= 1) {
    return `${value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    })} SOL`;
  }
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })} SOL`;
}

function formatSignedSol(value: number): string {
  const formatted = formatSol(Math.abs(value));
  if (value === 0) return formatted;
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return "Undated transaction";
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildLinePath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function buildAreaPath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  const line = buildLinePath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x} ${CHART_HEIGHT - CHART_MARGIN.bottom} L ${first.x} ${CHART_HEIGHT - CHART_MARGIN.bottom} Z`;
}

function buildChartGeometry(points: SolBalanceHistoryPoint[]): {
  chartPoints: ChartPoint[];
  xTickPoints: ChartPoint[];
  yTicks: YTick[];
} {
  if (points.length === 0) {
    return {
      chartPoints: [],
      xTickPoints: [],
      yTicks: [],
    };
  }

  const hasUsableTimestamps = points.some((point) => point.timestamp > 0);
  const xValues = hasUsableTimestamps
    ? points.map((point) => point.timestamp || 0)
    : points.map((_, index) => index);
  const balances = points.map((point) => point.balanceSol);
  const xMin = xValues.reduce((a, b) => Math.min(a, b), xValues[0]);
  const xMax = xValues.reduce((a, b) => Math.max(a, b), xValues[0]);
  const yMinRaw = balances.reduce((a, b) => Math.min(a, b), balances[0]);
  const yMaxRaw = balances.reduce((a, b) => Math.max(a, b), balances[0]);
  const ySpread = Math.max(yMaxRaw - yMinRaw, 0.000001);
  const yPadding = Math.max(ySpread * 0.08, Math.max(Math.abs(yMaxRaw), 1) * 0.02);
  const yMin = yMinRaw - yPadding;
  const yMax = yMaxRaw + yPadding;
  const xSpread = Math.max(xMax - xMin, 1);
  const ySpreadPadded = Math.max(yMax - yMin, 0.000001);

  const chartPoints = points.map((point, chartIndex) => {
    const xValue = hasUsableTimestamps ? point.timestamp || xMin : chartIndex;
    const x = CHART_MARGIN.left + ((xValue - xMin) / xSpread) * PLOT_WIDTH;
    const y = CHART_MARGIN.top + (1 - (point.balanceSol - yMin) / ySpreadPadded) * PLOT_HEIGHT;
    return {
      ...point,
      x,
      y,
      chartIndex,
    };
  });

  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    return {
      value: yMax - (yMax - yMin) * ratio,
      y: CHART_MARGIN.top + ratio * PLOT_HEIGHT,
    };
  });

  const xTickPoints = chartPoints.length <= 5
    ? chartPoints
    : [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => chartPoints[Math.min(chartPoints.length - 1, Math.round((chartPoints.length - 1) * ratio))])
      .filter((point, index, array) => array.findIndex((candidate) => candidate.chartIndex === point.chartIndex) === index);

  return { chartPoints, xTickPoints, yTicks };
}

export function SolBalanceChart({ points }: SolBalanceChartProps) {
  const gradientId = useId().replace(/:/g, "-");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const { chartPoints, xTickPoints, yTicks } = buildChartGeometry(points);
  const activePoint = hoverIndex != null
    ? chartPoints[hoverIndex] ?? null
    : chartPoints[chartPoints.length - 1] ?? null;
  const linePath = buildLinePath(chartPoints);
  const areaPath = buildAreaPath(chartPoints);

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (chartPoints.length === 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < chartPoints.length; index += 1) {
      const distance = Math.abs((chartPoints[index].x / CHART_WIDTH) * bounds.width - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    setHoverIndex(bestIndex);
  }

  if (chartPoints.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-xl border border-border/80 bg-background/70">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">
            No Chart Data
          </div>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            No dated SOL balance changes were returned for this address.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/90 bg-[#08111d] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.32)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary/80">
            Balance After Transaction
          </div>
          <div className="mt-1 font-mono text-xl font-semibold text-foreground">
            {activePoint ? formatSol(activePoint.balanceSol) : "0 SOL"}
          </div>
        </div>
        <div className="text-right">
          <div
            className={`font-mono text-xs ${activePoint && activePoint.deltaSol < 0 ? "text-accent/90" : "text-primary"}`}
          >
            {activePoint ? formatSignedSol(activePoint.deltaSol) : "0 SOL"}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {activePoint ? formatTimestamp(activePoint.timestamp) : ""}
          </div>
        </div>
      </div>

      <div
        className="relative"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-[320px] w-full"
          role="img"
          aria-label="SOL balance history chart"
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(0, 212, 255, 0.28)" />
              <stop offset="100%" stopColor="rgba(0, 212, 255, 0.02)" />
            </linearGradient>
          </defs>

          {yTicks.map((tick, index) => (
            <g key={`${index}:${tick.value}`}>
              <line
                x1={CHART_MARGIN.left}
                x2={CHART_WIDTH - CHART_MARGIN.right}
                y1={tick.y}
                y2={tick.y}
                stroke="rgba(107, 123, 141, 0.18)"
                strokeDasharray="4 6"
              />
              <text
                x={CHART_MARGIN.left - 12}
                y={tick.y + 4}
                textAnchor="end"
                fill="rgba(107, 123, 141, 0.92)"
                fontSize="10"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
              >
                {formatSol(tick.value).replace(" SOL", "")}
              </text>
            </g>
          ))}

          {xTickPoints.map((point) => (
            <g key={point.signature}>
              <line
                x1={point.x}
                x2={point.x}
                y1={CHART_MARGIN.top}
                y2={CHART_HEIGHT - CHART_MARGIN.bottom}
                stroke="rgba(30, 42, 58, 0.65)"
              />
              <text
                x={point.x}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fill="rgba(107, 123, 141, 0.92)"
                fontSize="10"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
              >
                {point.timestamp
                  ? new Date(point.timestamp * 1000).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })
                  : `#${point.chartIndex + 1}`}
              </text>
            </g>
          ))}

          <path d={areaPath} fill={`url(#${gradientId})`} />
          <path
            d={linePath}
            fill="none"
            stroke="#00d4ff"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {activePoint && (
            <>
              <line
                x1={activePoint.x}
                x2={activePoint.x}
                y1={CHART_MARGIN.top}
                y2={CHART_HEIGHT - CHART_MARGIN.bottom}
                stroke="rgba(255, 184, 0, 0.7)"
                strokeDasharray="4 6"
              />
              <circle cx={activePoint.x} cy={activePoint.y} r="6" fill="#ffb800" />
              <circle cx={activePoint.x} cy={activePoint.y} r="10" fill="rgba(255, 184, 0, 0.16)" />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
