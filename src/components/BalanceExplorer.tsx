import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import { AssetBalanceChart } from "@/components/AssetBalanceChart";
import { SearchBar } from "@/components/SearchBar";
import {
  Card,
  CardContent,
  CardDescription,
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
  getWalletAssetBalanceHistory,
  type WalletAssetBalanceHistory,
  type WalletAssetBalanceHistoryResult,
} from "@/lib/backend-api";

interface RunState {
  result: WalletAssetBalanceHistoryResult | null;
  loading: boolean;
  error: string | null;
}

interface BalanceExplorerProps {
  initialAddress?: string;
}

const ASSET_COLORS = ["#00d4ff", "#ffb800", "#7cc6fe", "#ffd966", "#94a3b8", "#4a9eff"];

function getBalanceAddressFromUrl(pathname = window.location.pathname): string {
  const match = pathname.match(/^\/balances\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

function createEmptyRunState(): RunState {
  return {
    result: null,
    loading: false,
    error: null,
  };
}

function createLoadingRunState(): RunState {
  return {
    result: null,
    loading: true,
    error: null,
  };
}

function truncAssetId(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatAssetAmount(value: number, asset: Pick<WalletAssetBalanceHistory, "symbol" | "decimals">): string {
  const safeDecimals = Math.max(0, Math.min(asset.decimals, 9));
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

  return asset.symbol ? `${formatted} ${asset.symbol}` : formatted;
}

function formatSignedAssetAmount(value: number, asset: Pick<WalletAssetBalanceHistory, "symbol" | "decimals">): string {
  const magnitude = formatAssetAmount(Math.abs(value), asset);
  if (value === 0) return magnitude;
  return `${value > 0 ? "+" : "-"}${magnitude}`;
}

function formatShortDate(timestamp: number | null): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateRange(asset: WalletAssetBalanceHistory): string {
  if (!asset.firstTimestamp || !asset.lastTimestamp) return "No dated transactions";
  if (asset.firstTimestamp === asset.lastTimestamp) return formatShortDate(asset.firstTimestamp);
  return `${formatShortDate(asset.firstTimestamp)} - ${formatShortDate(asset.lastTimestamp)}`;
}

function assetLabel(asset: WalletAssetBalanceHistory): string {
  return asset.symbol ?? asset.name ?? (asset.kind === "native" ? "SOL" : truncAssetId(asset.mint ?? asset.assetId));
}

function assetSubtitle(asset: WalletAssetBalanceHistory): string {
  if (asset.kind === "native") return "Native SOL";
  if (asset.name && asset.symbol && asset.name !== asset.symbol) {
    return `${asset.name} · ${truncAssetId(asset.mint ?? asset.assetId)}`;
  }
  if (asset.name) return `${asset.name}`;
  return truncAssetId(asset.mint ?? asset.assetId);
}

function assetColor(assetId: string): string {
  let hash = 0;
  for (let index = 0; index < assetId.length; index += 1) {
    hash = (hash * 31 + assetId.charCodeAt(index)) >>> 0;
  }
  return ASSET_COLORS[hash % ASSET_COLORS.length];
}

function compareTableAssets(a: WalletAssetBalanceHistory, b: WalletAssetBalanceHistory): number {
  if (a.currentlyHeld !== b.currentlyHeld) return Number(b.currentlyHeld) - Number(a.currentlyHeld);
  if (a.currentBalance !== b.currentBalance) return b.currentBalance - a.currentBalance;
  if (a.pointCount !== b.pointCount) return b.pointCount - a.pointCount;
  return assetLabel(a).localeCompare(assetLabel(b));
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-background/60 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl text-foreground">{value}</div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function HoldingStatusPill({ asset }: { asset: WalletAssetBalanceHistory }) {
  return (
    <div className={`inline-flex rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] ${
      asset.currentlyHeld
        ? "border-primary/20 bg-primary/8 text-primary"
        : "border-border/80 bg-background/70 text-muted-foreground"
    }`}
    >
      {asset.currentlyHeld ? "Current" : "Former"}
    </div>
  );
}

function SolHeroCard({
  asset,
}: {
  asset: WalletAssetBalanceHistory;
}) {
  return (
    <Card className="border-border/90 bg-card/70 py-5">
      <CardContent className="px-4 pt-0">
        <div className="grid gap-3 md:grid-cols-4">
          <SummaryMetric
            label="Current Balance"
            value={formatAssetAmount(asset.currentBalance, asset)}
            detail="Present wallet SOL balance"
          />
          <SummaryMetric
            label="Net Change"
            value={formatSignedAssetAmount(asset.netChange, asset)}
            detail={`Started at ${formatAssetAmount(asset.startingBalance, asset)}`}
          />
          <SummaryMetric
            label="Observed Range"
            value={`${formatAssetAmount(asset.minBalance, asset)} - ${formatAssetAmount(asset.maxBalance, asset)}`}
            detail={asset.downsampled ? "Downsampled chart output" : "Full returned history"}
          />
          <SummaryMetric
            label="Activity"
            value={asset.pointCount.toLocaleString()}
            detail={formatDateRange(asset)}
          />
        </div>

        <div className="mt-4">
          <AssetBalanceChart
            points={asset.points}
            label="SOL"
            decimals={asset.decimals}
            strokeColor={assetColor(asset.assetId)}
            ariaLabel="SOL balance history chart"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function HoldingsTable({ assets }: { assets: WalletAssetBalanceHistory[] }) {
  if (assets.length === 0) return null;

  return (
    <Card className="border-border/90 bg-card/70 py-4">
      <CardHeader className="gap-2 px-4 pb-0">
        <CardDescription className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary/80">
          Holdings Table
        </CardDescription>
        <CardTitle className="font-mono text-xl text-foreground">
          Token holdings and former positions
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          Current tokens stay above former tokens. SOL is excluded and remains the hero chart.
        </p>
      </CardHeader>

      <CardContent className="px-4 pt-0">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="border-border hover:bg-transparent [&>th]:px-2 [&>th]:py-1.5">
              <TableHead className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Asset</TableHead>
              <TableHead className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Status</TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Current</TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Net</TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Range</TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Activity</TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Last Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assets.map((asset) => (
              <TableRow
                key={asset.assetId}
                className="table-row-reveal border-border [&>td]:px-2 [&>td]:py-2"
              >
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="font-mono text-[11px] text-foreground">{assetLabel(asset)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{assetSubtitle(asset)}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <HoldingStatusPill asset={asset} />
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] text-foreground tabular-nums">
                  {formatAssetAmount(asset.currentBalance, asset)}
                </TableCell>
                <TableCell className={`text-right font-mono text-[11px] tabular-nums ${
                  asset.netChange < 0 ? "text-accent/90" : "text-primary"
                }`}
                >
                  {formatSignedAssetAmount(asset.netChange, asset)}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                  {formatAssetAmount(asset.minBalance, asset)} - {formatAssetAmount(asset.maxBalance, asset)}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] text-foreground tabular-nums">
                  {asset.pointCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                  {formatShortDate(asset.lastTimestamp)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function BalanceExplorer({ initialAddress }: BalanceExplorerProps) {
  const [inputValue, setInputValue] = useState(initialAddress ?? "");
  const [activeAddress, setActiveAddress] = useState(initialAddress ?? "");
  const [run, setRun] = useState<RunState>(createEmptyRunState);
  const requestIdRef = useRef(0);
  const initialAddressRef = useRef(initialAddress ?? "");
  const abortControllerRef = useRef<AbortController | null>(null);

  const abortPendingRequest = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const clearState = useCallback((replaceUrl = false) => {
    abortPendingRequest();
    requestIdRef.current += 1;
    setInputValue("");
    setActiveAddress("");
    setRun(createEmptyRunState());
    window.history[replaceUrl ? "replaceState" : "pushState"]({}, "", "/balances");
  }, [abortPendingRequest]);

  const loadHistory = useCallback(async (address: string, replaceUrl = false) => {
    abortPendingRequest();
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setInputValue(address);
    setActiveAddress(address);
    setRun(createLoadingRunState());
    window.history[replaceUrl ? "replaceState" : "pushState"]({}, "", `/balances/${address}`);

    try {
      const result = await getWalletAssetBalanceHistory(address, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;

      setRun({
        result,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (requestId !== requestIdRef.current || controller.signal.aborted) return;

      setRun({
        result: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load wallet asset balance history",
      });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [abortPendingRequest]);

  useEffect(() => {
    if (!initialAddressRef.current) return;
    void loadHistory(initialAddressRef.current, true);
  }, [loadHistory]);

  useEffect(() => {
    function handlePopState() {
      const nextAddress = getBalanceAddressFromUrl();
      if (!nextAddress) {
        clearState(true);
        return;
      }

      void loadHistory(nextAddress, true);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      abortPendingRequest();
    };
  }, [abortPendingRequest, clearState, loadHistory]);

  const solAsset = run.result?.assets.find((asset) => asset.kind === "native") ?? null;
  const tableAssets = useMemo(
    () => (run.result?.assets ?? [])
      .filter((asset) => asset.kind !== "native")
      .slice()
      .sort(compareTableAssets),
    [run.result],
  );
  const currentTokenCount = tableAssets.filter((asset) => asset.currentlyHeld).length;
  const formerTokenCount = tableAssets.length - currentTokenCount;

  const benchmarkDetail = useMemo(() => {
    if (!run.result) return null;
    return {
      assetCount: tableAssets.length.toLocaleString(),
      txCount: run.result.txCount.toLocaleString(),
      currentAssetCount: currentTokenCount.toLocaleString(),
      formerAssetCount: formerTokenCount.toLocaleString(),
    };
  }, [currentTokenCount, formerTokenCount, run.result, tableAssets.length]);

  if (!activeAddress && !run.loading) {
    return (
      <div className="flex flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
          <section className="corner-bracket relative overflow-hidden rounded-3xl border border-border/90 bg-[radial-gradient(circle_at_top,_rgba(0,212,255,0.06),_transparent_44%),linear-gradient(135deg,rgba(13,19,33,0.98),rgba(9,15,28,0.95))] p-6">
            <span className="corner-bl" />
            <span className="corner-br" />
            <div className="max-w-4xl">
              <div className="font-mono text-[10px] uppercase tracking-[0.34em] text-primary/80">
                Asset History
              </div>
              <h2 className="mt-3 font-mono text-3xl font-semibold text-foreground">
                Reconstruct every asset this wallet holds or has ever held.
              </h2>
              <p className="mt-3 max-w-3xl font-mono text-sm leading-6 text-muted-foreground">
                Enter one wallet address and Haradrim reconstructs
                balance-over-time chart for SOL and every token mint observed in the wallet&apos;s
                historical balance changes.
              </p>
            </div>

            <div className="mt-6 max-w-3xl">
              <SearchBar
                onSearch={(address) => loadHistory(address)}
                loading={run.loading}
                defaultValue={inputValue}
                autoFocus
                enableShortcut
                submitLabel="Load Asset History"
                placeholder="PASTE WALLET ADDRESS OR .SOL DOMAIN..."
              />
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <SummaryMetric
                label="Coverage"
                value="SOL + Tokens"
                detail="Native SOL hero chart and token history table"
              />
              <SummaryMetric
                label="History"
                value="All Assets"
                detail="SOL hero chart plus token holdings table"
              />
              <SummaryMetric
                label="Layout"
                value="SOL First"
                detail="SOL chart on top, holdings table below"
              />
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4">
        <Card className="gap-4 border-border/90 bg-card/80 py-4">
          <CardHeader className="gap-3 px-4 pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardDescription className="font-mono text-[10px] uppercase tracking-[0.28em] text-primary/80">
                  Asset History
                </CardDescription>
                <CardTitle className="mt-1 font-mono text-xl text-foreground">
                  {activeAddress || "GTFA asset benchmark"}
                </CardTitle>
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  SOL first, tokens below.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => clearState()}
                  className="inline-flex cursor-pointer items-center gap-2 rounded border border-border/80 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  New Address
                </button>
                {activeAddress && (
                  <button
                    onClick={() => void loadHistory(activeAddress, true)}
                    disabled={run.loading}
                    className="inline-flex items-center gap-2 rounded border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-primary transition-colors hover:bg-primary/16 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <RefreshCcw className={`h-3.5 w-3.5 ${run.loading ? "animate-spin" : ""}`} />
                    Rerun
                  </button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pt-0">
            <SearchBar
              onSearch={(address) => loadHistory(address)}
              loading={run.loading}
              defaultValue={inputValue}
              submitLabel="Load Asset History"
              placeholder="PASTE WALLET ADDRESS OR .SOL DOMAIN..."
            />
          </CardContent>
        </Card>

        {run.error && (
          <Card className="border-destructive/30 bg-destructive/6 py-4">
            <CardContent className="px-4 pt-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-destructive/90">
                Request Failed
              </div>
              <p className="mt-2 font-mono text-sm text-muted-foreground">{run.error}</p>
            </CardContent>
          </Card>
        )}

        {solAsset && <SolHeroCard asset={solAsset} />}

        <Card className="border-border/90 bg-card/70 py-4">
          <CardContent className="px-4 pt-0">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <SummaryMetric
                label="TX Scanned"
                value={benchmarkDetail?.txCount ?? "--"}
                detail="Wallet transactions returned by GTFA"
              />
              <SummaryMetric
                label="Token Histories"
                value={benchmarkDetail?.assetCount ?? "--"}
                detail="Token mints excluding SOL"
              />
              <SummaryMetric
                label="Current Tokens"
                value={benchmarkDetail?.currentAssetCount ?? "--"}
                detail="Tokens with non-zero current balance"
              />
              <SummaryMetric
                label="Former Tokens"
                value={benchmarkDetail?.formerAssetCount ?? "--"}
                detail="Historical token positions now at zero"
              />
            </div>
          </CardContent>
        </Card>

        <HoldingsTable assets={tableAssets} />
      </div>
    </div>
  );
}
