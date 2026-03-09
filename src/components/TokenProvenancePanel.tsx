import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { TokenHolder } from "@/birdeye-api";
import type {
  ProvenanceSource,
  ProvenanceTrail,
  TokenPaymentRequirement,
  WalletMintProvenanceResult,
} from "@/lib/backend-api";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtDateTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAmount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (value === 0) return "0";
  return value.toPrecision(4);
}

function attributionTone(attribution: "exact" | "possible" | "unknown"): string {
  if (attribution === "exact") return "border-[#00ff88]/30 text-[#00ff88]";
  if (attribution === "possible") return "border-[#ffb800]/30 text-[#ffb800]";
  return "border-destructive/30 text-destructive";
}

function classificationLabel(classification: string): string {
  switch (classification) {
    case "purchase_or_swap":
      return "Purchase / Swap";
    case "transfer_or_airdrop":
      return "Transfer / Airdrop";
    case "programmatic_acquisition":
      return "Programmatic";
    case "balance_delta_only":
      return "Balance Delta Only";
    default:
      return "Unknown";
  }
}

function stopReasonLabel(reason?: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "exchange_or_custody":
      return "Stop: exchange or custody";
    case "non_wallet_account":
      return "Stop: non-wallet";
    case "max_depth":
      return "Stop: max depth";
    case "cycle":
      return "Stop: cycle";
    case "no_prior_inflows":
      return "No prior inflows";
    case "self_transfer":
      return "Self transfer";
    case "spend_signature_not_visible":
      return "Spend tx not visible";
    default:
      return reason.replace(/_/g, " ");
  }
}

function assetLabel(asset: {
  symbol?: string;
  name?: string;
  assetId?: string;
}) {
  return asset.symbol ?? asset.name ?? (asset.assetId ? truncAddr(asset.assetId) : "Asset");
}

