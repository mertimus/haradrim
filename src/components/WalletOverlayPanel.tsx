import { useState, useRef } from "react";
import { Input } from "@/components/ui/input";
import type { OverlayWallet } from "@/lib/parse-transactions";
import type { WalletIdentity } from "@/api";
import type { SharedFunder, WalletStats, WalletFilter } from "@/lib/wallet-explorer";

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function truncAddr(addr: string): string {
  return `${addr.slice(0, 3)}...${addr.slice(-3)}`;
}

// Log scale conversion: slider position (0-1) → volume threshold
function sliderToVolume(pos: number, max: number): number {
  if (pos <= 0 || max <= 0) return 0;
  return Math.pow(10, pos * Math.log10(max));
}

// Volume threshold → slider position (0-1)
function volumeToSlider(vol: number, max: number): number {
  if (vol <= 0 || max <= 0) return 0;
  return Math.log10(vol) / Math.log10(max);
}

function formatSol(value: number): string {
  if (value <= 0) return "0";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

interface WalletOverlayPanelProps {
  primaryAddress: string;
  primaryIdentity: WalletIdentity | null;
  overlayWallets: OverlayWallet[];
  walletColors: string[];
  onAdd: (address: string) => void;
  onRemove: (address: string) => void;
  onColorChange: (walletIndex: number, color: string) => void;
  disabled: boolean;
  walletFilters: Map<number, WalletFilter>;
  walletStats: WalletStats[];
  onWalletFilterChange: (walletIndex: number, filter: WalletFilter) => void;
  sharedFunders?: SharedFunder[];
  suggestedComparisons?: { address: string; reason: string }[];
}

function ColorDot({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      className="relative h-2.5 w-2.5 rounded-full flex-none cursor-pointer hover:ring-1 hover:ring-white/30 transition-shadow"
      style={{ backgroundColor: color }}
      onClick={(e) => {
        e.stopPropagation();
        inputRef.current?.click();
      }}
      title="Change color"
    >
      <input
        ref={inputRef}
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
        tabIndex={-1}
      />
    </button>
  );
}

function formatSignedSol(value: number): string {
  const prefix = value >= 0 ? "+" : "";
  const abs = Math.abs(value);
  if (abs <= 0) return "0";
  if (abs >= 1000) return `${prefix}${(value / 1000).toFixed(1)}K`;
  if (abs >= 100) return `${prefix}${value.toFixed(0)}`;
  if (abs >= 10) return `${prefix}${value.toFixed(1)}`;
  if (abs >= 1) return `${prefix}${value.toFixed(2)}`;
  if (abs >= 0.01) return `${prefix}${value.toFixed(3)}`;
  return `${prefix}${value.toFixed(4)}`;
}

function WalletFilterSliders({
  walletIndex,
  stats,
  filter,
  onChange,
}: {
  walletIndex: number;
  stats: WalletStats;
  filter: WalletFilter | undefined;
  onChange: (walletIndex: number, filter: WalletFilter) => void;
}) {
  const minVolume = filter?.minVolume ?? 0;
  const minTxCount = filter?.minTxCount ?? 0;
  const netThreshold = filter?.netThreshold ?? 0;

  const update = (patch: Partial<WalletFilter>) => {
    onChange(walletIndex, { minVolume, minTxCount, netThreshold, ...patch });
  };

  const hasNetRange = stats.minNet < 0 || stats.maxNet > 0;

  return (
    <div className="pl-5 pr-1 pb-1 space-y-1">
      {/* Volume slider */}
      {stats.maxVolume > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground">
              Vol
            </span>
            <span className="font-mono text-[9px] text-primary">
              {formatSol(minVolume)} SOL
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={volumeToSlider(minVolume, stats.maxVolume) * 1000}
            onChange={(e) => {
              const pos = Number(e.target.value) / 1000;
              const vol = pos <= 0 ? 0 : sliderToVolume(pos, stats.maxVolume);
              update({ minVolume: vol });
            }}
            className="volume-slider w-full h-1 cursor-pointer"
          />
        </div>
      )}

      {/* Tx count slider */}
      {stats.maxTxCount > 1 && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground">
              TX
            </span>
            <span className="font-mono text-[9px] text-primary">
              {minTxCount <= 0 ? "0" : Math.round(minTxCount)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={stats.maxTxCount}
            step={1}
            value={minTxCount}
            onChange={(e) => {
              update({ minTxCount: Number(e.target.value) });
            }}
            className="volume-slider w-full h-1 cursor-pointer"
          />
        </div>
      )}

      {/* Net flow slider: center = all, left = outflows only, right = inflows only */}
      {hasNetRange && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground">
              Net
            </span>
            <span className={`font-mono text-[9px] ${netThreshold > 0 ? "text-[#00ff88]" : netThreshold < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>
              {netThreshold === 0 ? "all" : `${netThreshold > 0 ? "inflow" : "outflow"} ${formatSignedSol(netThreshold)}`}
            </span>
          </div>
          <div className="relative h-3">
            {/* Track background */}
            <div className="absolute top-[5px] left-0 right-0 h-[3px] rounded bg-[#1e2a3a]" />
            {/* Center tick mark */}
            {(() => {
              const range = stats.maxNet - stats.minNet || 1;
              const centerPct = ((0 - stats.minNet) / range) * 100;
              return (
                <div
                  className="absolute top-[3px] w-px h-[7px] bg-muted-foreground/30"
                  style={{ left: `${centerPct}%` }}
                />
              );
            })()}
            {/* Active fill from center to thumb */}
            {netThreshold !== 0 && (() => {
              const range = stats.maxNet - stats.minNet || 1;
              const centerPct = ((0 - stats.minNet) / range) * 100;
              const thumbPct = ((netThreshold - stats.minNet) / range) * 100;
              const left = Math.min(centerPct, thumbPct);
              const right = 100 - Math.max(centerPct, thumbPct);
              return (
                <div
                  className="absolute top-[5px] h-[3px] rounded"
                  style={{
                    left: `${left}%`,
                    right: `${right}%`,
                    background: netThreshold > 0 ? "#00ff88" : "#ff4444",
                    opacity: 0.5,
                  }}
                />
              );
            })()}
            <input
              type="range"
              min={stats.minNet * 1000}
              max={stats.maxNet * 1000}
              step={1}
              value={netThreshold * 1000}
              onChange={(e) => {
                const v = Number(e.target.value) / 1000;
                // Snap to zero when close to center
                const range = stats.maxNet - stats.minNet;
                const snap = range * 0.02;
                update({ netThreshold: Math.abs(v) < snap ? 0 : v });
              }}
              className="volume-slider absolute inset-0 w-full h-1 cursor-pointer"
            />
          </div>
        </div>
      )}

      <div className="font-mono text-[8px] text-muted-foreground/50">
        {stats.filteredCount} of {stats.totalCount}
      </div>
    </div>
  );
}

export function WalletOverlayPanel({
  primaryAddress,
  primaryIdentity,
  overlayWallets,
  walletColors,
  onAdd,
  onRemove,
  onColorChange,
  disabled,
  walletFilters,
  walletStats,
  onWalletFilterChange,
  sharedFunders = [],
  suggestedComparisons = [],
}: WalletOverlayPanelProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!BASE58_REGEX.test(trimmed)) {
      setError("Invalid Solana address");
      return;
    }
    setError("");
    onAdd(trimmed);
    setValue("");
  }

  const primaryStats = walletStats[0];
  const primaryHasSliders = primaryStats && (primaryStats.maxVolume > 0 || primaryStats.maxTxCount > 1 || primaryStats.minNet < 0 || primaryStats.maxNet > 0);

  return (
    <div className="p-2 space-y-1">
      <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
        Compared Wallets
      </div>

      {overlayWallets.length === 0 && suggestedComparisons.length === 0 && (
        <div className="rounded border border-primary/15 bg-primary/5 px-2 py-1 font-mono text-[8px] leading-relaxed text-muted-foreground">
          Select a node or row, then use <span className="text-primary">Add to Compare</span> to reveal shared counterparties.
        </div>
      )}

      {overlayWallets.length === 0 && suggestedComparisons.length > 0 && (
        <div className="space-y-0.5">
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Suggested
          </div>
          {suggestedComparisons.map((s) => (
            <div key={s.address} className="flex items-center gap-1.5 px-1 py-0.5 rounded bg-card/50">
              <span className="font-mono text-[10px] text-foreground">{truncAddr(s.address)}</span>
              <span className="font-mono text-[8px] text-muted-foreground truncate flex-1 min-w-0">{s.reason}</span>
              <button
                onClick={() => onAdd(s.address)}
                className="font-mono text-[8px] text-primary hover:text-primary/80 transition-colors flex-none px-1 py-0.5 rounded border border-primary/20 hover:border-primary/40"
              >
                Compare
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Primary wallet (always first, not removable) */}
      {primaryAddress && (
        <div className="rounded bg-card/50">
          <div
            className={`flex items-center gap-1.5 px-1 py-0.5 ${primaryHasSliders ? "cursor-pointer hover:bg-card/80 transition-colors" : ""}`}
            onClick={() => {
              if (!primaryHasSliders) return;
              setExpandedIndex(expandedIndex === 0 ? null : 0);
            }}
          >
            {primaryHasSliders && (
              <span className="font-mono text-[8px] text-muted-foreground w-2.5 flex-none select-none">
                {expandedIndex === 0 ? "\u25BC" : "\u25B6"}
              </span>
            )}
            <ColorDot
              color={walletColors[0]}
              onChange={(c) => onColorChange(0, c)}
            />
            <span className="font-mono text-[10px] text-foreground">
              {truncAddr(primaryAddress)}
            </span>
            <span className="font-mono text-[9px] text-primary truncate flex-1 min-w-0">
              {primaryIdentity?.label ?? primaryIdentity?.name ?? ""}
            </span>
            <span className="font-mono text-[8px] text-muted-foreground/40 flex-none px-0.5">
              primary
            </span>
          </div>
          {expandedIndex === 0 && primaryStats && (
            <WalletFilterSliders
              walletIndex={0}
              stats={primaryStats}
              filter={walletFilters.get(0)}
              onChange={onWalletFilterChange}
            />
          )}
        </div>
      )}

      {/* Overlay wallets */}
      {overlayWallets.map((ow, i) => {
        const colorIdx = i + 1;
        const stats = walletStats[colorIdx];
        const hasSliders = stats && !ow.loading && !ow.error && (stats.maxVolume > 0 || stats.maxTxCount > 1 || stats.minNet < 0 || stats.maxNet > 0);
        const isExpanded = expandedIndex === colorIdx;

        return (
          <div key={ow.address} className="rounded bg-card/50">
            <div
              className={`flex items-center gap-1.5 px-1 py-0.5 ${hasSliders ? "cursor-pointer hover:bg-card/80 transition-colors" : ""}`}
              onClick={() => {
                if (!hasSliders) return;
                setExpandedIndex(isExpanded ? null : colorIdx);
              }}
            >
              {hasSliders ? (
                <span className="font-mono text-[8px] text-muted-foreground w-2.5 flex-none select-none">
                  {isExpanded ? "\u25BC" : "\u25B6"}
                </span>
              ) : (
                <span className="w-2.5 flex-none" />
              )}
              <ColorDot
                color={walletColors[colorIdx] ?? "#666"}
                onChange={(c) => onColorChange(colorIdx, c)}
              />
              <span className="font-mono text-[10px] text-foreground">
                {truncAddr(ow.address)}
              </span>
              <span className="font-mono text-[9px] text-primary truncate flex-1 min-w-0">
                {ow.loading
                  ? "Loading..."
                  : ow.error
                    ? ow.error
                    : ow.identity?.label ?? ow.identity?.name ?? ""}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(ow.address);
                }}
                className="font-mono text-[10px] text-muted-foreground hover:text-destructive transition-colors flex-none px-0.5"
              >
                x
              </button>
            </div>
            {isExpanded && stats && (
              <WalletFilterSliders
                walletIndex={colorIdx}
                stats={stats}
                filter={walletFilters.get(colorIdx)}
                onChange={onWalletFilterChange}
              />
            )}
          </div>
        );
      })}

      {/* Shared funder badge */}
      {sharedFunders.length > 0 && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-destructive/80">
            Shared Funder Detected
          </div>
          <div className="mt-0.5 font-mono text-[9px] text-foreground">
            {sharedFunders[0].funderLabel ?? truncAddr(sharedFunders[0].funderAddress)}
          </div>
          <div className="mt-0.5 font-mono text-[7px] text-muted-foreground">
            {sharedFunders.length + 1} wallets share the same funding source
          </div>
        </div>
      )}

      {/* Add overlay input */}
      {!disabled && (
        <form onSubmit={handleSubmit} className="flex gap-1">
          <div className="relative flex-1">
            <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[9px] text-primary opacity-60">
              {">"}_
            </div>
            <Input
              type="text"
              placeholder="COMPARE ANOTHER WALLET..."
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError("");
              }}
              className="h-6 border-border bg-card pl-6 font-mono text-[10px] tracking-wider text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="submit"
            className="h-6 w-6 flex-none rounded border border-border bg-card font-mono text-xs text-primary hover:bg-muted transition-colors"
          >
            +
          </button>
        </form>
      )}

      {error && (
        <p className="font-mono text-[9px] text-destructive">{error}</p>
      )}

      {!disabled && (
        <div className="font-mono text-[8px] text-muted-foreground/50">
          {overlayWallets.length + 1} wallets compared
        </div>
      )}
    </div>
  );
}
