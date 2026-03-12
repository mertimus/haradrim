import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getStablecoinDashboard,
  type StablecoinDashboardResult,
  type StablecoinHolder,
  type StablecoinInfo,
  type YieldMarket,
} from "@/lib/backend-api";

interface RunState {
  result: StablecoinDashboardResult | null;
  loading: boolean;
  error: string | null;
}

const TICKER_COLORS: Record<string, string> = {
  USDC: "#00d4ff",
  USDT: "#4df2a3",
  PYUSD: "#0070e0",
  USDG: "#ffb800",
  CASH: "#8b5cf6",
  USD1: "#94a3b8",
  syrupUSDC: "#e8a838",
  USX: "#36d6c3",
  EURC: "#2775ca",
  USDS: "#f5a623",
  JupUSD: "#c7f284",
};
const DEFAULT_COLOR = "#6b7b8d";

function colorFor(ticker: string): string {
  return TICKER_COLORS[ticker] ?? DEFAULT_COLOR;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatAmount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Section 1: Hero ───────────────────────────────────── */

function SupplyBar({ stablecoins }: { stablecoins: StablecoinInfo[] }) {
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full">
      {stablecoins.map((sc) => (
        <div
          key={sc.ticker}
          className="h-full transition-all"
          style={{ width: `${sc.sharePct}%`, background: colorFor(sc.ticker) }}
          title={`${sc.ticker}: ${formatPct(sc.sharePct)}`}
        />
      ))}
    </div>
  );
}