function SourceNode({
  source,
  depth = 0,
}: {
  source: ProvenanceSource;
  depth?: number;
}) {
  const stopLabel = stopReasonLabel(source.stopReason);

  return (
    <div
      className="rounded border border-border bg-background/60 p-2"
      style={{ marginLeft: depth > 0 ? Math.min(depth * 10, 20) : 0 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] font-bold text-foreground">
            {source.label ?? truncAddr(source.address)}
          </div>
          <div className="font-mono text-[8px] text-muted-foreground">
            {truncAddr(source.address)} · {fmtAmount(source.uiAmount)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {source.accountType && (
            <Badge variant="outline" className="border-border px-1 py-0 font-mono text-[7px] text-muted-foreground">
              {source.accountType}
            </Badge>
          )}
          {stopLabel && (
            <Badge variant="outline" className="border-border px-1 py-0 font-mono text-[7px] text-muted-foreground">
              {stopLabel}
            </Badge>
          )}
        </div>
      </div>
      <div className="mt-1 font-mono text-[8px] text-muted-foreground">
        {fmtDateTime(source.timestamp)}
      </div>
      {source.upstream && <TrailCard trail={source.upstream} compact depth={depth + 1} />}
    </div>
  );
}

function TrailCard({
  trail,
  compact = false,
  depth = 0,
}: {
  trail: ProvenanceTrail;
  compact?: boolean;
  depth?: number;
}) {
  const stopLabel = stopReasonLabel(trail.stopReason);

  return (
    <div
      className={`rounded border ${compact ? "mt-2 border-border/70 bg-card/40" : "border-border bg-card/70"} p-2`}
      style={{ marginLeft: depth > 0 ? Math.min(depth * 10, 20) : 0 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
            {compact ? "Upstream Trail" : "Funding Trail"}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {assetLabel(trail)} · need {fmtAmount(trail.requiredUiAmount)}
          </div>
        </div>
        <Badge variant="outline" className={`px-1 py-0 font-mono text-[7px] ${attributionTone(trail.attribution)}`}>
          {trail.attribution}
        </Badge>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Balance
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(trail.balanceBeforeUiAmount)}
          </div>
        </div>
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Covered
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(trail.coveredByCandidateSourcesUiAmount)}
          </div>
        </div>
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Pooled
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(trail.pooledBalanceBeforeUiAmount)}
          </div>
        </div>
      </div>

      {stopLabel && trail.candidateSources.length === 0 && (
        <div className="mt-2 font-mono text-[8px] text-muted-foreground">
          {stopLabel}
        </div>
      )}

      {trail.candidateSources.length > 0 && (
        <div className="mt-2 space-y-2">
          {trail.candidateSources.map((source) => (
            <SourceNode
              key={`${source.address}:${source.signature}:${source.timestamp}`}
              source={source}
              depth={depth}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PaymentRequirementCard({
  requirement,
}: {
  requirement: TokenPaymentRequirement;
}) {
  return (
    <div className="rounded border border-border bg-card/70 p-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
            Payment Asset
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {assetLabel(requirement)} · {fmtAmount(requirement.uiAmount)}
          </div>
        </div>
        <Badge variant="outline" className={`px-1 py-0 font-mono text-[7px] ${attributionTone(requirement.attribution)}`}>
          {requirement.attribution}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Balance
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(requirement.balanceBeforeUiAmount)}
          </div>
        </div>
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Covered
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(requirement.coveredByCandidateSourcesUiAmount)}
          </div>
        </div>
        <div className="rounded border border-border bg-background/60 px-1.5 py-1">
          <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
            Pooled
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-foreground">
            {fmtAmount(requirement.pooledBalanceBeforeUiAmount)}
          </div>
        </div>
      </div>
      {requirement.upstream && <TrailCard trail={requirement.upstream} />}
    </div>
  );
}

interface TokenProvenancePanelProps {
  holder: TokenHolder | null;
  loading: boolean;
  result: WalletMintProvenanceResult | null;
}

export function TokenProvenancePanel({
  holder,
  loading,
  result,
}: TokenProvenancePanelProps) {
  if (loading && !result) {
    return (
      <div className="scanline relative h-[280px] overflow-y-auto border-b border-border bg-card/90 p-2">
        <Skeleton className="h-4 w-32 bg-muted" />
        <Skeleton className="mt-2 h-3 w-44 bg-muted" />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Skeleton className="h-16 w-full bg-muted" />
          <Skeleton className="h-16 w-full bg-muted" />
        </div>
        <Skeleton className="mt-3 h-24 w-full bg-muted" />
      </div>
    );
  }

  if (!holder) {
    return (
      <div className="scanline relative h-[280px] overflow-y-auto border-b border-border bg-card/90 p-2">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Provenance
        </div>
        <div className="mt-2 font-mono text-[11px] text-foreground">
          Trace a holder to inspect first acquisition, payment assets, and upstream source paths.
        </div>
        <div className="mt-1.5 font-mono text-[8px] leading-relaxed text-muted-foreground">
          Use the holder table context menu and choose Trace Provenance. The panel distinguishes exact attribution from possible or unknown pooled funding.
        </div>
      </div>
    );
  }

  return (
    <div className="scanline relative h-[280px] overflow-y-auto border-b border-border bg-card/90 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
            Provenance
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] font-bold text-primary">
            {holder.label ?? truncAddr(holder.owner)}
          </div>
          <div className="font-mono text-[8px] text-muted-foreground">
            {truncAddr(holder.owner)} · {holder.percentage.toFixed(2)}%
          </div>
        </div>
        {loading && (
          <Badge variant="outline" className="border-primary/30 px-1 py-0 font-mono text-[7px] text-primary">
            Tracing...
          </Badge>
        )}
      </div>

      {!loading && !result?.acquisition && (
        <div className="mt-3 rounded border border-border bg-background/60 p-2">
          <div className="font-mono text-[10px] text-foreground">
            No acquisition found in fetched history.
          </div>
          {result?.notes?.[0] && (
            <div className="mt-1 font-mono text-[8px] text-muted-foreground">
              {result.notes[0]}
            </div>
          )}
        </div>
      )}

      {result?.acquisition && (
        <div className="mt-3 space-y-3">
          <div className="rounded border border-border bg-card/70 p-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
                  First Acquisition
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-foreground">
                  {fmtAmount(result.acquisition.acquiredUiAmount)} {assetLabel(result.acquisition.acquisitionTransfers[0] ?? { symbol: "TOKEN" })}
                </div>
              </div>
              <Badge variant="outline" className="border-border px-1 py-0 font-mono text-[7px] text-muted-foreground">
                {classificationLabel(result.acquisition.classification)}
              </Badge>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <div className="rounded border border-border bg-background/60 px-1.5 py-1">
                <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
                  Time
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-foreground">
                  {fmtDateTime(result.acquisition.timestamp)}
                </div>
              </div>
              <div className="rounded border border-border bg-background/60 px-1.5 py-1">
                <div className="font-mono text-[7px] uppercase tracking-[0.16em] text-muted-foreground">
                  Fee
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-foreground">
                  {fmtAmount(result.acquisition.networkFeeSol)} SOL
                </div>
              </div>
            </div>
          </div>

          {result.acquisition.paymentRequirements.length > 0 && (
            <div className="space-y-2">
              {result.acquisition.paymentRequirements.map((requirement) => (
                <PaymentRequirementCard
                  key={`${requirement.assetId}:${requirement.rawAmount}`}
                  requirement={requirement}
                />
              ))}
            </div>
          )}

          {result.acquisition.acquisitionTransfers.length > 0 && (
            <div className="rounded border border-border bg-card/70 p-2">
              <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
                Asset Origin
              </div>
              <div className="mt-2 space-y-2">
                {result.acquisition.acquisitionTransfers.map((transfer) => (
                  <SourceNode
                    key={`${transfer.address}:${transfer.signature}:${transfer.timestamp}`}
                    source={transfer}
                  />
                ))}
              </div>
            </div>
          )}

          {result.notes.length > 0 && (
            <div className="rounded border border-border bg-background/60 p-2">
              <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
                Notes
              </div>
              <div className="mt-1 space-y-1">
                {result.notes.map((note) => (
                  <div key={note} className="font-mono text-[8px] leading-relaxed text-muted-foreground">
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
