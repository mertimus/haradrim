import type { SelectedCounterpartyDetail } from "@/components/CounterpartyDetailPanel";

export interface FlowTransferHistoryLeg {
  assetId: string;
  kind: "native" | "token";
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  uiAmount: number;
}

export interface FlowTransferHistoryItem {
  signature: string;
  timestamp: number;
  sent: FlowTransferHistoryLeg[];
  received: FlowTransferHistoryLeg[];
  fee: number;
  solNet: number;
  totalTransferCount: number;
  semantic: "swap" | "two-way" | "outflow" | "inflow";
  enhancedType?: string;
  enhancedDescription?: string;
  enhancedSource?: string;
  protocol?: string;
  programs?: Array<{ id: string; label: string }>;
}

interface FlowTransferHistoryPanelProps {
  detail: SelectedCounterpartyDetail | null;
  items: FlowTransferHistoryItem[];
  loading: boolean;
  parsingEnhanced?: boolean;
  parseError?: string | null;
}

function truncSignature(signature: string): string {
  return `${signature.slice(0, 6)}...${signature.slice(-6)}`;
}

function truncAsset(asset: string): string {
  return `${asset.slice(0, 4)}...${asset.slice(-4)}`;
}

function fmtAmount(amount: number): string {
  if (Math.abs(amount) < 0.001) return "<0.001";
  if (Math.abs(amount) >= 1000) {
    return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return amount.toLocaleString(undefined, {
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

function flowDescriptor(detail: SelectedCounterpartyDetail): string {
  if (detail.solReceived > detail.solSent * 1.25) return "Mostly inflow";
  if (detail.solSent > detail.solReceived * 1.25) return "Mostly outflow";
  return "Two-way flow";
}

function assetLabel(leg: FlowTransferHistoryLeg): string {
  return leg.symbol ?? leg.name ?? (leg.kind === "native" ? "SOL" : truncAsset(leg.mint ?? leg.assetId));
}

function semanticLabel(item: FlowTransferHistoryItem): string {
  switch (item.semantic) {
    case "swap":
      return "Swap-like";
    case "two-way":
      return "Two-way";
    case "inflow":
      return "Inflow";
    default:
      return "Outflow";
  }
}

function semanticTone(item: FlowTransferHistoryItem): string {
  switch (item.semantic) {
    case "swap":
      return "border-accent/30 bg-accent/10 text-accent";
    case "two-way":
      return "border-primary/30 bg-primary/10 text-primary";
    case "inflow":
      return "border-[#00ff88]/30 bg-[#00ff88]/10 text-[#00ff88]";
    default:
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

function visiblePrograms(item: FlowTransferHistoryItem): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  return (item.programs ?? []).filter((program) => {
    const normalizedLabel = program.label.trim().toLowerCase();
    if (!normalizedLabel) return false;
    if (item.protocol && normalizedLabel === item.protocol.trim().toLowerCase()) return false;
    if (seen.has(normalizedLabel)) return false;
    seen.add(normalizedLabel);
    return true;
  });
}

function AssetGroup({
  title,
  legs,
  tone,
}: {
  title: string;
  legs: FlowTransferHistoryLeg[];
  tone: "inflow" | "outflow";
}) {
  const amountClass = tone === "inflow" ? "text-[#00ff88]" : "text-destructive";

  return (
    <div className="rounded border border-border/80 bg-card/70 px-1.5 py-1.5">
      <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
      {legs.length === 0 ? (
        <div className="mt-1 font-mono text-[8px] text-muted-foreground/60">None</div>
      ) : (
        <div className="mt-1 space-y-1">
          {legs.map((leg) => (
            <div key={`${leg.assetId}:${leg.uiAmount}:${title}`} className="rounded border border-border/60 bg-background/70 px-1.5 py-1">
              <div className={`font-mono text-[9px] font-bold ${amountClass}`}>
                {fmtAmount(leg.uiAmount)} {assetLabel(leg)}
              </div>
              {leg.kind === "token" && (
                <div className="mt-0.5 font-mono text-[7px] text-muted-foreground">
                  {truncAsset(leg.mint ?? leg.assetId)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FlowTransferHistoryPanel({
  detail,
  items,
  loading,
  parsingEnhanced = false,
  parseError = null,
}: FlowTransferHistoryPanelProps) {
  if (loading && !detail) {
    return (
      <div className="h-full border-l border-border bg-card/85 p-3">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Transfer History
        </div>
        <div className="mt-3 font-mono text-[10px] text-muted-foreground">
          Loading flow history...
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="h-full border-l border-border bg-card/85 p-3">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Transfer History
        </div>
        <div className="mt-3 font-mono text-[10px] text-foreground">
          Select an inflow or outflow lane to inspect transaction-level transfer history with that counterparty.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-card/85">
      <div className="flex-none border-b border-border px-3 py-3">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Transfer History
        </div>
        <div className="mt-2 font-mono text-[12px] font-bold text-primary">
          {detail.label ?? detail.tokenSymbol ?? detail.tokenName ?? detail.address}
        </div>
        <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
          {detail.address}
        </div>
        <div className="mt-2 inline-flex rounded border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.18em] text-primary">
          {flowDescriptor(detail)}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <div className="rounded border border-border bg-background/70 px-1.5 py-1">
            <div className="font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">Tx</div>
            <div className="mt-0.5 font-mono text-[11px] font-bold text-foreground">{detail.txCount}</div>
          </div>
          <div className="rounded border border-border bg-background/70 px-1.5 py-1">
            <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Sent SOL</div>
            <div className="mt-0.5 font-mono text-[11px] font-bold text-destructive">{fmtAmount(detail.solSent)}</div>
          </div>
          <div className="rounded border border-border bg-background/70 px-1.5 py-1">
            <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Recv SOL</div>
            <div className="mt-0.5 font-mono text-[11px] font-bold text-[#00ff88]">{fmtAmount(detail.solReceived)}</div>
          </div>
          <div className="rounded border border-border bg-background/70 px-1.5 py-1">
            <div className="font-mono text-[6px] uppercase tracking-[0.14em] text-muted-foreground">Net SOL</div>
            <div className={`mt-0.5 font-mono text-[11px] font-bold ${detail.solNet >= 0 ? "text-[#00ff88]" : "text-destructive"}`}>
              {detail.solNet >= 0 ? "+" : ""}
              {fmtAmount(detail.solNet)}
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none border-b border-border px-3 py-2 font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>{items.length.toLocaleString()} transactions</span>
            {parsingEnhanced && (
              <span className="text-primary/80">Enhancing with Helius...</span>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {parseError && (
            <div className="mb-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 font-mono text-[8px] text-destructive">
              {parseError}
            </div>
          )}
          {items.length === 0 ? (
            <div className="rounded border border-border bg-background/50 px-3 py-3 font-mono text-[10px] text-muted-foreground">
              No parsed transfer events were found for this counterparty in the current view.
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => {
                const programs = visiblePrograms(item);
                return (
                  <div key={item.signature} className="rounded border border-border bg-background/60 px-2 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] font-bold text-foreground">
                        {truncSignature(item.signature)}
                      </div>
                      <div className="mt-0.5 font-mono text-[8px] text-muted-foreground">
                        {fmtDate(item.timestamp)} · {item.totalTransferCount} legs
                      </div>
                      {(item.protocol || programs.length > 0) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {item.protocol && (
                            <>
                              <span className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
                                Protocol
                              </span>
                              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.16em] text-primary">
                                {item.protocol}
                              </span>
                            </>
                          )}
                          {programs.length > 0 && (
                            <>
                              <span className="ml-1 font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
                                Programs
                              </span>
                              {programs.slice(0, 3).map((program) => (
                                <span
                                  key={program.id}
                                  className="rounded border border-border/80 bg-card/80 px-1.5 py-0.5 font-mono text-[8px] text-foreground"
                                >
                                  {program.label}
                                </span>
                              ))}
                              {programs.length > 3 && (
                                <span className="rounded border border-border/80 bg-card/80 px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground">
                                  +{programs.length - 3}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {item.enhancedDescription && (
                        <div className="mt-1 max-w-[240px] font-mono text-[8px] leading-relaxed text-muted-foreground">
                          {item.enhancedDescription}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] ${semanticTone(item)}`}>
                        {item.enhancedType ? item.enhancedType.replace(/_/g, " ") : semanticLabel(item)}
                      </div>
                      <div className={`font-mono text-[10px] font-bold ${item.solNet >= 0 ? "text-[#00ff88]" : "text-destructive"}`}>
                        {item.solNet >= 0 ? "+" : ""}
                        {fmtAmount(item.solNet)} SOL
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px] gap-1.5 font-mono text-[8px]">
                    <AssetGroup title="Sent Assets" legs={item.sent} tone="outflow" />
                    <AssetGroup title="Received Assets" legs={item.received} tone="inflow" />
                    <div className="rounded border border-border/80 bg-card/70 px-1.5 py-1.5">
                      <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">Fee</div>
                      <div className="mt-1 font-mono text-[9px] text-foreground">{fmtAmount(item.fee)} SOL</div>
                    </div>
                  </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
