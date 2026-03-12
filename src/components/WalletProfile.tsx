import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { WalletIdentity, WalletBalances, FundingSource } from "@/api";

interface WalletProfileProps {
  address: string;
  identity: WalletIdentity | null;
  balances: WalletBalances | null;
  funding: FundingSource | null;
  loading: boolean;
  identityLoading?: boolean;
  balancesLoading?: boolean;
  fundingLoading?: boolean;
  identityFailed?: boolean;
  balancesFailed?: boolean;
  fundingFailed?: boolean;
  counterpartyCount?: number;
  txCount?: number;
  onNavigate?: (address: string) => void;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 3)}...${addr.slice(-3)}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function fmtUsd(v: number | undefined): string {
  if (!v) return "-";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtBal(v: number): string {
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function WalletProfile({
  address,
  identity,
  balances,
  funding,
  loading,
  identityLoading = false,
  balancesLoading = false,
  fundingLoading = false,
  identityFailed = false,
  balancesFailed = false,
  fundingFailed = false,
  counterpartyCount,
  txCount,
  onNavigate,
}: WalletProfileProps) {
  if (loading) {
    return (
      <div className="relative border-t border-primary/40">
        <div className="corner-bracket">
          <div className="corner-bl" />
          <div className="corner-br" />
          <div className="flex items-center gap-6 px-3 py-2">
            <Skeleton className="profile-reveal h-4 w-32 bg-muted" style={{ animationDelay: "0s" }} />
            <Skeleton className="profile-reveal h-4 w-24 bg-muted" style={{ animationDelay: "0.1s" }} />
            <Skeleton className="profile-reveal h-4 w-20 bg-muted" style={{ animationDelay: "0.2s" }} />
            <Skeleton className="profile-reveal h-4 w-28 bg-muted" style={{ animationDelay: "0.3s" }} />
          </div>
        </div>
      </div>
    );
  }

  const solToken = balances?.tokens.find((t) => t.mint.startsWith("So1111111"));
  const solBalance = solToken?.balance ?? 0;
  const solUsd = solToken?.usdValue;

  const topTokens = (balances?.tokens ?? [])
    .filter((t) => !t.mint.startsWith("So1111111"))
    .filter((t) => t.usdValue && t.usdValue > 0.01)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
    .slice(0, 3);

  const solDomains = (identity?.tags?.filter((t) => t.endsWith(".sol")) ?? []).slice(0, 5);

  return (
    <div className="relative border-t border-primary/40">
      <div className="corner-bracket">
        <div className="corner-bl" />
        <div className="corner-br" />
        <div className="flex items-start gap-0 px-3 py-1.5 overflow-x-auto">
          {/* Identity block */}
          <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0s" }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => copyToClipboard(address)}
                className="font-mono text-[11px] text-foreground hover:text-primary"
                title="Copy address"
              >
                {truncAddr(address)}
              </button>
              {identityLoading && !identity ? (
                <Skeleton className="h-3 w-24 bg-muted" />
              ) : identityFailed ? (
                <span className="font-mono text-[11px] text-destructive/80">Unavailable</span>
              ) : identity?.label ? (
                <>
                  <span className="font-mono text-xs font-bold text-primary text-glow-cyan">
                    {identity.label}
                  </span>
                  {identity.category && (
                    <Badge variant="outline" className="border-primary/30 font-mono text-[9px] text-primary px-1 py-0">
                      {identity.category}
                    </Badge>
                  )}
                </>
              ) : (
                <span className="font-mono text-[11px] text-muted-foreground/50">Unknown</span>
              )}
            </div>
            {solDomains.length > 1 && (
              <div className="flex gap-1 mt-0.5">
                {solDomains.slice(1).map((d) => (
                  <Badge key={d} variant="outline" className="border-cyan/20 font-mono text-[8px] text-cyan px-1 py-0">
                    {d}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Funded by */}
          <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0.08s" }}>
            <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Funded by</div>
            {fundingLoading && !funding ? (
              <Skeleton className="mt-0.5 h-3 w-20 bg-muted" />
            ) : fundingFailed ? (
              <span className="font-mono text-[11px] text-destructive/80">Unavailable</span>
            ) : funding ? (
              <button
                onClick={() => onNavigate?.(funding.address)}
                className="font-mono text-[11px] text-accent hover:underline"
              >
                {funding.label ?? truncAddr(funding.address)}
              </button>
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground/50">Unknown</span>
            )}
          </div>

          {/* SOL Balance */}
          <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0.16s" }}>
            <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">SOL</div>
            {balancesLoading && !balances ? (
              <Skeleton className="mt-0.5 h-3 w-24 bg-muted" />
            ) : balancesFailed ? (
              <span className="font-mono text-[11px] text-destructive/80">Unavailable</span>
            ) : (
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-[11px] text-foreground">{fmtBal(solBalance)}</span>
                {solUsd != null && (
                  <span className="font-mono text-[9px] text-muted-foreground">{fmtUsd(solUsd)}</span>
                )}
              </div>
            )}
          </div>

          {/* Top tokens inline */}
          {!balancesFailed && topTokens.length > 0 && (
            <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0.24s" }}>
              <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Holdings</div>
              <div className="flex gap-3">
                {topTokens.map((t) => (
                  <div key={t.mint} className="font-mono text-[10px]">
                    <span className="text-foreground">{t.symbol ?? "?"}</span>
                    <span className="text-muted-foreground ml-1">{fmtUsd(t.usdValue)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Portfolio total */}
          {!balancesFailed && balances && balances.totalUsdValue > 0 && (
            <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0.32s" }}>
              <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Total</div>
              <span className="font-mono text-sm font-bold text-primary">
                {fmtUsd(balances.totalUsdValue)}
              </span>
            </div>
          )}

          {/* TX analyzed */}
          {txCount != null && txCount > 0 && (
            <div className="profile-reveal flex-none pr-4 border-r border-border mr-4" style={{ animationDelay: "0.40s" }}>
              <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">TX Analyzed</div>
              <span className="font-mono text-sm font-bold text-foreground">
                {txCount.toLocaleString()}
              </span>
            </div>
          )}

          {/* Counterparties count */}
          {counterpartyCount != null && counterpartyCount > 0 && (
            <div className="profile-reveal flex-none" style={{ animationDelay: "0.48s" }}>
              <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Counterparties</div>
              <span className="font-mono text-sm font-bold text-foreground">
                {counterpartyCount.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
