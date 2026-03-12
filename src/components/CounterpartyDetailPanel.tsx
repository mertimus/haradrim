import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export interface DetailWalletConnection {
  address: string;
  label: string;
  color: string;
  role: "Primary" | "Overlay";
}

export interface PerWalletStats {
  txCount: number;
  solSent: number;
  solReceived: number;
}

export interface SelectedCounterpartyDetail {
  address: string;
  label?: string;
  category?: string;
  accountType?: string;
  tokenName?: string;
  tokenSymbol?: string;
  txCount: number;
  solSent: number;
  solReceived: number;
  solNet: number;
  firstSeen: number;
  lastSeen: number;
  connectedWallets: DetailWalletConnection[];
  sourceStats?: Map<string, PerWalletStats>;
  connectionScore?: number;
}

export interface ForensicSignalDisplay {
  kind: string;
  score: number;
  summary: string;
}

interface CounterpartyDetailPanelProps {
  detail: SelectedCounterpartyDetail | null;
  loading: boolean;
  graphAddresses: Set<string>;
  onNavigate: (address: string) => void;
  onAddNode: (address: string) => void;
  onRemoveNode: (address: string) => void;
  onAddOverlay: (address: string) => void;
  surface?: "graph" | "flow";
  highlightCompareAction?: boolean;
  forensicSignals?: ForensicSignalDisplay[];
  forensicScore?: number;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtSol(sol: number): string {
  if (Math.abs(sol) < 0.001) return "<0.001";
  if (Math.abs(sol) >= 1000) {
    return sol.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function describeFlow(solSent: number, solReceived: number): string {
  if (solSent > solReceived * 1.25) return "Mostly outflow";
  if (solReceived > solSent * 1.25) return "Mostly inflow";
  return "Two-way flow";
}

function accountTypeLabel(detail: SelectedCounterpartyDetail): string | null {
  if (detail.accountType === "token") return detail.tokenSymbol ?? detail.tokenName ?? "Token";
  if (detail.accountType === "program") return "Program";
  if (detail.accountType === "other") return "Pgm Owned";
  if (detail.accountType === "unknown") return "Closed";
  return null;
}

const SIGNAL_COLORS: Record<string, string> = {
  shared_fee_payer: "#ffb800",
  shared_signer: "#e6a200",
  synchronized_timing: "#ffb800",
  shared_funding_ancestor: "#ffd966",
};

function signalLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function CounterpartyDetailPanel({
  detail,
  loading,
  graphAddresses,
  onNavigate,
  onAddNode,
  onRemoveNode,
  onAddOverlay,
  surface = "graph",
  highlightCompareAction = false,
  forensicSignals = [],
  forensicScore,
}: CounterpartyDetailPanelProps) {
  const detailAddress = detail?.address ?? "";
  const typeLabel = detail ? accountTypeLabel(detail) : null;
  const inGraph = detail ? graphAddresses.has(detail.address) : false;
  const recentCutoff = useMemo(
    () => Math.floor(Date.now() / 1000) - 30 * 86400,
    // Re-evaluate every minute
    [Math.floor(Date.now() / 60000)],
  );
  const showGraphActions = surface === "graph";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [detailAddress]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 1400);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopyAddress() {
    if (!detailAddress) return;
    try {
      await navigator.clipboard.writeText(detailAddress);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  if (loading && !detail) {
    return (
      <div className="scanline relative min-h-[124px] border border-border bg-card/90 p-2">
        <Skeleton className="h-4 w-36 bg-muted" />
        <Skeleton className="mt-1.5 h-3 w-28 bg-muted" />
        <div className="mt-2.5 grid grid-cols-4 gap-1.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="scanline relative min-h-[124px] border border-border bg-card/90 p-2">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Detail
        </div>
        <div className="mt-2 font-mono text-[11px] text-foreground">
          {surface === "graph"
            ? "Select a graph node or table row to inspect the relationship."
            : "Select a flow lane or table row to inspect the relationship."}
        </div>
        <div className="mt-1.5 font-mono text-[8px] leading-relaxed text-muted-foreground">
          {surface === "graph"
            ? "The panel shows direction, first and last activity, mutual wallet overlap, and compare actions."
            : "The panel shows direction, first and last activity, and the core flow stats for that relationship."}
        </div>
      </div>
    );
  }

  return (
    <div className="scanline relative max-h-[156px] overflow-y-auto border border-border bg-card/90 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
            Detail
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <div className="truncate font-mono text-[11px] font-bold text-primary">
              {detail.label ?? detail.tokenSymbol ?? truncAddr(detail.address)}
            </div>
            <div className="shrink-0 font-mono text-[8px] text-muted-foreground">
              {truncAddr(detailAddress)}
            </div>
            <button
              onClick={() => {
                void handleCopyAddress();
              }}
              className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.16em] transition-colors ${
                copyState === "copied"
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : copyState === "failed"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border bg-background/70 text-muted-foreground hover:border-primary/30 hover:text-primary"
              }`}
              title="Copy address"
            >
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy"}
            </button>
          </div>
        </div>
        <div className="flex max-w-[52%] flex-wrap justify-end gap-1">
          <Badge variant="outline" className="border-primary/30 px-1.5 py-0 font-mono text-[8px] text-primary">
            {describeFlow(detail.solSent, detail.solReceived)}
          </Badge>
          {typeLabel && (
            <Badge variant="outline" className="border-border px-1.5 py-0 font-mono text-[8px] text-muted-foreground">
              {typeLabel}
            </Badge>
          )}
          {detail.connectedWallets.length > 1 && (
            <Badge variant="outline" className="border-accent/30 px-1.5 py-0 font-mono text-[8px] text-accent">
              Mutual x{detail.connectedWallets.length}
            </Badge>
          )}
          {detail.firstSeen >= recentCutoff && (
            <Badge variant="outline" className="border-primary/30 px-1.5 py-0 font-mono text-[8px] text-primary">
              New 30d
            </Badge>
          )}
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        <div className="rounded border border-border bg-background/70 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">Tx</div>
          <div className="mt-0.5 font-mono text-[11px] font-bold text-foreground">{detail.txCount.toLocaleString()}</div>
          {detail.sourceStats && detail.sourceStats.size > 1 && (
            <div className="mt-0.5 space-y-px">
              {detail.connectedWallets.map((w) => {
                const s = detail.sourceStats?.get(w.address);
                if (!s) return null;
                return (
                  <div key={w.address} className="flex items-center gap-1 font-mono text-[7px] text-muted-foreground">
                    <span className="h-1 w-1 rounded-full flex-none" style={{ backgroundColor: w.color }} />
                    {s.txCount}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="rounded border border-border bg-background/70 px-1.5 py-1">
          <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Sent SOL</div>
          <div className="mt-0.5 font-mono text-[11px] font-bold text-destructive">{fmtSol(detail.solSent)}</div>
          {detail.sourceStats && detail.sourceStats.size > 1 && (
            <div className="mt-0.5 space-y-px">
              {detail.connectedWallets.map((w) => {
                const s = detail.sourceStats?.get(w.address);
                if (!s) return null;
                return (
                  <div key={w.address} className="flex items-center gap-1 font-mono text-[7px] text-muted-foreground">
                    <span className="h-1 w-1 rounded-full flex-none" style={{ backgroundColor: w.color }} />
                    {fmtSol(s.solSent)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="rounded border border-border bg-background/70 px-1.5 py-1">
          <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Recv SOL</div>
          <div className="mt-0.5 font-mono text-[11px] font-bold text-primary">{fmtSol(detail.solReceived)}</div>
          {detail.sourceStats && detail.sourceStats.size > 1 && (
            <div className="mt-0.5 space-y-px">
              {detail.connectedWallets.map((w) => {
                const s = detail.sourceStats?.get(w.address);
                if (!s) return null;
                return (
                  <div key={w.address} className="flex items-center gap-1 font-mono text-[7px] text-muted-foreground">
                    <span className="h-1 w-1 rounded-full flex-none" style={{ backgroundColor: w.color }} />
                    {fmtSol(s.solReceived)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="rounded border border-border bg-background/70 px-1.5 py-1">
          <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Net SOL</div>
          <div className={`mt-0.5 font-mono text-[11px] font-bold ${detail.solNet >= 0 ? "text-primary" : "text-accent"}`}>
            {detail.solNet >= 0 ? "+" : ""}
            {fmtSol(detail.solNet)}
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">First Seen</div>
          <div className="mt-0.5 font-mono text-[9px] text-foreground">{fmtDate(detail.firstSeen)}</div>
        </div>
        <div>
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">Last Seen</div>
          <div className="mt-0.5 font-mono text-[9px] text-foreground">{fmtDate(detail.lastSeen)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">Connected Wallets</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {detail.connectedWallets.map((wallet) => (
              <span
                key={wallet.address}
                className="inline-flex items-center gap-1 rounded border border-border bg-background/70 px-1 py-0.5 font-mono text-[7px] text-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: wallet.color }} />
                {wallet.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {forensicSignals.length > 0 && (
        <div className="mt-1.5">
          <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
            Connection Evidence
            {forensicScore != null && (
              <span className="ml-1.5 text-primary">{forensicScore.toFixed(1)}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {forensicSignals.map((signal) => {
              const color = SIGNAL_COLORS[signal.kind] ?? "#6b7280";
              return (
                <span
                  key={signal.kind}
                  className="inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono text-[7px]"
                  style={{
                    borderColor: `${color}40`,
                    backgroundColor: `${color}10`,
                    color,
                  }}
                  title={signal.summary}
                >
                  {signalLabel(signal.kind)}
                  <span className="opacity-60">{signal.score.toFixed(1)}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap gap-1">
        <button
          onClick={() => onNavigate(detail.address)}
          className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-primary transition-colors hover:bg-primary/20"
        >
          Navigate
        </button>
        {showGraphActions && (
          <>
            <button
              onClick={() => onAddOverlay(detail.address)}
              className={`rounded px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] transition-colors ${
                highlightCompareAction
                  ? "border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                  : "border border-border bg-background/70 text-foreground hover:border-primary/30 hover:text-primary"
              }`}
            >
              Add to Compare
            </button>
            {inGraph ? (
              <button
                onClick={() => onRemoveNode(detail.address)}
                className="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-destructive transition-colors hover:bg-destructive/20"
              >
                Remove Node
              </button>
            ) : (
              <button
                onClick={() => onAddNode(detail.address)}
                className="rounded border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-foreground transition-colors hover:border-primary/30 hover:text-primary"
              >
                Add Node
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
