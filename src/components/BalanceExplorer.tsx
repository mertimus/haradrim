import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { AssetBalanceChart } from "@/components/AssetBalanceChart";
import { SearchBar } from "@/components/SearchBar";
import {
  getWalletAssetBalanceHistory,
  type AssetBalanceHistoryPoint,
  type WalletAssetBalanceHistory,
  type WalletAssetBalanceHistoryResult,
} from "@/lib/backend-api";

type ViewMode = "raw" | "usd";
type SolPriceMap = Record<string, number>;

const NATIVE_SOL_ID = "native-sol";

interface RunState {
  result: WalletAssetBalanceHistoryResult | null;
  loading: boolean;
  error: string | null;
}

interface BalanceExplorerProps {
  initialAddress?: string;
}

function getBalanceAddressFromUrl(pathname = window.location.pathname): string {
  const match = pathname.match(/^\/balances\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

function createEmptyRunState(): RunState {
  return { result: null, loading: false, error: null };
}

function createLoadingRunState(): RunState {
  return { result: null, loading: true, error: null };
}

function truncAddress(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatCompact(value: number, fractionDigits = 2): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}M`;
  if (abs >= 1_000) return `${(value / 1_000).toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}K`;
  return value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function formatHeroBalance(value: number, isUsd: boolean): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return formatCompact(value, 2);
  if (isUsd || abs >= 1) return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDropdownBalance(value: number, decimals: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return formatCompact(value, 1);
  if (abs >= 1_000_000) return formatCompact(value, 1);
  const d = Math.max(0, Math.min(Number.isFinite(decimals) ? decimals : 0, 9));
  const maxFrac = abs >= 1_000 ? 2 : abs >= 1 ? Math.max(2, Math.min(4, d)) : Math.min(6, Math.max(d, 2));
  const minFrac = Math.min(abs >= 1 ? 2 : 0, maxFrac);
  return value.toLocaleString(undefined, { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac });
}

function formatSignedHero(value: number, isUsd: boolean): string {
  const abs = Math.abs(value);
  const formatted = abs >= 1_000_000
    ? formatCompact(abs, 2)
    : abs >= 1_000
      ? abs.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = isUsd ? "$" : "";
  if (value === 0) return `${prefix}${formatted}`;
  return `${value > 0 ? "+" : "\u2212"}${prefix}${formatted}`;
}

function formatDateRangeShort(asset: WalletAssetBalanceHistory): string {
  if (!asset.firstTimestamp || !asset.lastTimestamp) return "";
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short" });
  if (asset.firstTimestamp === asset.lastTimestamp) return fmt(asset.firstTimestamp);
  return `${fmt(asset.firstTimestamp)} \u2013 ${fmt(asset.lastTimestamp)}`;
}

function assetLabel(asset: WalletAssetBalanceHistory): string {
  return asset.symbol ?? asset.name ?? (asset.kind === "native" ? "SOL" : truncAddress(asset.mint ?? asset.assetId));
}

function compareAssets(a: WalletAssetBalanceHistory, b: WalletAssetBalanceHistory): number {
  if (a.kind !== b.kind) return a.kind === "native" ? -1 : 1;
  if (a.currentlyHeld !== b.currentlyHeld) return Number(b.currentlyHeld) - Number(a.currentlyHeld);
  if (a.currentBalance !== b.currentBalance) return b.currentBalance - a.currentBalance;
  return assetLabel(a).localeCompare(assetLabel(b));
}

function lookupSolPrice(prices: SolPriceMap, timestamp: number): number {
  const d = new Date(timestamp * 1000);
  for (let i = 0; i < 7; i++) {
    const key = d.toISOString().split("T")[0];
    if (prices[key] != null) return prices[key];
    d.setDate(d.getDate() - 1);
  }
  return 0;
}

let priceCache: SolPriceMap | null = null;
let priceFetchPromise: Promise<SolPriceMap | null> | null = null;

function fetchSolPrices(): Promise<SolPriceMap | null> {
  if (priceCache) return Promise.resolve(priceCache);
  if (priceFetchPromise) return priceFetchPromise;
  priceFetchPromise = fetch("/data/sol-daily-usd.json")
    .then((res) => (res.ok ? res.json() as Promise<SolPriceMap> : null))
    .then((data) => { priceCache = data; return data; })
    .catch(() => null);
  return priceFetchPromise;
}

export function BalanceExplorer({ initialAddress }: BalanceExplorerProps) {
  const [inputValue, setInputValue] = useState(initialAddress ?? "");
  const [activeAddress, setActiveAddress] = useState(initialAddress ?? "");
  const [run, setRun] = useState<RunState>(createEmptyRunState);
  const [hoverBalance, setHoverBalance] = useState<number | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState(NATIVE_SOL_ID);
  const [viewMode, setViewMode] = useState<ViewMode>("raw");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [solPrices, setSolPrices] = useState<SolPriceMap | null>(priceCache);
  const requestIdRef = useRef(0);
  const initialAddressRef = useRef(initialAddress ?? "");
  const abortControllerRef = useRef<AbortController | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (solPrices) return;
    void fetchSolPrices().then((data) => { if (data) setSolPrices(data); });
  }, [solPrices]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

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
    setHoverBalance(null);
    setSelectedAssetId(NATIVE_SOL_ID);
    setViewMode("raw");
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
    setHoverBalance(null);
    setSelectedAssetId(NATIVE_SOL_ID);
    setViewMode("raw");
    window.history[replaceUrl ? "replaceState" : "pushState"]({}, "", `/balances/${address}`);

    try {
      const result = await getWalletAssetBalanceHistory(address, { signal: controller.signal });
      if (requestId !== requestIdRef.current) return;
      setRun({ result, loading: false, error: null });
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
      if (!nextAddress) { clearState(true); return; }
      void loadHistory(nextAddress, true);
    }
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      abortPendingRequest();
    };
  }, [abortPendingRequest, clearState, loadHistory]);

  // All assets sorted: SOL first, then by balance
  const sortedAssets = useMemo(
    () => (run.result?.assets ?? []).slice().sort(compareAssets),
    [run.result],
  );

  const selectedAsset = sortedAssets.find((a) => a.assetId === selectedAssetId) ?? sortedAssets[0] ?? null;
  const isSol = selectedAsset?.kind === "native";
  const isUsd = isSol && viewMode === "usd";
  const canShowUsd = isSol && solPrices != null;

  // Chart points — raw or USD-converted
  const effectivePoints = useMemo((): AssetBalanceHistoryPoint[] => {
    if (!selectedAsset) return [];
    if (!isUsd || !solPrices) return selectedAsset.points;
    return selectedAsset.points.map((p) => {
      const price = lookupSolPrice(solPrices, p.timestamp);
      return { ...p, balance: p.balance * price, delta: p.delta * price };
    });
  }, [selectedAsset, isUsd, solPrices]);

  const currentBalance = useMemo(() => {
    if (!selectedAsset) return 0;
    if (!isUsd || !solPrices) return selectedAsset.currentBalance;
    return selectedAsset.currentBalance * lookupSolPrice(solPrices, selectedAsset.lastTimestamp ?? Math.floor(Date.now() / 1000));
  }, [selectedAsset, isUsd, solPrices]);

  const netChange = useMemo(() => {
    if (!selectedAsset) return 0;
    if (!isUsd || !solPrices) return selectedAsset.netChange;
    const endUsd = selectedAsset.currentBalance * lookupSolPrice(solPrices, selectedAsset.lastTimestamp ?? Math.floor(Date.now() / 1000));
    const startUsd = selectedAsset.startingBalance * lookupSolPrice(solPrices, selectedAsset.firstTimestamp ?? 0);
    return endUsd - startUsd;
  }, [selectedAsset, isUsd, solPrices]);

  const handleHoverPoint = useCallback((point: AssetBalanceHistoryPoint | null) => {
    setHoverBalance(point ? point.balance : null);
  }, []);

  function selectAsset(assetId: string) {
    setSelectedAssetId(assetId);
    setDropdownOpen(false);
    setHoverBalance(null);
    if (assetId !== NATIVE_SOL_ID) setViewMode("raw");
  }

  // Landing page
  if (!activeAddress && !run.loading) {
    return (
      <div className="flex flex-1 flex-col items-center overflow-auto px-4 pt-[10vh]">
        <div className="w-full max-w-2xl space-y-3 text-center">
          <h2 className="font-mono text-2xl font-bold uppercase tracking-[0.18em] text-primary text-glow-cyan">
            SOL & Stablecoin History
          </h2>
          <p className="font-mono text-[11px] leading-5 text-muted-foreground">
            Paste a wallet address to reconstruct SOL and stablecoin balance over time.
          </p>
          <div className="pt-2">
            <SearchBar
              onSearch={(address) => loadHistory(address)}
              loading={run.loading}
              defaultValue={inputValue}
              autoFocus
              enableShortcut
              submitLabel="Load"
              placeholder="WALLET ADDRESS OR .SOL DOMAIN..."
            />
          </div>
        </div>
      </div>
    );
  }

  if (run.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="animate-pulse font-mono text-sm text-muted-foreground/60">Loading</p>
      </div>
    );
  }

  if (run.error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="font-mono text-sm text-destructive/80">{run.error}</p>
          <button
            onClick={() => clearState()}
            className="mt-4 font-mono text-xs text-primary/70 underline underline-offset-4 transition-colors hover:text-primary"
          >
            Try another address
          </button>
        </div>
      </div>
    );
  }

  if (!selectedAsset) return null;

  const displayBalance = hoverBalance ?? currentBalance;
  const isHovering = hoverBalance != null;
  const unitLabel = isUsd ? "USD" : assetLabel(selectedAsset);

  return (
    <div className="flex flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col px-6 py-5">

        {/* Search bar */}
        <div className="mb-6">
          <SearchBar
            onSearch={(address) => loadHistory(address)}
            loading={run.loading}
            defaultValue={inputValue}
            submitLabel="Load"
            placeholder="WALLET ADDRESS OR .SOL DOMAIN..."
          />
        </div>

        {/* Asset selector + balance */}
        <div className="mb-5">
          {/* Dropdown */}
          <div className="relative mb-3 inline-block" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((o) => !o)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/40 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-border/70 hover:text-foreground"
            >
              {assetLabel(selectedAsset)}
              <ChevronDown className={`h-3 w-3 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {dropdownOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 max-h-[320px] min-w-[220px] overflow-y-auto rounded-lg border border-border/50 bg-background/95 py-1 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-sm">
                {sortedAssets.map((asset) => (
                  <button
                    key={asset.assetId}
                    onClick={() => selectAsset(asset.assetId)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-4 px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-primary/8 ${
                      asset.assetId === selectedAsset.assetId ? "text-primary" : "text-foreground/70"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {assetLabel(asset)}
                      {asset.currentlyHeld && (
                        <span className="inline-block h-1 w-1 rounded-full bg-primary/60" />
                      )}
                    </span>
                    <span className="tabular-nums text-muted-foreground/50">
                      {formatDropdownBalance(asset.currentBalance, asset.decimals)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Balance readout */}
          <div className="flex items-baseline gap-2">
            {isUsd && (
              <span className="font-mono text-[2rem] leading-none text-muted-foreground/30" style={{ fontWeight: 200 }}>$</span>
            )}
            <span
              className={`font-mono text-[3.2rem] leading-none tracking-tight text-foreground tabular-nums transition-opacity ${isHovering ? "opacity-70" : ""}`}
              style={{ fontWeight: 200 }}
            >
              {formatHeroBalance(displayBalance, isUsd)}
            </span>
            <span className="font-mono text-lg tracking-tight text-muted-foreground/50" style={{ fontWeight: 200 }}>
              {unitLabel}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-4">
            <span
              className={`font-mono text-xs tabular-nums ${
                netChange < 0 ? "text-accent/60" : "text-primary/50"
              }`}
            >
              {formatSignedHero(netChange, isUsd)}{!isUsd ? ` ${assetLabel(selectedAsset)}` : ""}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/30">
              {formatDateRangeShort(selectedAsset)}
            </span>
          </div>
        </div>

        {/* SOL/USD toggle — only for SOL */}
        {canShowUsd && (
          <div className="mb-4 flex items-center gap-1">
            <button
              onClick={() => { setViewMode("raw"); setHoverBalance(null); }}
              className={`cursor-pointer rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-all ${
                viewMode === "raw"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              }`}
            >
              SOL
            </button>
            <button
              onClick={() => { setViewMode("usd"); setHoverBalance(null); }}
              className={`cursor-pointer rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-all ${
                viewMode === "usd"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              }`}
            >
              USD
            </button>
          </div>
        )}

        {/* Chart */}
        <AssetBalanceChart
          points={effectivePoints}
          label={unitLabel}
          decimals={isUsd ? 2 : selectedAsset.decimals}
          strokeColor="#00d4ff"
          ariaLabel={`${assetLabel(selectedAsset)} balance history chart`}
          height={420}
          borderless
          onHoverPoint={handleHoverPoint}
        />

        <p className="mt-6 font-mono text-[10px] text-muted-foreground/30">
          All data is calculated live using Helius APIs. No indexing required.{" "}
          <a
            href="https://www.helius.dev/docs/rpc/gettransactionsforaddress"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary/40 underline underline-offset-2 transition-colors hover:text-primary/70"
          >
            Learn more
          </a>
        </p>
      </div>
    </div>
  );
}
