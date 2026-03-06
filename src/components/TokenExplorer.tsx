import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import {
  getTrendingTokens,
  getTokenOverview,
  getTokenHolders,
} from "@/birdeye-api";
import type { TrendingToken, TokenOverview, TokenHolder } from "@/birdeye-api";
import { getBatchIdentity, getBatchSolDomains } from "@/api";
import { buildHolderGraphData } from "@/lib/parse-holders";
import { HolderGraph } from "@/components/HolderGraph";
import { HolderTable } from "@/components/HolderTable";
import {
  scanHolderConnections,
  type ScanProgress,
  type HolderConnection,
  type HolderCluster,
} from "@/lib/scan-holder-connections";
import {
  walkFundingHistory,
  type FundingWalkProgress,
  type FundingWalkResult,
  type FundingNode,
} from "@/lib/funding-walk";
import { appendFundingNodes } from "@/lib/parse-funding-graph";
import {
  scanBundles,
  type BundleScanProgress,
  type BundleGroup,
} from "@/lib/bundle-scan";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtPrice(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.001) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

function getTokenFromUrl(): string {
  const match = window.location.pathname.match(/^\/token\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function TokenExplorer() {
  const [tokenAddress, setTokenAddress] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [trendingTokens, setTrendingTokens] = useState<TrendingToken[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [overview, setOverview] = useState<TokenOverview | null>(null);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);

  // Connection scanning state
  const [showConnections, setShowConnections] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [clusters, setClusters] = useState<HolderCluster[]>([]);
  const analyzeRequestIdRef = useRef(0);
  const scanRequestIdRef = useRef(0);
  const scanResultRef = useRef<{
    connections: HolderConnection[];
    clusters: HolderCluster[];
  } | null>(null);
  const [layoutKey, setLayoutKey] = useState(0); // forces ReactFlow remount on layout change

  // Funding walk state
  const [showFunding, setShowFunding] = useState(false);
  const [fundingProgress, setFundingProgress] = useState<FundingWalkProgress | null>(null);
  const [walkingFunding, setWalkingFunding] = useState(false);
  const [commonFunders, setCommonFunders] = useState<FundingNode[]>([]);
  const fundingResultRef = useRef<FundingWalkResult | null>(null);
  const fundingScopeRef = useRef<TokenHolder[] | null>(null); // null = all holders
  const fundingRequestIdRef = useRef(0);

  // Bundle scan state
  const [scanningBundles, setScanningBundles] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<BundleScanProgress | null>(null);
  const [firstBuySlots, setFirstBuySlots] = useState<Map<string, number> | null>(null);
  const [bundleGroups, setBundleGroups] = useState<BundleGroup[]>([]);
  const [showBundles, setShowBundles] = useState(false);
  const bundleRequestIdRef = useRef(0);

  // Fetch trending on mount
  useEffect(() => {
    setTrendingLoading(true);
    getTrendingTokens()
      .then(setTrendingTokens)
      .finally(() => setTrendingLoading(false));
  }, []);

  const analyzeToken = useCallback(async (addr: string) => {
    if (!addr) return;
    const requestId = ++analyzeRequestIdRef.current;
    scanRequestIdRef.current++;
    scanResultRef.current = null;

    setTokenAddress(addr);
    setInputValue(addr);
    setLoading(true);
    setScanning(false);
    setOverview(null);
    setHolders([]);
    setNodes([]);
    setEdges([]);
    setClusters([]);
    setShowConnections(false);
    setScanProgress(null);
    setShowFunding(false);
    setFundingProgress(null);
    setWalkingFunding(false);
    setCommonFunders([]);

    fundingResultRef.current = null;
    fundingScopeRef.current = null;
    fundingRequestIdRef.current++;
    bundleRequestIdRef.current++;
    setScanningBundles(false);
    setBundleProgress(null);
    setFirstBuySlots(null);
    setBundleGroups([]);
    setShowBundles(false);

    // Clean URL: /token/:ca
    window.history.pushState({}, "", `/token/${addr}`);

    try {
      const [overviewResult, holdersResult] = await Promise.allSettled([
        getTokenOverview(addr),
        getTokenHolders(addr),
      ]);
      if (requestId !== analyzeRequestIdRef.current) return;

      const ov =
        overviewResult.status === "fulfilled" ? overviewResult.value : null;
      const hl =
        holdersResult.status === "fulfilled" ? holdersResult.value : [];

      setOverview(ov);

      // Enrich holders with Helius identity + SNS domain labels
      const ownerAddrs = hl.map((h) => h.owner);
      let enriched = hl;
      if (ownerAddrs.length > 0) {
        const [identityResult, snsResult] = await Promise.allSettled([
          getBatchIdentity(ownerAddrs),
          getBatchSolDomains(ownerAddrs),
        ]);
        if (requestId !== analyzeRequestIdRef.current) return;

        const identityMap =
          identityResult.status === "fulfilled"
            ? identityResult.value
            : new Map<string, { name?: string }>();
        const snsMap =
          snsResult.status === "fulfilled"
            ? snsResult.value
            : new Map<string, string>();

        enriched = hl.map((h) => {
          const id = identityMap.get(h.owner);
          const sns = snsMap.get(h.owner);
          const label = id?.name ?? sns;
          return label ? { ...h, label } : h;
        });
      }
      if (requestId !== analyzeRequestIdRef.current) return;

      setHolders(enriched);
      const { nodes: graphNodes } = buildHolderGraphData(enriched, ov);
      setNodes(graphNodes);
    } finally {
      if (requestId === analyzeRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const applyScanResult = useCallback(
    (result: { connections: HolderConnection[]; clusters: HolderCluster[] }) => {
      const { nodes: graphNodes, edges: graphEdges } = buildHolderGraphData(
        holders,
        overview,
        result.connections,
        result.clusters,
      );
      setNodes(graphNodes);
      setEdges(graphEdges);
      setClusters(result.clusters);
      setLayoutKey((k) => k + 1); // force ReactFlow remount for fitView
      scanResultRef.current = result;
    },
    [holders, overview],
  );

  // Connection scanning
  const startScan = useCallback(async () => {
    if (scanning || holders.length === 0) return;
    if (scanResultRef.current) {
      applyScanResult(scanResultRef.current);
      return;
    }

    const scanId = ++scanRequestIdRef.current;
    setScanning(true);
    setScanProgress(null);

    try {
      const result = await scanHolderConnections(
        tokenAddress,
        holders,
        50,
        (progress) => {
          if (scanId === scanRequestIdRef.current) {
            setScanProgress(progress);
          }
        },
      );
      if (scanId !== scanRequestIdRef.current) return;
      applyScanResult(result);
    } catch {
      // Scan failed — keep existing layout
    } finally {
      if (scanId === scanRequestIdRef.current) {
        setScanning(false);
      }
    }
  }, [applyScanResult, holders, scanning, tokenAddress]);

  const handleToggleConnections = useCallback(() => {
    const nextVal = !showConnections;
    setShowConnections(nextVal);

    if (nextVal) {
      // Turn off funding/bundles when enabling connections
      if (showFunding) setShowFunding(false);
      if (showBundles) setShowBundles(false);
      // Toggle ON
      if (scanResultRef.current) {
        applyScanResult(scanResultRef.current);
      } else if (!scanning) {
        startScan();
      }
    } else {
      // Toggle OFF — rebuild without connections
      const { nodes: graphNodes } = buildHolderGraphData(holders, overview);
      setNodes(graphNodes);
      setEdges([]);
      setLayoutKey((k) => k + 1);
    }
  }, [showConnections, showFunding, showBundles, holders, overview, scanning, applyScanResult, startScan]);

  // Funding walk
  const applyFundingResult = useCallback(
    (result: FundingWalkResult, scopeHolders?: TokenHolder[]) => {
      // Use scoped holders if provided (cluster fund walk), otherwise all holders
      const baseHolders = scopeHolders ?? holders;
      const { nodes: baseNodes } = buildHolderGraphData(baseHolders, overview);
      const { nodes: mergedNodes, edges: mergedEdges } = appendFundingNodes(baseNodes, result);
      setNodes(mergedNodes);
      setEdges(mergedEdges);
      setCommonFunders(result.commonFunders);
      setLayoutKey((k) => k + 1);
    },
    [holders, overview],
  );

  const startFundingWalk = useCallback(async () => {
    if (walkingFunding || holders.length === 0) return;
    if (fundingResultRef.current) {
      applyFundingResult(fundingResultRef.current, fundingScopeRef.current ?? undefined);
      return;
    }

    fundingScopeRef.current = null; // full walk = all holders
    const walkId = ++fundingRequestIdRef.current;
    setWalkingFunding(true);
    setFundingProgress(null);

    try {
      const result = await walkFundingHistory(
        holders.slice(0, 50),
        10,
        8,
        (progress) => {
          if (walkId === fundingRequestIdRef.current) {
            setFundingProgress(progress);
          }
        },
      );
      if (walkId !== fundingRequestIdRef.current) return;
      fundingResultRef.current = result;
      applyFundingResult(result);
    } catch {
      // Walk failed
    } finally {
      if (walkId === fundingRequestIdRef.current) {
        setWalkingFunding(false);
      }
    }
  }, [holders, walkingFunding, applyFundingResult]);

  const handleToggleFunding = useCallback(() => {
    const nextVal = !showFunding;
    setShowFunding(nextVal);

    if (nextVal) {
      // Turn off connections/bundles when enabling funding
      if (showConnections) setShowConnections(false);
      if (showBundles) setShowBundles(false);
      if (fundingResultRef.current) {
        applyFundingResult(fundingResultRef.current, fundingScopeRef.current ?? undefined);
      } else if (!walkingFunding) {
        startFundingWalk();
      }
    } else {
      // Toggle off — rebuild base holder graph without funding
      const { nodes: graphNodes } = buildHolderGraphData(holders, overview);
      setNodes(graphNodes);
      setEdges([]);
  
      setCommonFunders([]);
      setLayoutKey((k) => k + 1);
    }
  }, [showFunding, showConnections, showBundles, walkingFunding, startFundingWalk, applyFundingResult, holders, overview]);

  // Fund walk on a specific cluster's members
  const handleFundCluster = useCallback(async (memberAddresses: string[]) => {
    if (walkingFunding || memberAddresses.length === 0) return;

    // Find the TokenHolder objects for these addresses
    const memberSet = new Set(memberAddresses);
    const clusterHolders = holders.filter((h) => memberSet.has(h.owner));
    if (clusterHolders.length === 0) return;

    // Switch to funding view, scoped to this cluster
    setShowFunding(true);
    setShowConnections(false);
    fundingResultRef.current = null;
    fundingScopeRef.current = null;
    fundingScopeRef.current = clusterHolders;

    const walkId = ++fundingRequestIdRef.current;
    setWalkingFunding(true);
    setFundingProgress(null);

    try {
      const result = await walkFundingHistory(
        clusterHolders,
        10,
        8,
        (progress) => {
          if (walkId === fundingRequestIdRef.current) {
            setFundingProgress(progress);
          }
        },
      );
      if (walkId !== fundingRequestIdRef.current) return;
      fundingResultRef.current = result;
      applyFundingResult(result, clusterHolders);
    } catch {
      // Walk failed
    } finally {
      if (walkId === fundingRequestIdRef.current) {
        setWalkingFunding(false);
      }
    }
  }, [holders, walkingFunding, applyFundingResult]);

  const handleToggleBundles = useCallback(() => {
    if (bundleGroups.length === 0) return;
    const nextVal = !showBundles;
    setShowBundles(nextVal);

    if (nextVal) {
      // Turn off other views
      if (showConnections) setShowConnections(false);
      if (showFunding) setShowFunding(false);
      // Rebuild base graph (bundles only highlight, no extra nodes/edges)
      const { nodes: graphNodes } = buildHolderGraphData(holders, overview);
      setNodes(graphNodes);
      setEdges([]);
      setLayoutKey((k) => k + 1);
    } else {
      const { nodes: graphNodes } = buildHolderGraphData(holders, overview);
      setNodes(graphNodes);
      setEdges([]);
      setLayoutKey((k) => k + 1);
    }
  }, [showBundles, showConnections, showFunding, holders, overview, bundleGroups]);

  // Auto-trigger bundle scan when holders load
  useEffect(() => {
    if (holders.length === 0 || !tokenAddress) return;
    const bundleId = ++bundleRequestIdRef.current;
    setScanningBundles(true);
    setBundleProgress(null);
    setFirstBuySlots(null);
    setBundleGroups([]);

    scanBundles(tokenAddress, holders, 100, (progress) => {
      if (bundleId === bundleRequestIdRef.current) {
        setBundleProgress(progress);
      }
    })
      .then((result) => {
        if (bundleId !== bundleRequestIdRef.current) return;
        setFirstBuySlots(result.firstBuySlots);
        setBundleGroups(result.bundles);
      })
      .catch(() => {
        // scan failed
      })
      .finally(() => {
        if (bundleId === bundleRequestIdRef.current) {
          setScanningBundles(false);
        }
      });
  }, [holders, tokenAddress]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inputValue.trim();
      if (trimmed) analyzeToken(trimmed);
    },
    [inputValue, analyzeToken],
  );

  // Top-10 concentration
  const top10Pct = useMemo(() => {
    return holders.slice(0, 10).reduce((sum, h) => sum + h.percentage, 0);
  }, [holders]);

  const handleBack = useCallback(() => {
    analyzeRequestIdRef.current++;
    scanRequestIdRef.current++;
    fundingRequestIdRef.current++;
    scanResultRef.current = null;
    fundingResultRef.current = null;
    fundingScopeRef.current = null;
    setTokenAddress("");
    setOverview(null);
    setHolders([]);
    setNodes([]);
    setEdges([]);
    setClusters([]);
    setShowConnections(false);
    setScanProgress(null);
    setScanning(false);
    setShowFunding(false);
    setFundingProgress(null);
    setWalkingFunding(false);
    setCommonFunders([]);
    bundleRequestIdRef.current++;
    setScanningBundles(false);
    setBundleProgress(null);
    setFirstBuySlots(null);
    setBundleGroups([]);
    setShowBundles(false);

    setInputValue("");
    window.history.pushState({}, "", "/");
  }, []);

  // Read token from URL on mount
  useEffect(() => {
    const token = getTokenFromUrl();
    if (token) analyzeToken(token);
  }, [analyzeToken]);

  // Handle browser back/forward
  useEffect(() => {
    function onPop() {
      const token = getTokenFromUrl();
      if (token) {
        analyzeToken(token);
      } else {
        analyzeRequestIdRef.current++;
        scanRequestIdRef.current++;
        fundingRequestIdRef.current++;
        scanResultRef.current = null;
        fundingResultRef.current = null;
    fundingScopeRef.current = null;
        setTokenAddress("");
        setOverview(null);
        setHolders([]);
        setNodes([]);
        setEdges([]);
        setClusters([]);
        setShowConnections(false);
        setScanProgress(null);
        setScanning(false);
        setShowFunding(false);
        setFundingProgress(null);
        setWalkingFunding(false);
        setCommonFunders([]);
        bundleRequestIdRef.current++;
        setScanningBundles(false);
        setBundleProgress(null);
        setFirstBuySlots(null);
        setBundleGroups([]);

        setInputValue("");
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [analyzeToken]);

  // Ref-based hover highlight — matches wallet graph pattern
  const graphWrapperRef = useRef<HTMLDivElement>(null);
  const handleHoverAddress = useCallback((address: string | null) => {
    const container = graphWrapperRef.current;
    if (!container) return;
    const prev = container.querySelector(".react-flow__node.node-highlighted");
    if (prev) prev.classList.remove("node-highlighted");
    if (address) {
      const el = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(address)}"]`,
      );
      if (el) el.classList.add("node-highlighted");
    }
  }, []);

  // Landing state — no token selected
  if (!tokenAddress) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <h2 className="font-mono text-lg font-bold tracking-wider text-primary text-glow-cyan">
            TOKEN EXPLORER
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Holder Concentration Analysis
          </p>
        </div>

        {/* Search */}
        <form onSubmit={handleSubmit} className="w-full max-w-md">
          <div className="relative">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Paste token address..."
              className="w-full rounded border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
            />
            <button
              type="submit"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-primary hover:bg-primary/20 transition-colors cursor-pointer"
            >
              Analyze
            </button>
          </div>
        </form>

        {/* Trending tokens */}
        {trendingLoading ? (
          <div className="scanning-text font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Loading trending...
          </div>
        ) : trendingTokens.length > 0 ? (
          <div className="w-full max-w-2xl">
            <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground text-center">
              Trending Tokens
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {trendingTokens.map((t) => (
                <button
                  key={t.address}
                  onClick={() => analyzeToken(t.address)}
                  className="flex items-center gap-2 rounded border border-border bg-card/80 px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-card cursor-pointer"
                >
                  {t.logoURI ? (
                    <img
                      src={t.logoURI}
                      alt=""
                      className="h-6 w-6 rounded-full object-cover flex-shrink-0"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-muted flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[10px] font-bold text-foreground">
                      {t.symbol}
                    </div>
                    <div className="truncate font-mono text-[8px] text-muted-foreground">
                      {t.name}
                    </div>
                    <div className="font-mono text-[8px] text-muted-foreground/60">
                      Vol {fmtUsd(t.volume24hUSD)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // Analysis state — token selected
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Overview bar */}
      <div className="flex-none border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBack}
            className="font-mono text-[9px] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
          >
            ← Back
          </button>
          <div className="h-3 w-px bg-border" />
          {overview ? (
            <>
              <div className="flex items-center gap-2">
                {overview.image && (
                  <img
                    src={overview.image}
                    alt=""
                    className="h-5 w-5 rounded-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display =
                        "none";
                    }}
                  />
                )}
                <span className="font-mono text-xs font-bold text-primary">
                  {overview.symbol}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {overview.name}
                </span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span>
                  <span className="text-muted-foreground/60">MCap </span>
                  <span className="text-foreground">
                    {fmtUsd(overview.marketCap)}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground/60">Price </span>
                  <span className="text-foreground">
                    {fmtPrice(overview.price)}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground/60">Holders </span>
                  <span className="text-foreground">
                    {overview.holder.toLocaleString()}
                  </span>
                </span>
                {holders.length > 0 && (
                  <span>
                    <span className="text-muted-foreground/60">
                      Top-10{" "}
                    </span>
                    <span
                      style={{
                        color:
                          top10Pct >= 50
                            ? "#ff2d2d"
                            : top10Pct >= 30
                              ? "#ffb800"
                              : "#00ff88",
                      }}
                    >
                      {top10Pct.toFixed(1)}%
                    </span>
                  </span>
                )}
                {bundleGroups.length > 0 && (
                  <span>
                    <span className="text-muted-foreground/60">Bundles </span>
                    <span style={{ color: "#a855f7" }}>
                      {bundleGroups.length} ({bundleGroups.reduce((s, g) => s + g.members.length, 0)} wallets)
                    </span>
                  </span>
                )}
              </div>
              <div className="h-3 w-px bg-border" />
              {/* Connection toggle */}
              {holders.length > 0 && (
                <button
                  onClick={handleToggleConnections}
                  disabled={scanning}
                  className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors"
                  style={{
                    background: showConnections
                      ? "rgba(255, 184, 0, 0.15)"
                      : "rgba(107, 123, 141, 0.1)",
                    color: showConnections ? "#ffb800" : "#6b7b8d",
                    border: `1px solid ${showConnections ? "rgba(255, 184, 0, 0.3)" : "#1e2a3a"}`,
                    opacity: scanning ? 0.6 : 1,
                  }}
                >
                  {showConnections ? "Connections On" : "Show Connections"}
                </button>
              )}
              {holders.length > 0 && (
                <button
                  onClick={handleToggleFunding}
                  disabled={walkingFunding}
                  className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors"
                  style={{
                    background: showFunding
                      ? "rgba(255, 45, 45, 0.15)"
                      : "rgba(107, 123, 141, 0.1)",
                    color: showFunding ? "#ff2d2d" : "#6b7b8d",
                    border: `1px solid ${showFunding ? "rgba(255, 45, 45, 0.3)" : "#1e2a3a"}`,
                    opacity: walkingFunding ? 0.6 : 1,
                  }}
                >
                  {showFunding ? "Funding On" : "Fund Walk"}
                </button>
              )}
              {holders.length > 0 && (
                <button
                  onClick={handleToggleBundles}
                  disabled={scanningBundles && bundleGroups.length === 0}
                  className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors"
                  style={{
                    background: showBundles
                      ? "rgba(168, 85, 247, 0.15)"
                      : "rgba(107, 123, 141, 0.1)",
                    color: showBundles ? "#a855f7" : "#6b7b8d",
                    border: `1px solid ${showBundles ? "rgba(168, 85, 247, 0.3)" : "#1e2a3a"}`,
                    opacity: scanningBundles && bundleGroups.length === 0 ? 0.6 : 1,
                  }}
                >
                  {scanningBundles
                    ? "Scanning..."
                    : showBundles
                      ? "Bundles On"
                      : bundleGroups.length > 0
                        ? `Bundles (${bundleGroups.length})`
                        : "No Bundles"}
                </button>
              )}
            </>
          ) : loading ? (
            <span className="scanning-text font-mono text-[10px] text-muted-foreground">
              Loading...
            </span>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground">
              {truncAddr(tokenAddress)}
            </span>
          )}
        </div>
      </div>

      {/* Scan progress bar */}
      {scanning && scanProgress && (
        <div className="flex-none border-b border-border px-3 py-1">
          <div className="flex items-center gap-3">
            <span className="scanning-text font-mono text-[9px] text-muted-foreground">
              Scanning holders... {scanProgress.scanned}/{scanProgress.total}
            </span>
            <div
              style={{
                flex: 1,
                height: 2,
                background: "#1e2a3a",
                borderRadius: 1,
                overflow: "hidden",
                maxWidth: 120,
              }}
            >
              <div
                style={{
                  width: `${(scanProgress.scanned / scanProgress.total) * 100}%`,
                  height: "100%",
                  background: "#ffb800",
                  borderRadius: 1,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            {scanProgress.connections.length > 0 && (
              <span className="font-mono text-[9px] text-amber">
                {scanProgress.connections.length} connection
                {scanProgress.connections.length !== 1 ? "s" : ""} found
              </span>
            )}
          </div>
        </div>
      )}

      {/* Funding walk progress bar */}
      {walkingFunding && (
        <div className="flex-none border-b border-border px-3 py-1">
          <div className="flex items-center gap-3">
            <span className="scanning-text font-mono text-[9px] text-muted-foreground">
              {!fundingProgress
                ? "Starting funding walk..."
                : fundingProgress.phase === "walking"
                  ? `Walking depth ${fundingProgress.depth}/10...`
                  : "Enriching labels..."}
            </span>
            <div
              style={{
                flex: 1,
                height: 2,
                background: "#1e2a3a",
                borderRadius: 1,
                overflow: "hidden",
                maxWidth: 120,
              }}
            >
              <div
                style={{
                  width: `${fundingProgress ? (fundingProgress.depth / 10) * 100 : 0}%`,
                  height: "100%",
                  background: "#ff2d2d",
                  borderRadius: 1,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            {fundingProgress && (
              <span className="font-mono text-[9px]" style={{ color: "#6b7b8d" }}>
                {fundingProgress.visited} visited
              </span>
            )}
            {fundingProgress && fundingProgress.commonFunders > 0 && (
              <span className="font-mono text-[9px]" style={{ color: "#ff2d2d" }}>
                {fundingProgress.commonFunders} common funder
                {fundingProgress.commonFunders !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Bundle scan progress bar */}
      {scanningBundles && bundleProgress && (
        <div className="flex-none border-b border-border px-3 py-1">
          <div className="flex items-center gap-3">
            <span className="scanning-text font-mono text-[9px] text-muted-foreground">
              Scanning first buys... {bundleProgress.scanned}/{bundleProgress.total}
            </span>
            <div
              style={{
                flex: 1,
                height: 2,
                background: "#1e2a3a",
                borderRadius: 1,
                overflow: "hidden",
                maxWidth: 120,
              }}
            >
              <div
                style={{
                  width: `${(bundleProgress.scanned / bundleProgress.total) * 100}%`,
                  height: "100%",
                  background: "#a855f7",
                  borderRadius: 1,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            {bundleProgress.bundleCount > 0 && (
              <span className="font-mono text-[9px]" style={{ color: "#a855f7" }}>
                {bundleProgress.bundleCount} bundle
                {bundleProgress.bundleCount !== 1 ? "s" : ""} found
              </span>
            )}
          </div>
        </div>
      )}

      {/* Graph + Table side by side */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph */}
        <div ref={graphWrapperRef} className="flex-1 overflow-hidden">
          <HolderGraph
            key={layoutKey}
            nodes={nodes}
            edges={edges}
            clusters={clusters}
            showConnections={showConnections}
            commonFunders={commonFunders}
            showFunding={showFunding}
            loading={loading}
            onFundCluster={handleFundCluster}
            walkingFunding={walkingFunding}
            bundleGroups={bundleGroups}
            showBundles={showBundles}
          />
        </div>

        {/* Right panel: holder table */}
        <div className="w-[360px] flex-none border-l border-border overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            <HolderTable
              holders={holders}
              loading={loading}
              onHoverAddress={handleHoverAddress}
              firstBuySlots={firstBuySlots ?? undefined}
              bundleGroups={bundleGroups}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
