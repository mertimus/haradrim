import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { getTokenOverview } from "@/birdeye-api";
import type { TokenOverview, TokenHolder } from "@/birdeye-api";
import { getBatchIdentity, getBatchSolDomains } from "@/api";
import {
  getTokenForensics,
  getTokenHolderSnapshot,
  type TokenForensicsReport,
} from "@/lib/backend-api";
import { buildHolderGraphData } from "@/lib/parse-holders";
import { HolderGraph } from "@/components/HolderGraph";
import { HolderTable } from "@/components/HolderTable";
import { TokenForensicsPanel } from "@/components/TokenForensicsPanel";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function getTokenFromUrl(): string {
  const match = window.location.pathname.match(/^\/token\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

const GRAPH_TOP_N = 100;
const TABLE_HOLDER_LIMIT = 5000;
const FORENSICS_SCOPE_LIMIT = 10;

function enrichHolders(
  holders: TokenHolder[],
  identityMap: Map<string, { name?: string }>,
  snsMap: Map<string, string>,
): TokenHolder[] {
  return holders.map((holder) => {
    const identity = identityMap.get(holder.owner);
    const sns = snsMap.get(holder.owner);
    const label = identity?.name ?? sns ?? holder.label;
    return label ? { ...holder, label } : holder;
  });
}

export function TokenExplorer() {
  const [tokenAddress, setTokenAddress] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<TokenOverview | null>(null);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [layoutKey, setLayoutKey] = useState(0);
  const [snapshotWarnings, setSnapshotWarnings] = useState<string[]>([]);
  const [showForensics, setShowForensics] = useState(false);
  const [forensicsLoading, setForensicsLoading] = useState(false);
  const [forensicsError, setForensicsError] = useState<string | null>(null);
  const [forensicsResult, setForensicsResult] = useState<TokenForensicsReport | null>(null);
  const [selectedForensicsClusterId, setSelectedForensicsClusterId] = useState<number | null>(null);
  const analyzeRequestIdRef = useRef(0);
  const forensicsRequestIdRef = useRef(0);
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
    setSnapshotWarnings([]);
    setShowForensics(false);
    setForensicsLoading(false);
    setForensicsError(null);
    setForensicsResult(null);
    setSelectedForensicsClusterId(null);
  }, []);

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
    setSnapshotWarnings([]);
    setShowForensics(false);
    setForensicsLoading(false);
    setForensicsError(null);
    setForensicsResult(null);
    setSelectedForensicsClusterId(null);
    forensicsRequestIdRef.current += 1;
    window.history.pushState({}, "", `/token/${trimmed}`);

    try {
      const [overviewResult, snapshotResult] = await Promise.allSettled([
        getTokenOverview(trimmed),
        getTokenHolderSnapshot(trimmed, { limit: TABLE_HOLDER_LIMIT }),
      ]);
      if (requestId !== analyzeRequestIdRef.current) return;

      const nextOverview =
        overviewResult.status === "fulfilled" ? overviewResult.value : null;
      const baseHolders =
        snapshotResult.status === "fulfilled" ? snapshotResult.value.holders : [];

      if (snapshotResult.status === "rejected") {
        throw snapshotResult.reason instanceof Error
          ? snapshotResult.reason
          : new Error("Unable to load token holders.");
      }

      const ownerAddresses = baseHolders.map((holder) => holder.owner);
      let enrichedHolders = baseHolders;

      if (ownerAddresses.length > 0) {
        const snsCandidateAddresses = baseHolders
          .slice(0, GRAPH_TOP_N)
          .map((holder) => holder.owner);

        const [identityResult, snsResult] = await Promise.allSettled([
          getBatchIdentity(ownerAddresses),
          getBatchSolDomains(snsCandidateAddresses),
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

        enrichedHolders = enrichHolders(baseHolders, identityMap, snsMap);
      }

      if (requestId !== analyzeRequestIdRef.current) return;
      if (!nextOverview && baseHolders.length === 0) {
        throw new Error("Unable to load token data. Check that the backend is running and the mint address is valid.");
      }
      if ((nextOverview?.holder ?? 0) > 0 && baseHolders.length === 0) {
        throw new Error("Token holder fetch returned no data for a token with holders.");
      }

      setOverview(nextOverview);
      setHolders(enrichedHolders);
      setSnapshotWarnings([
        [
          "Holder snapshot built from Helius getTokenLargestAccountsV2",
          snapshotResult.value.ownerLimit
            ? `top ${snapshotResult.value.ownerLimit.toLocaleString()} owners`
            : "loaded owners",
          snapshotResult.value.accountLimit
            ? `from top ${snapshotResult.value.accountLimit.toLocaleString()} token accounts`
            : null,
          `at ${new Date(snapshotResult.value.snapshotAt).toLocaleTimeString()}.`,
        ]
          .filter(Boolean)
          .join(" "),
        ...(snapshotResult.value.partial
          ? ["Snapshot is a significant-holder slice, not the full holder universe."]
          : []),
      ]);
    } catch (error) {
      if (requestId !== analyzeRequestIdRef.current) return;
      setOverview(null);
      setHolders([]);
      setNodes([]);
      setEdges([]);
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load token data.",
      );
    } finally {
      if (requestId === analyzeRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const handleToggleForensics = useCallback(async () => {
    if (!tokenAddress || holders.length === 0) return;

    if (showForensics) {
      setShowForensics(false);
      return;
    }

    setForensicsError(null);
    setShowForensics(true);
    if (forensicsResult?.mint === tokenAddress) return;

    const requestId = ++forensicsRequestIdRef.current;
    setForensicsLoading(true);

    try {
      const result = await getTokenForensics(tokenAddress, {
        scopeLimit: FORENSICS_SCOPE_LIMIT,
        maxDepth: 2,
        candidateLimit: 3,
      });
      if (requestId !== forensicsRequestIdRef.current) return;
      setForensicsResult(result);
      setSelectedForensicsClusterId(result.clusters[0]?.id ?? null);
    } catch (error) {
      if (requestId !== forensicsRequestIdRef.current) return;
      setForensicsError(
        error instanceof Error ? error.message : "Unable to load forensic clusters.",
      );
      setShowForensics(false);
    } finally {
      if (requestId === forensicsRequestIdRef.current) {
        setForensicsLoading(false);
      }
    }
  }, [forensicsResult?.mint, holders.length, showForensics, tokenAddress]);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void analyzeToken(inputValue);
  }, [analyzeToken, inputValue]);

  const handleBack = useCallback(() => {
    resetState();
    window.history.pushState({}, "", "/tokens");
  }, [resetState]);

  useEffect(() => {
    const token = getTokenFromUrl();
    if (token) {
      void analyzeToken(token);
    }
  }, [analyzeToken]);

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
    const lines = [...snapshotWarnings];
    if (showForensics && forensicsResult) {
      lines.push(...forensicsResult.warnings);
    }
    return [...new Set(lines)];
  }, [forensicsResult, showForensics, snapshotWarnings]);

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
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Paste token address..."
              className="w-full rounded border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
            />
            <button
              type="submit"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
            >
              Load
            </button>
          </div>
        </form>
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
        <div className="h-3 w-px bg-border" />
        <span className="font-mono text-[10px] text-muted-foreground">
          {holders.length.toLocaleString()} holders
        </span>
        <div className="h-3 w-px bg-border" />
        <span className="font-mono text-[10px] text-muted-foreground">
          Graph: top {Math.min(graphHolders.length, GRAPH_TOP_N)}
        </span>
        <button
          onClick={() => void handleToggleForensics()}
          disabled={loading || forensicsLoading || holders.length === 0}
          className={`rounded border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors ${
            showForensics
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-primary"
          } ${loading || forensicsLoading || holders.length === 0 ? "opacity-50" : ""}`}
        >
          {forensicsLoading ? "Analyzing..." : "Forensics"}
        </button>
        {showForensics && forensicsResult && (
          <>
            <div className="h-3 w-px bg-border" />
            <span className="font-mono text-[10px] text-muted-foreground">
              Analyzed: top {forensicsResult.scopeLimit}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          Table: top {holders.length.toLocaleString()} holders
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

        <div className="flex w-[360px] flex-none border-l border-border overflow-hidden">
          <div className="flex h-full w-full flex-col overflow-hidden">
            <TokenForensicsPanel
              report={showForensics ? forensicsResult : null}
              loading={showForensics && forensicsLoading}
              error={showForensics ? forensicsError : null}
              selectedClusterId={selectedForensicsClusterId}
              onSelectCluster={setSelectedForensicsClusterId}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <HolderTable
                holders={holders}
                loading={loading}
                onHoverAddress={handleHoverAddress}
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
