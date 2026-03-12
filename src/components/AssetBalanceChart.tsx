import { useId } from "react";
import type { AssetBalanceHistoryPoint } from "@/lib/backend-api";

interface AssetBalanceChartProps {
  points: AssetBalanceHistoryPoint[];
  label?: string;
  decimals?: number;
  strokeColor?: string;
  ariaLabel?: string;
}

interface ChartPoint extends AssetBalanceHistoryPoint {
  x: number;
  y: number;
  chartIndex: number;
}

interface YTick {
  value: number;
  y: number;
}

interface XTick {
  key: string;
  x: number;
  label: string;
}

const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_MARGIN = { top: 20, right: 20, bottom: 30, left: 68 };
const PLOT_WIDTH = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
const PLOT_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
const MIN_X_TICK_GAP = 140;

function formatAssetAmount(value: number, symbol?: string, decimals = 6): string {
  const safeDecimals = Math.max(0, Math.min(decimals, 9));
  const formatted = Math.abs(value) >= 1_000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : Math.abs(value) >= 1
      ? value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.min(4, safeDecimals),
      })
      : value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.min(6, Math.max(safeDecimals, 2)),
      });

  return symbol ? `${formatted} ${symbol}` : formatted;
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

function formatXTickLabel(timestamp: number, includeYear: boolean): string {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

function buildXTicks(
  chartPoints: ChartPoint[],
  hasUsableTimestamps: boolean,
  xMin: number,
  xMax: number,
): XTick[] {
  if (chartPoints.length === 0) return [];
  if (chartPoints.length === 1) {
    return [{
      key: `tick:${chartPoints[0].chartIndex}`,
      x: chartPoints[0].x,
      label: hasUsableTimestamps
        ? formatXTickLabel(chartPoints[0].timestamp, true)
        : "#1",
    }];
  }

  const desiredTickCount = Math.max(2, Math.min(5, Math.floor(PLOT_WIDTH / 180) + 1));
  const includeYear = hasUsableTimestamps
    && new Date(xMin * 1000).getFullYear() !== new Date(xMax * 1000).getFullYear();

  const rawTicks = Array.from({ length: desiredTickCount }, (_, index) => {
    const ratio = desiredTickCount === 1 ? 0 : index / (desiredTickCount - 1);
    const x = CHART_MARGIN.left + ratio * PLOT_WIDTH;

    if (hasUsableTimestamps) {
      const timestamp = xMin + ratio * (xMax - xMin);
      return {
        key: `time:${index}:${Math.round(timestamp)}`,
        x,
        label: formatXTickLabel(timestamp, includeYear),
      };
    }

    const tickIndex = Math.round(ratio * (chartPoints.length - 1));
    return {
      key: `index:${tickIndex}`,
      x,
      label: `#${tickIndex + 1}`,
    };
  });

  const filtered = [rawTicks[0]];
  for (const tick of rawTicks.slice(1, -1)) {
    const previous = filtered[filtered.length - 1];
    if (tick.x - previous.x < MIN_X_TICK_GAP) continue;
    if (tick.label === previous.label) continue;
    filtered.push(tick);
  }

  const lastTick = rawTicks[rawTicks.length - 1];
  const previous = filtered[filtered.length - 1];
  if (lastTick.label !== previous.label && lastTick.x - previous.x >= MIN_X_TICK_GAP / 2) {
    filtered.push(lastTick);
  } else if (filtered.length === 1) {
    filtered.push(lastTick);
  }

  return filtered;
}

function buildChartGeometry(points: AssetBalanceHistoryPoint[]): {
  chartPoints: ChartPoint[];
  xTicks: XTick[];
  yTicks: YTick[];
} {
  if (points.length === 0) {
    return {
      chartPoints: [],
      xTicks: [],
      yTicks: [],
    };
  }

  const hasUsableTimestamps = points.some((point) => point.timestamp > 0);
  const xValues = hasUsableTimestamps
    ? points.map((point) => point.timestamp || 0)
    : points.map((_, index) => index);
  const balances = points.map((point) => point.balance);
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
    const y = CHART_MARGIN.top + (1 - (point.balance - yMin) / ySpreadPadded) * PLOT_HEIGHT;
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

  const xTicks = buildXTicks(chartPoints, hasUsableTimestamps, xMin, xMax);

  return { chartPoints, xTicks, yTicks };
}

export function AssetBalanceChart({
  points,
  label,
  decimals,
  strokeColor = "#00d4ff",
  ariaLabel = "Asset balance history chart",
}: AssetBalanceChartProps) {
  const gradientId = useId().replace(/:/g, "-");
  const { chartPoints, xTicks, yTicks } = buildChartGeometry(points);
  const linePath = buildLinePath(chartPoints);
  const areaPath = buildAreaPath(chartPoints);

  if (chartPoints.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-xl border border-border/80 bg-background/70">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">
            No Chart Data
          </div>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            No dated balance changes were returned for this asset.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/90 bg-[#08111d] p-4 shadow-[0_24px_64px_rgba(0,0,0,0.32)]">
      <div className="relative">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-[320px] w-full"
          role="img"
          aria-label={label ? `${label} balance history chart` : ariaLabel}
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
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
                {formatAssetAmount(tick.value, undefined, decimals)}
              </text>
            </g>
          ))}

          {xTicks.map((tick) => (
            <g key={tick.key}>
              <line
                x1={tick.x}
                x2={tick.x}
                y1={CHART_MARGIN.top}
                y2={CHART_HEIGHT - CHART_MARGIN.bottom}
                stroke="rgba(30, 42, 58, 0.65)"
              />
              <text
                x={tick.x}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fill="rgba(107, 123, 141, 0.92)"
                fontSize="10"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
              >
                {tick.label}
              </text>
            </g>
          ))}

          <path d={areaPath} fill={`url(#${gradientId})`} />
          <path
            d={linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
