import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { getTokenOverview, getTrendingTokens, searchTokens } from "@/birdeye-api";
import type { TokenOverview, TokenHolder, TrendingToken, TokenSearchResult } from "@/birdeye-api";
import { getBatchIdentity, getBatchSolDomains, getBatchFunding } from "@/api";
import type { FundingSource } from "@/api";
import {
  getTokenHolderSnapshot,
  type TokenForensicsReport,
} from "@/lib/backend-api";
import { buildHolderGraphData } from "@/lib/parse-holders";
import { HolderGraph } from "@/components/HolderGraph";
import { HolderTable } from "@/components/HolderTable";
import { TokenForensicsPanel } from "@/components/TokenForensicsPanel";

interface TokenExplorerProps {
  initialAddress?: string;
  onRouteAddressChange?: (address: string) => void;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function getTokenFromUrl(): string {
  const match = window.location.pathname.match(/^\/token\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

const GRAPH_TOP_N = 33;
const TABLE_HOLDER_LIMIT = 50;

function enrichHolders(
  holders: TokenHolder[],
  identityMap: Map<string, { name?: string; category?: string }>,
  snsMap: Map<string, string>,
): TokenHolder[] {
  return holders.map((holder) => {
    const identity = identityMap.get(holder.owner);
    const sns = snsMap.get(holder.owner);
    const label = identity?.name ?? sns ?? holder.label;
    const enriched = label ? { ...holder, label } : { ...holder };
    if (identity?.category) enriched.identityCategory = identity.category;
    return enriched;
  });
}

export function TokenExplorer({
  initialAddress = "",
  onRouteAddressChange,
}: TokenExplorerProps) {
  const [tokenAddress, setTokenAddress] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<TokenOverview | null>(null);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [layoutKey, setLayoutKey] = useState(0);
  const [showForensics, setShowForensics] = useState(false);
  const [forensicsLoading, setForensicsLoading] = useState(false);
  const [forensicsError, setForensicsError] = useState<string | null>(null);
  const [forensicsResult, setForensicsResult] = useState<TokenForensicsReport | null>(null);
  const [fundingMap, setFundingMap] = useState<Map<string, FundingSource>>(new Map());
  const [selectedForensicsClusterId, setSelectedForensicsClusterId] = useState<number | null>(null);
  const [trendingTokens, setTrendingTokens] = useState<TrendingToken[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<TokenSearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzeRequestIdRef = useRef(0);
  const graphWrapperRef = useRef<HTMLDivElement>(null);

  const graphHolders = useMemo(
    () => holders.slice(0, GRAPH_TOP_N),
    [holders],
  );
  const highlightedForensicsAddresses = useMemo(() => {
    if (!showForensics || !forensicsResult || selectedForensicsClusterId == null) return null;
    const cluster = forensicsResult.clusters.find((entry) => entry.id === selectedForensicsClusterId);
    return cluster ? new Set(cluster.members) : null;
  }, [forensicsResult, selectedForensicsClusterId, showForensics]);

  useEffect(() => {
    if (graphHolders.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const graphData = buildHolderGraphData(
      graphHolders,
      overview,
      showForensics && forensicsResult
        ? {
            mode: "forensics",
            forensicEdges: forensicsResult.edges,
            forensicClusters: forensicsResult.clusters,
            analysisScope: new Set(forensicsResult.scopeAddresses),
            holderCountOverride: holders.length,
          }
        : {
            holderCountOverride: holders.length,
          },
    );
    const graphNodes = graphData.nodes;
    setNodes(graphNodes);
    setEdges(graphData.edges);
    setLayoutKey((current) => current + 1);
  }, [graphHolders, holders.length, overview, showForensics, forensicsResult]);

  const resetState = useCallback(() => {
    analyzeRequestIdRef.current += 1;
    setTokenAddress("");
    setInputValue("");
    setLoading(false);
    setError(null);
    setOverview(null);
    setHolders([]);
    setNodes([]);
    setEdges([]);
    setLayoutKey(0);
    setShowForensics(false);
    setForensicsLoading(false);
    setForensicsError(null);
    setForensicsResult(null);
    setSelectedForensicsClusterId(null);
    setFundingMap(new Map());
    onRouteAddressChange?.("");
  }, [onRouteAddressChange]);

  const analyzeToken = useCallback(async (address: string) => {
    const trimmed = address.trim();
    if (!trimmed) return;

    const requestId = ++analyzeRequestIdRef.current;
    setTokenAddress(trimmed);
    setInputValue(trimmed);
    setLoading(true);
    setError(null);
    setOverview(null);
    setHolders([]);
    setNodes([]);
    setEdges([]);
    setShowForensics(false);
    setForensicsLoading(false);
    setForensicsError(null);
    setForensicsResult(null);
    setSelectedForensicsClusterId(null);
    setFundingMap(new Map());
    window.history.pushState({}, "", `/token/${trimmed}`);
    onRouteAddressChange?.(trimmed);

    try {
      // Phase 1: fire overview and snapshot in parallel.
      // Overview is fast (~200ms) — render it as soon as it arrives
      // so the header bar populates while holders are still loading.
      const overviewPromise = getTokenOverview(trimmed);
      const snapshotPromise = getTokenHolderSnapshot(trimmed, { limit: TABLE_HOLDER_LIMIT });

      overviewPromise.then((result) => {
        if (requestId !== analyzeRequestIdRef.current) return;
        setOverview(result);
      }).catch(() => {});

      const snapshotResult = await snapshotPromise;
      if (requestId !== analyzeRequestIdRef.current) return;

      const baseHolders = snapshotResult.holders;
      if (baseHolders.length === 0) {
        const resolvedOverview = await overviewPromise.catch(() => null);
        if (requestId !== analyzeRequestIdRef.current) return;
        if ((resolvedOverview?.holder ?? 0) > 0) {
          throw new Error("Token holder fetch returned no data for a token with holders.");
        }
        if (!resolvedOverview) {
          throw new Error("Unable to load token data. Check that the backend is running and the mint address is valid.");
        }
      }

      // Phase 2: render holders immediately with whatever labels
      // the backend already provided (program labels, account types).
      // Graph + table become interactive while identity enrichment runs.
      setHolders(baseHolders);
      setLoading(false);

      // Ensure overview is resolved before moving on.
      const resolvedOverview = await overviewPromise.catch(() => null);
      if (requestId !== analyzeRequestIdRef.current) return;
      if (resolvedOverview) setOverview(resolvedOverview);

      // Phase 3: enrich labels + funding in the background.
      // Each updates the UI independently as it resolves.
      if (baseHolders.length > 0) {
        const ownerAddresses = baseHolders.map((holder) => holder.owner);
        const snsCandidateAddresses = baseHolders
          .slice(0, GRAPH_TOP_N)
          .map((holder) => holder.owner);

        // Labels: identity + SNS resolve together (both fast)
        Promise.allSettled([
          getBatchIdentity(ownerAddresses),
          getBatchSolDomains(snsCandidateAddresses),
        ]).then(([identityResult, snsResult]) => {
          if (requestId !== analyzeRequestIdRef.current) return;
          const identityMap =
            identityResult.status === "fulfilled"
              ? identityResult.value
              : new Map<string, { name?: string }>();
          const snsMap =
            snsResult.status === "fulfilled"
              ? snsResult.value
              : new Map<string, string>();
          setHolders(enrichHolders(baseHolders, identityMap, snsMap));
        });

        // Funding: resolves independently (slower, many individual calls)
        getBatchFunding(ownerAddresses).then((result) => {
          if (requestId !== analyzeRequestIdRef.current) return;
          setFundingMap(result);
        }).catch(() => {});
      }
    } catch (error) {
      if (requestId !== analyzeRequestIdRef.current) return;
      setOverview(null);
      setHolders([]);
      setNodes([]);
      setEdges([]);
      setLoading(false);
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load token data.",
      );
    }
  }, [onRouteAddressChange]);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    setShowSuggestions(false);
    void analyzeToken(inputValue);
  }, [analyzeToken, inputValue]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.trim().length < 3) {
      setSearchResults([]);
      setShowSuggestions(false);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      searchTokens(value.trim()).then((results) => {
        setSearchResults(results);
        setShowSuggestions(results.length > 0);
      }).catch(() => {});
    }, 300);
  }, []);

  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  const handleSelectSuggestion = useCallback((address: string) => {
    setShowSuggestions(false);
    setSearchResults([]);
    void analyzeToken(address);
  }, [analyzeToken]);

  const handleBack = useCallback(() => {
    resetState();
    window.history.pushState({}, "", "/tokens");
  }, [resetState]);

  useEffect(() => {
    const token = getTokenFromUrl() || initialAddress.trim();
    if (token) {
      void analyzeToken(token);
    }
  }, [analyzeToken, initialAddress]);

  useEffect(() => {
    const onPopState = () => {
      const token = getTokenFromUrl();
      if (token) {
        void analyzeToken(token);
      } else {
        resetState();
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [analyzeToken, resetState]);

  useEffect(() => {
    setTrendingLoading(true);
    getTrendingTokens()
      .then(setTrendingTokens)
      .catch(() => {})
      .finally(() => setTrendingLoading(false));
  }, []);

  const handleHoverAddress = useCallback((address: string | null) => {
    const container = graphWrapperRef.current;
    if (!container) return;

    const previous = container.querySelector(".react-flow__node.node-highlighted");
    if (previous) previous.classList.remove("node-highlighted");

    if (!address) return;
    const next = container.querySelector(
      `.react-flow__node[data-id="${CSS.escape(address)}"]`,
    );
    if (next) next.classList.add("node-highlighted");
  }, []);

  const warningLines = useMemo(() => {
    if (!showForensics || !forensicsResult) return [];
    return [...new Set(forensicsResult.warnings)];
  }, [forensicsResult, showForensics]);

  const concentrationStats = useMemo(() => {
    if (holders.length === 0) return null;
    const top5 = holders.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
    return { top5, top10 };
  }, [holders]);

  if (!tokenAddress) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <h2 className="font-mono text-lg font-bold tracking-wider text-primary text-glow-cyan">
            TOKEN HOLDERS
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Graph + Table
          </p>
        </div>

        <form onSubmit={handleSubmit} className="w-full max-w-md">
          <div className="relative">
            <input
              type="text"
              value={inputValue}
              onChange={(event) => handleInputChange(event.target.value)}
              onFocus={() => { if (searchResults.length > 0) setShowSuggestions(true); }}
              onBlur={() => { setTimeout(() => setShowSuggestions(false), 150); }}
              placeholder="Search by name or paste address..."
              autoComplete="off"
              className="w-full rounded border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
            />
            <button
              type="submit"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
            >
              Load
            </button>
            {showSuggestions && searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded border border-border bg-card shadow-lg overflow-hidden">
                {searchResults.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectSuggestion(t.address)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted cursor-pointer"
                  >
                    {t.logoURI ? (
                      <img
                        src={t.logoURI}
                        alt=""
                        className="h-5 w-5 flex-shrink-0 rounded-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <div className="h-5 w-5 flex-shrink-0 rounded-full bg-muted" />
                    )}
                    <span className="font-mono text-[11px] font-bold text-foreground">
                      {t.symbol}
                    </span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {t.name}
                    </span>
                    <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                      {t.price > 0 && (
                        <span className="font-mono text-[9px] text-foreground">
                          {t.price >= 0.01 ? `$${t.price.toFixed(2)}` : `$${t.price.toExponential(1)}`}
                        </span>
                      )}
                      {t.marketCap > 0 && (
                        <span className="font-mono text-[9px] text-muted-foreground/50">
                          {fmtUsd(t.marketCap)}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>

        {trendingLoading && trendingTokens.length === 0 && (
          <p className="font-mono text-[10px] text-muted-foreground/50 animate-pulse">
            Loading trending tokens...
          </p>
        )}

        {trendingTokens.length > 0 && (
          <div className="w-full max-w-2xl">
            <p className="mb-2 text-center font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/60">
              Trending on Solana
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {trendingTokens.map((t) => (
                <button
                  key={t.address}
                  onClick={() => void analyzeToken(t.address)}
                  className="flex flex-col items-center gap-1 rounded border border-border bg-card/60 px-2 py-2 transition-colors hover:border-primary/30 hover:bg-card cursor-pointer"
                >
                  {t.logoURI ? (
                    <img
                      src={t.logoURI}
                      alt=""
                      className="h-6 w-6 rounded-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-muted" />
                  )}
                  <span className="font-mono text-[10px] font-bold text-foreground truncate max-w-full">
                    {t.symbol}
                  </span>
                  <span className="font-mono text-[8px] text-muted-foreground truncate max-w-full">
                    {t.name}
                  </span>
                  {t.volume24hUSD > 0 && (
                    <span className="font-mono text-[8px] text-primary/60">
                      {fmtUsd(t.volume24hUSD)} 24h
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-4 border-b border-border px-3 py-2">
        <button
          onClick={handleBack}
          className="font-mono text-[9px] text-muted-foreground transition-colors hover:text-primary"
        >
          ← Back
        </button>
        <div className="h-3 w-px bg-border" />
        <div className="flex min-w-0 items-center gap-2">
          {overview?.image && (
            <img
              src={overview.image}
              alt=""
              className="h-5 w-5 rounded-full object-cover"
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <span className="font-mono text-xs font-bold text-primary">
            {overview?.symbol ?? truncAddr(tokenAddress)}
          </span>
          {overview?.name && (
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {overview.name}
            </span>
          )}
        </div>
        {overview && (
          <>
            <div className="h-3 w-px bg-border" />
            <span className="font-mono text-[10px] text-foreground">
              {overview.price >= 0.01
                ? `$${overview.price.toFixed(2)}`
                : overview.price >= 0.0001
                  ? `$${overview.price.toFixed(6)}`
                  : `$${overview.price.toExponential(2)}`}
            </span>
            {overview.priceChange1h !== 0 && (
              <span
                className="font-mono text-[9px]"
                style={{ color: overview.priceChange1h >= 0 ? "#22c55e" : "#ef4444" }}
              >
                {overview.priceChange1h >= 0 ? "+" : ""}
                {overview.priceChange1h.toFixed(1)}% 1h
              </span>
            )}
            {overview.priceChange24h !== 0 && (
              <span
                className="font-mono text-[9px]"
                style={{ color: overview.priceChange24h >= 0 ? "#22c55e" : "#ef4444" }}
              >
                {overview.priceChange24h >= 0 ? "+" : ""}
                {overview.priceChange24h.toFixed(1)}% 24h
              </span>
            )}
            <div className="h-3 w-px bg-border" />
            <span className="font-mono text-[9px] text-muted-foreground">
              MCap {fmtUsd(overview.marketCap)}
            </span>
            {overview.liquidity > 0 && (
              <span className="font-mono text-[9px] text-muted-foreground">
                Liq {fmtUsd(overview.liquidity)}
              </span>
            )}
            {overview.volume24h > 0 && (
              <span className="font-mono text-[9px] text-muted-foreground">
                Vol {fmtUsd(overview.volume24h)}
              </span>
            )}
          </>
        )}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          {holders.length.toLocaleString()} holders
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          ref={graphWrapperRef}
          className="flex flex-1 flex-col overflow-hidden"
        >
          {error && !loading && (
            <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="font-mono text-[10px] text-destructive">
                {error}
              </p>
            </div>
          )}
          {!error && forensicsError && (
            <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="font-mono text-[10px] text-destructive">
                {forensicsError}
              </p>
            </div>
          )}
          {warningLines.length > 0 && (
            <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-2">
              {warningLines.map((warning) => (
                <p
                  key={warning}
                  className="font-mono text-[10px] text-amber-300"
                >
                  {warning}
                </p>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <HolderGraph
              key={layoutKey}
              nodes={nodes}
              edges={edges}
              loading={loading}
              forensicClusters={forensicsResult?.clusters ?? []}
              showForensics={showForensics}
              selectedForensicsClusterId={selectedForensicsClusterId}
              onSelectForensicsCluster={setSelectedForensicsClusterId}
            />
          </div>
        </div>

        <div className="flex w-[500px] flex-none border-l border-border overflow-hidden">
          <div className="flex h-full w-full flex-col overflow-hidden">
            <TokenForensicsPanel
              report={showForensics ? forensicsResult : null}
              loading={showForensics && forensicsLoading}
              error={showForensics ? forensicsError : null}
              selectedClusterId={selectedForensicsClusterId}
              onSelectCluster={setSelectedForensicsClusterId}
            />
            <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
              <span className="font-mono text-[9px] text-muted-foreground">
                <span className="text-foreground">{(overview?.holder ?? holders.length).toLocaleString()}</span> holders
              </span>
              {concentrationStats && (
                <>
                  <div className="h-2.5 w-px bg-border" />
                  <span className="font-mono text-[9px] text-muted-foreground">
                    Top 10 own{" "}
                    <span className="text-primary">{concentrationStats.top10.toFixed(1)}%</span>
                  </span>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <HolderTable
                holders={holders}
                loading={loading}
                onHoverAddress={handleHoverAddress}
                fundingMap={fundingMap}
                analysisScope={
                  showForensics && forensicsResult
                    ? new Set(forensicsResult.scopeAddresses)
                    : null
                }
                highlightedAddresses={highlightedForensicsAddresses}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