function HeroSection({
  totalSupply,
  stablecoins,
  snapshotAt,
}: {
  totalSupply: number;
  stablecoins: StablecoinInfo[];
  snapshotAt: number;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Solana Stablecoin Supply
      </div>
      <div className="font-mono text-4xl font-bold tracking-tight text-foreground md:text-5xl">
        {formatUsd(totalSupply)}
      </div>

      <div className="w-full max-w-lg">
        <SupplyBar stablecoins={stablecoins} />
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {stablecoins.map((sc) => (
            <div key={sc.ticker} className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full" style={{ background: colorFor(sc.ticker) }} />
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                {sc.ticker}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground/50">
        {formatTimestamp(snapshotAt)}
      </div>
    </div>
  );
}

/* ── Section 2: Power Ranking ──────────────────────────── */

function PowerRanking({ stablecoins }: { stablecoins: StablecoinInfo[] }) {
  const sorted = [...stablecoins].sort((a, b) => b.uiAmount - a.uiAmount);
  const maxAmount = sorted[0]?.uiAmount ?? 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
          Supply Ranking
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 pb-4">
        {sorted.map((sc, i) => (
          <div key={sc.ticker} className="flex items-center gap-3">
            <span className="w-5 text-right font-mono text-[10px] text-muted-foreground">
              {i + 1}
            </span>
            <span
              className="w-20 font-mono text-[10px] font-bold uppercase"
              style={{ color: colorFor(sc.ticker) }}
            >
              {sc.ticker}
            </span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/50">
              <div
                className="absolute inset-y-0 left-0 rounded transition-all"
                style={{
                  width: `${(sc.uiAmount / maxAmount) * 100}%`,
                  background: colorFor(sc.ticker),
                  opacity: 0.25,
                }}
              />
              <div className="absolute inset-y-0 flex items-center px-2">
                <span className="font-mono text-[10px] font-bold text-foreground">
                  {formatUsd(sc.uiAmount)}
                </span>
              </div>
            </div>
            <span className="w-14 text-right font-mono text-[10px] text-muted-foreground">
              {formatPct(sc.sharePct)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ── Section 3: Holder Detail (single selectable tab) ── */

function HolderDetail({
  stablecoins,
  holdersByTicker,
}: {
  stablecoins: StablecoinInfo[];
  holdersByTicker: Record<string, { holders: StablecoinHolder[] }>;
}) {
  const [selected, setSelected] = useState(stablecoins[0]?.ticker ?? "");
  const data = holdersByTicker[selected];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
          Top Holders
        </CardTitle>
        <div className="mt-1 flex flex-wrap gap-1">
          {stablecoins.map((sc) => (
            <button
              key={sc.ticker}
              onClick={() => setSelected(sc.ticker)}
              className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors"
              style={{
                color: selected === sc.ticker ? colorFor(sc.ticker) : "#6b7b8d",
                background:
                  selected === sc.ticker
                    ? `${colorFor(sc.ticker)}14`
                    : "transparent",
              }}
            >
              {sc.ticker}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {data && data.holders.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 font-mono text-[9px]">#</TableHead>
                <TableHead className="font-mono text-[9px]">Owner</TableHead>
                <TableHead className="text-right font-mono text-[9px]">Amount</TableHead>
                <TableHead className="w-16 text-right font-mono text-[9px]">% Supply</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.holders.map((h, i) => (
                <TableRow key={h.owner}>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {i + 1}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-foreground">
                        {h.label ?? truncAddr(h.owner)}
                      </span>
                      {h.label && (
                        <span className="font-mono text-[8px] text-muted-foreground">
                          {truncAddr(h.owner)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[10px] text-foreground">
                    {formatAmount(h.uiAmount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[10px] text-muted-foreground">
                    {formatPct(h.percentage)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex items-center justify-center py-8">
            <span className="font-mono text-[10px] text-muted-foreground">
              No holder data available
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Section 4: Yield Markets ──────────────────────────── */

/* ── Section 4a: Platform Breakdown ────────────────────── */

interface PlatformAgg {
  provider: string;
  providerIcon: string;
  totalDeposits: number;
  marketCount: number;
  avgApy: number;
}

function PlatformBreakdown({ markets }: { markets: YieldMarket[] }) {
  if (markets.length === 0) return null;

  const byProvider = new Map<string, { icon: string; deposits: number; apySum: number; count: number }>();
  for (const m of markets) {
    const entry = byProvider.get(m.provider) ?? { icon: m.providerIcon, deposits: 0, apySum: 0, count: 0 };
    entry.deposits += m.totalDepositUsd;
    entry.apySum += m.depositApy;
    entry.count += 1;
    byProvider.set(m.provider, entry);
  }

  const platforms: PlatformAgg[] = [...byProvider.entries()]
    .map(([provider, e]) => ({
      provider,
      providerIcon: e.icon,
      totalDeposits: e.deposits,
      marketCount: e.count,
      avgApy: e.count > 0 ? e.apySum / e.count : 0,
    }))
    .sort((a, b) => b.totalDeposits - a.totalDeposits);

  const maxDeposits = platforms[0]?.totalDeposits ?? 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
          Platform Deposits
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 pb-4">
        {platforms.map((p, i) => (
          <div key={p.provider} className="flex items-center gap-3">
            <span className="w-5 text-right font-mono text-[10px] text-muted-foreground">
              {i + 1}
            </span>
            <div className="flex w-24 items-center gap-1.5">
              {p.providerIcon && (
                <img src={p.providerIcon} alt={p.provider} className="h-4 w-4 rounded-full" />
              )}
              <span className="truncate font-mono text-[10px] font-bold text-foreground">
                {p.provider}
              </span>
            </div>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/50">
              <div
                className="absolute inset-y-0 left-0 rounded bg-primary/25 transition-all"
                style={{ width: `${(p.totalDeposits / maxDeposits) * 100}%` }}
              />
              <div className="absolute inset-y-0 flex items-center px-2">
                <span className="font-mono text-[10px] font-bold text-foreground">
                  {formatUsd(p.totalDeposits)}
                </span>
              </div>
            </div>
            <span className="w-20 text-right font-mono text-[9px] text-muted-foreground">
              {p.marketCount} {p.marketCount === 1 ? "market" : "markets"}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ── Section 4b: Yield Markets Table ──────────────────── */

type YieldSortKey = "deposits" | "apy";
type YieldSortDir = "asc" | "desc";

function YieldMarkets({ markets }: { markets: YieldMarket[] }) {
  const [assetFilter, setAssetFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState<"ALL" | "yield" | "lending">("ALL");
  const [sortKey, setSortKey] = useState<YieldSortKey>("deposits");
  const [sortDir, setSortDir] = useState<YieldSortDir>("desc");

  if (markets.length === 0) return null;

  const tickers = [...new Set(markets.map((m) => m.ticker))];

  const filtered = markets
    .filter((m) => assetFilter === "ALL" || m.ticker === assetFilter)
    .filter((m) => typeFilter === "ALL" || m.type === typeFilter);

  const sorted = [...filtered].sort((a, b) => {
    const va = sortKey === "apy" ? a.depositApy : a.totalDepositUsd;
    const vb = sortKey === "apy" ? b.depositApy : b.totalDepositUsd;
    return sortDir === "desc" ? vb - va : va - vb;
  });

  function toggleSort(key: YieldSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const arrow = (key: YieldSortKey) =>
    sortKey === key ? (sortDir === "desc" ? " \u2193" : " \u2191") : "";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
          Yield Markets
        </CardTitle>
        {/* ── Filters: type + asset in one row ── */}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {([["ALL", "#fff"], ["yield", "#00d4ff"], ["lending", "#ffb800"]] as const).map(([value, color]) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value as "ALL" | "yield" | "lending")}
              className="cursor-pointer rounded-sm px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors"
              style={{
                color: typeFilter === value ? color : "#6b7b8d",
                background: typeFilter === value ? `${color}14` : "transparent",
              }}
            >
              {value === "ALL" ? "All" : value === "lending" ? "Lend" : "Yield"}
            </button>
          ))}
          <div className="mx-1 h-3 w-px bg-border/50" />
          {tickers.map((t) => (
            <button
              key={t}
              onClick={() => setAssetFilter(assetFilter === t ? "ALL" : t)}
              className="cursor-pointer rounded-sm px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors"
              style={{
                color: assetFilter === t ? colorFor(t) : "#6b7b8d",
                background: assetFilter === t ? `${colorFor(t)}14` : "transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="border-b-border/50">
              <TableHead className="pl-4 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                Market
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-right font-mono text-[9px] uppercase tracking-widest text-muted-foreground"
                onClick={() => toggleSort("apy")}
              >
                APY{arrow("apy")}
              </TableHead>
              <TableHead
                className="cursor-pointer select-none pr-4 text-right font-mono text-[9px] uppercase tracking-widest text-muted-foreground"
                onClick={() => toggleSort("deposits")}
              >
                TVL{arrow("deposits")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((m) => (
              <TableRow
                key={m.id}
                className="group border-b-border/30 transition-colors hover:bg-muted/30"
                style={{
                  boxShadow: `inset 2px 0 0 ${
                    m.type === "lending" ? "#ffb800" : "#00d4ff"
                  }`,
                }}
              >
                {/* ── Market identity cell ── */}
                <TableCell className="py-2.5 pl-4">
                  <div className="flex items-center gap-2.5">
                    {m.tokenIcon && (
                      <img
                        src={m.tokenIcon}
                        alt={m.ticker}
                        className="h-5 w-5 shrink-0 rounded-full"
                      />
                    )}
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {/* Row 1: market name */}
                      <div className="flex items-center gap-1.5">
                        {m.url ? (
                          <a
                            href={m.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate font-mono text-[10px] text-foreground underline decoration-muted-foreground/20 underline-offset-2 transition-colors hover:decoration-foreground"
                          >
                            {m.name}
                          </a>
                        ) : (
                          <span className="truncate font-mono text-[10px] text-foreground">
                            {m.name}
                          </span>
                        )}
                      </div>
                      {/* Row 2: provider + ticker (compact metadata line) */}
                      <div className="flex items-center gap-1">
                        {m.providerIcon && (
                          <img
                            src={m.providerIcon}
                            alt={m.provider}
                            className="h-3 w-3 rounded-full"
                          />
                        )}
                        <span className="font-mono text-[8px] text-muted-foreground">
                          {m.provider}
                        </span>
                        <span className="font-mono text-[8px] text-muted-foreground/40">
                          /
                        </span>
                        <span
                          className="font-mono text-[8px] font-bold uppercase"
                          style={{ color: colorFor(m.ticker) }}
                        >
                          {m.ticker}
                        </span>
                      </div>
                    </div>
                  </div>
                </TableCell>

                {/* ── Rates cell (APY + 30d avg + borrow, stacked) ── */}
                <TableCell className="py-2.5 text-right">
                  <div className="flex flex-col items-end gap-0.5">
                    {/* Primary: current APY */}
                    <div className="flex items-center gap-0.5">
                      <span className="font-mono text-[11px] font-bold tabular-nums text-primary">
                        {(m.depositApy * 100).toFixed(2)}%
                      </span>
                      {m.boosted && (
                        <span
                          className="text-[8px] text-amber-400"
                          title="Includes reward incentives"
                        >
                          +
                        </span>
                      )}
                    </div>
                    {/* Secondary: 30d average */}
                    {m.baseDepositApy30d != null && (
                      <span className="font-mono text-[8px] tabular-nums text-muted-foreground">
                        30d {(m.baseDepositApy30d * 100).toFixed(2)}%
                      </span>
                    )}
                    {/* Tertiary: borrow rate (lending only) */}
                    {m.type === "lending" && m.borrowApy != null && (
                      <span className="font-mono text-[8px] tabular-nums text-accent/70">
                        borrow {(m.borrowApy * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                </TableCell>

                {/* ── TVL cell ── */}
                <TableCell className="py-2.5 pr-4 text-right">
                  <span className="font-mono text-[10px] tabular-nums text-foreground">
                    {formatUsd(m.totalDepositUsd)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* ── Footer legend ── */}
        <div className="flex items-center gap-4 border-t border-border/30 px-4 py-2">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-sm bg-emerald-400/60" />
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              Yield
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-sm bg-orange-400/60" />
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              Lending
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[8px] text-amber-400">+</span>
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              Boosted
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function StablecoinDashboard() {
  const [state, setState] = useState<RunState>({
    result: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ result: null, loading: true, error: null });

    getStablecoinDashboard({ signal: controller.signal, timeoutMs: 60_000 })
      .then((result) => {
        if (!controller.signal.aborted) {
          setState({ result, loading: false, error: null });
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setState({
            result: null,
            loading: false,
            error: err?.message ?? "Failed to load dashboard",
          });
        }
      });

    return () => controller.abort();
  }, []);

  if (state.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground animate-pulse">
          Loading stablecoin data...
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-destructive">
            Error
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">
            {state.error}
          </span>
        </div>
      </div>
    );
  }

  const { result } = state;
  if (!result) return null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4">
        {/* 1. Hero */}
        <HeroSection
          totalSupply={result.totalSupply}
          stablecoins={result.stablecoins}
          snapshotAt={result.snapshotAt}
        />

        {/* 2. Power Ranking */}
        <PowerRanking stablecoins={result.stablecoins} />

        {/* 3. Holder Detail */}
        <HolderDetail
          stablecoins={result.stablecoins}
          holdersByTicker={result.holdersByTicker}
        />

        {/* 4. Platform Deposits */}
        <PlatformBreakdown markets={result.yieldMarkets} />

        {/* 5. Yield Markets */}
        <YieldMarkets markets={result.yieldMarkets} />
      </div>
    </div>
  );
}
