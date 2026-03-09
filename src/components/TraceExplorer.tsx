import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { Node, Edge } from "@xyflow/react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { ExplorerLanding } from "@/components/ExplorerLanding";
import { SearchBar } from "@/components/SearchBar";
import { TraceGraph } from "@/components/TraceGraph";
import { getIdentity } from "@/api";
import type { WalletIdentity } from "@/api";
import { getTraceAnalysis } from "@/lib/backend-api";
import {
  TRACE_ALL_ASSETS,
  DEFAULT_TRACE_FLOW_FILTERS,
  aggregateTraceCounterparties,
  assetLabel,
  compareDirectionalCounterparties,
  filterTraceEvents,
  getDirectionalAssets,
  getDirectionalTransferCount,
  getDirectionalTxCount,
  getPrimaryDirectionalAsset,
  type TraceAssetFlow,
  type TraceAssetOption,
  type TraceCounterparty,
  type TraceDirection,
  type TraceFlowFilters,
  type TraceNodeFlows,
} from "@/lib/trace-types";
import {
  createTraceState,
  addCounterpartiesToGraph,
  removeNodeFromGraph,
  buildTraceGraph,
  type TraceState,
} from "@/lib/trace-engine";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtCompact(value: number): string {
  if (value < 0.01 && value > 0) return "<0.01";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function assetTicker(asset: Pick<TraceAssetFlow, "symbol" | "kind" | "mint" | "assetId" | "name">): string {
  return asset.symbol ?? asset.name ?? (asset.kind === "native" ? "SOL" : truncAddr(asset.mint ?? asset.assetId));
}

function formatAssetSummary(asset: TraceAssetFlow): string {
  return `${fmtCompact(asset.uiAmount)} ${assetTicker(asset)}`;
}

function formatAssetOption(asset: TraceAssetOption): string {
  const label = assetLabel(asset);
  if (asset.kind === "native") return label;
  if (asset.symbol || asset.name) return `${label} · ${truncAddr(asset.mint ?? asset.assetId)}`;
  return truncAddr(asset.mint ?? asset.assetId);
}

function formatShortDate(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateSpan(firstSeen: number, lastSeen: number): string {
  if (!firstSeen && !lastSeen) return "";
  if (firstSeen === lastSeen) return formatShortDate(firstSeen);
  return `${formatShortDate(firstSeen)} - ${formatShortDate(lastSeen)}`;
}

interface TraceExplorerProps {
  initialAddress?: string;
  onNavigateToWallet?: (address: string) => void;
}

export function TraceExplorer({ initialAddress, onNavigateToWallet }: TraceExplorerProps) {
  const [seedAddress, setSeedAddress] = useState(initialAddress ?? "");
  const [inputValue, setInputValue] = useState("");
  const [traceState, setTraceState] = useState<TraceState | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(false);
  const [seedIdentity, setSeedIdentity] = useState<WalletIdentity | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  const [selectedNodeAddr, setSelectedNodeAddr] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelData, setPanelData] = useState<TraceNodeFlows | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [flowFilters, setFlowFilters] = useState<TraceFlowFilters>(DEFAULT_TRACE_FLOW_FILTERS);
  const [collapsed, setCollapsed] = useState({ outflow: true, inflow: true });

  const fetchedFlowsRef = useRef<Map<string, TraceNodeFlows>>(new Map());
  const inflightFlowsRef = useRef<Map<string, Promise<TraceNodeFlows>>>(new Map());
  const flowListenersRef = useRef<Map<string, Set<(data: TraceNodeFlows) => void>>>(new Map());
  const panelSubscriptionCleanupRef = useRef<(() => void) | null>(null);
  const requestIdRef = useRef(0);
  const panelRequestIdRef = useRef(0);

  const publishFlowUpdate = useCallback((address: string, data: TraceNodeFlows) => {
    const listeners = flowListenersRef.current.get(address);
    if (!listeners) return;
    for (const listener of listeners) listener(data);
  }, []);

  const subscribeFlowUpdates = useCallback((
    address: string,
    listener: (data: TraceNodeFlows) => void,
  ) => {
    const listeners = flowListenersRef.current.get(address) ?? new Set<(data: TraceNodeFlows) => void>();
    listeners.add(listener);
    flowListenersRef.current.set(address, listeners);

    return () => {
      const current = flowListenersRef.current.get(address);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        flowListenersRef.current.delete(address);
      }
    };
  }, []);

  const clearPanelSubscription = useCallback(() => {
    panelSubscriptionCleanupRef.current?.();
    panelSubscriptionCleanupRef.current = null;
  }, []);

  const fetchFlows = useCallback(async (address: string): Promise<TraceNodeFlows> => {
    const cached = fetchedFlowsRef.current.get(address);
    if (cached) return cached;

    const inflight = inflightFlowsRef.current.get(address);
    if (inflight) return inflight;

    const request = getTraceAnalysis(address)
      .then((data) => {
        fetchedFlowsRef.current.set(address, data);
        publishFlowUpdate(address, data);
        return data;
      })
      .finally(() => {
        inflightFlowsRef.current.delete(address);
      });

    inflightFlowsRef.current.set(address, request);
    return request;
  }, [publishFlowUpdate]);

  const startTrace = useCallback(async (address: string) => {
    if (!address) return;

    const rid = ++requestIdRef.current;
    setSeedAddress(address);
    setSeedIdentity(null);
    setTraceState(null);
    setNodes([]);
    setEdges([]);
    setLoading(true);
    setTraceError(null);
    clearPanelSubscription();
    setSelectedNodeAddr(null);
    setPanelData(null);
    setPanelError(null);
    setCollapsed({ outflow: true, inflow: true });
    fetchedFlowsRef.current = new Map();
    inflightFlowsRef.current = new Map();
    panelRequestIdRef.current += 1;

    window.history.pushState({}, "", `/trace/${address}`);

    try {
      const identResult = await getIdentity(address);
      if (rid !== requestIdRef.current) return;
      setSeedIdentity(identResult);

      const state = createTraceState(
        address,
        identResult?.label ?? identResult?.name,
        identResult?.category,
      );
      const graph = buildTraceGraph(state);
      setTraceState(state);
      setNodes(graph.nodes);
      setEdges(graph.edges);
    } catch (err) {
      if (rid === requestIdRef.current) {
        setTraceError(err instanceof Error ? err.message : "Trace failed");
      }
    } finally {
      if (rid === requestIdRef.current) setLoading(false);
    }
  }, [clearPanelSubscription]);

  const handleNodeClick = useCallback(async (address: string) => {
    const rid = ++panelRequestIdRef.current;
    clearPanelSubscription();
    panelSubscriptionCleanupRef.current = subscribeFlowUpdates(address, (data) => {
      fetchedFlowsRef.current.set(address, data);
      if (rid !== panelRequestIdRef.current) return;
      setPanelData(data);
    });
    setSelectedNodeAddr(address);
    setPanelLoading(true);
    setPanelData(null);
    setPanelError(null);
    setCollapsed({ outflow: true, inflow: true });

    try {
      const data = await fetchFlows(address);
      if (rid !== panelRequestIdRef.current) return;
      setPanelData(data);
    } catch (err) {
      if (rid === panelRequestIdRef.current) {
        setPanelError(err instanceof Error ? err.message : "Failed to fetch trace flows");
      }
      console.error("Failed to fetch trace flows:", err);
    } finally {
      if (rid === panelRequestIdRef.current) setPanelLoading(false);
    }
  }, [clearPanelSubscription, fetchFlows, subscribeFlowUpdates]);

  const handleAddCp = useCallback((
    sourceAddr: string,
    cp: TraceCounterparty,
    direction: TraceDirection,
  ) => {
    if (!traceState) return;
    const newState = addCounterpartiesToGraph(traceState, sourceAddr, [cp], direction);
    const graph = buildTraceGraph(newState);
    setTraceState(newState);
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [traceState]);

  const handleAddAll = useCallback((
    sourceAddr: string,
    cps: TraceCounterparty[],
    direction: TraceDirection,
  ) => {
    if (!traceState || cps.length === 0) return;
    const newState = addCounterpartiesToGraph(traceState, sourceAddr, cps, direction);
    const graph = buildTraceGraph(newState);
    setTraceState(newState);
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [traceState]);

  const handleRemoveNode = useCallback((address: string) => {
    if (!traceState) return;
    const newState = removeNodeFromGraph(traceState, address);
    const graph = buildTraceGraph(newState);
    setTraceState(newState);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    if (selectedNodeAddr === address) {
      clearPanelSubscription();
      panelRequestIdRef.current += 1;
      setSelectedNodeAddr(null);
      setPanelLoading(false);
      setPanelData(null);
      setPanelError(null);
    }
  }, [clearPanelSubscription, traceState, selectedNodeAddr]);

  const handleBack = useCallback(() => {
    setSeedAddress("");
    setSeedIdentity(null);
    setTraceState(null);
    setNodes([]);
    setEdges([]);
    setLoading(false);
    setTraceError(null);
    clearPanelSubscription();
    setSelectedNodeAddr(null);
    setPanelData(null);
    setPanelError(null);
    setCollapsed({ outflow: true, inflow: true });
    fetchedFlowsRef.current = new Map();
    inflightFlowsRef.current = new Map();
    panelRequestIdRef.current += 1;
    window.history.pushState({}, "", "/trace");
  }, [clearPanelSubscription]);

  useEffect(() => () => {
    clearPanelSubscription();
  }, [clearPanelSubscription]);

  const startedRef = useRef(false);
  if (initialAddress && !startedRef.current && !traceState && !loading) {
    startedRef.current = true;
    startTrace(initialAddress);
  }

  const assetOptions = useMemo(() => {
    if (!panelData) return [] as TraceAssetOption[];
    return panelData.assets.filter((asset) => flowFilters.assetKind === "all" || asset.kind === flowFilters.assetKind);
  }, [panelData, flowFilters.assetKind]);

  useEffect(() => {
    if (flowFilters.assetId === TRACE_ALL_ASSETS) return;
    if (assetOptions.some((asset) => asset.assetId === flowFilters.assetId)) return;
    setFlowFilters((current) => ({ ...current, assetId: TRACE_ALL_ASSETS }));
  }, [assetOptions, flowFilters.assetId]);

  const filteredEvents = useMemo(() => {
    if (!panelData) return [];
    return filterTraceEvents(panelData.events, flowFilters);
  }, [panelData, flowFilters]);

  const panelCps = useMemo(() => aggregateTraceCounterparties(filteredEvents), [filteredEvents]);

  const outflow = useMemo(
    () => panelCps
      .filter((cp) => cp.outflowAssets.length > 0)
      .sort((a, b) => compareDirectionalCounterparties(a, b, "outflow")),
    [panelCps],
  );
  const inflow = useMemo(
    () => panelCps
      .filter((cp) => cp.inflowAssets.length > 0)
      .sort((a, b) => compareDirectionalCounterparties(a, b, "inflow")),
    [panelCps],
  );

  const filteredFirstSeen = filteredEvents.length > 0
    ? Math.min(...filteredEvents.map((event) => event.timestamp))
    : 0;
  const filteredLastSeen = filteredEvents.length > 0
    ? Math.max(...filteredEvents.map((event) => event.timestamp))
    : 0;
  const outflowTransfers = filteredEvents.filter((event) => event.direction === "outflow").length;
  const inflowTransfers = filteredEvents.filter((event) => event.direction === "inflow").length;
  const hasActiveFilters = flowFilters.minAmount !== ""
    || flowFilters.dateFrom !== ""
    || flowFilters.dateTo !== ""
    || flowFilters.assetKind !== "all"
    || flowFilters.assetId !== TRACE_ALL_ASSETS;

  if (!seedAddress && !loading) {
    return (
      <ExplorerLanding
        mode="trace"
        action={(
          <SearchBar
            onSearch={(address) => {
              setInputValue(address);
              void startTrace(address);
            }}
            loading={loading}
            defaultValue={inputValue}
            autoFocus
            enableShortcut
            placeholder="Paste wallet address..."
            submitLabel="Trace"
          />
        )}
        error={traceError ? (
          <div className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-[10px] text-destructive/90">
            {traceError}
          </div>
        ) : undefined}
      />
    );
  }

  const graphAddresses = traceState ? new Set(traceState.nodeMap.keys()) : new Set<string>();
  const graphEdges = traceState ? new Set(traceState.edgeMap.keys()) : new Set<string>();
  const selectedAddress = selectedNodeAddr ?? "";
  const outflowNotAdded = outflow.filter((cp) => !graphEdges.has(`${selectedAddress}:${cp.address}`));
  const inflowNotAdded = inflow.filter((cp) => !graphEdges.has(`${cp.address}:${selectedAddress}`));
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const selectedNodeLabel = selectedNodeAddr
    ? traceState?.nodeMap.get(selectedNodeAddr)?.label
    : undefined;
  const availableRange = panelData ? formatDateSpan(panelData.firstSeen, panelData.lastSeen) : "";
  const filteredRange = filteredEvents.length > 0 ? formatDateSpan(filteredFirstSeen, filteredLastSeen) : "";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-none border-b border-border px-3 py-1.5 flex items-center gap-3">
        <button
          onClick={handleBack}
          className="font-mono text-[10px] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
        >
          ← Back
        </button>
        <div className="h-3 w-px bg-border" />
        <div className="flex items-center gap-2 min-w-0">
          {(seedIdentity?.label || seedIdentity?.name) && (
            <span className="font-mono text-[11px] font-bold text-primary truncate">
              {seedIdentity.label ?? seedIdentity.name}
            </span>
          )}
          <span className="font-mono text-[10px] text-muted-foreground">
            {truncAddr(seedAddress)}
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9px] text-muted-foreground">{nodeCount} Nodes</span>
          <span className="font-mono text-[9px] text-muted-foreground">{edgeCount} Edges</span>
          {loading && (
            <span className="scanning-text font-mono text-[9px] uppercase tracking-widest text-primary">
              Loading...
            </span>
          )}
        </div>
      </div>

      {traceError && (
        <div className="flex-none border-b border-destructive/30 bg-destructive/5 px-3 py-2 flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] text-destructive/90">{traceError}</span>
          {seedAddress && (
            <button
              onClick={() => startTrace(seedAddress)}
              className="rounded border border-destructive/40 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.2em] text-destructive transition-colors hover:bg-destructive/10"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <TraceGraph
            nodes={nodes}
            edges={edges}
            loading={loading}
            selectedNodeAddr={selectedNodeAddr}
            onNodeClick={handleNodeClick}
            onNavigateToWallet={onNavigateToWallet}
          />
        </div>

        {selectedNodeAddr && (
          <div className="w-[390px] flex-none border-l border-border overflow-hidden flex flex-col bg-card">
            <div className="flex-none border-b border-border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-muted-foreground">Flows of</div>
                  <div className="font-mono text-[11px] font-bold text-primary truncate">
                    {selectedNodeLabel ?? truncAddr(selectedNodeAddr)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    clearPanelSubscription();
                    panelRequestIdRef.current += 1;
                    setSelectedNodeAddr(null);
                    setPanelLoading(false);
                    setPanelData(null);
                    setPanelError(null);
                  }}
                  className="font-mono text-[10px] text-muted-foreground hover:text-primary cursor-pointer px-1"
                >
                  ✕
                </button>
              </div>
              {selectedNodeAddr !== traceState?.seedAddress && graphAddresses.has(selectedNodeAddr) && (
                <button
                  onClick={() => handleRemoveNode(selectedNodeAddr)}
                  className="mt-1.5 font-mono text-[9px] text-destructive/70 hover:text-destructive cursor-pointer"
                >
                  Remove from graph
                </button>
              )}
            </div>

            {panelLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="scanning-text font-mono text-[10px] uppercase tracking-widest text-primary">
                  Fetching...
                </span>
              </div>
            ) : panelError ? (
              <div className="flex-1 flex items-center justify-center px-4 text-center">
                <span className="font-mono text-[10px] text-destructive/80">{panelError}</span>
              </div>
            ) : !panelData ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="font-mono text-[10px] text-muted-foreground">Select a node to inspect flows</span>
              </div>
            ) : (
              <>
                <div className="flex-none border-b border-border px-3 py-2 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">Filtered View</div>
                      <div className="font-mono text-[10px] text-foreground/80">
                        {fmtCompact(filteredEvents.length)} transfers · {fmtCompact(panelCps.length)} counterparties
                      </div>
                      <div className="font-mono text-[8px] text-muted-foreground/70">
                        {filteredRange || availableRange || "No dated flows"}
                      </div>
                      {panelData.metadataPending && (
                        <div className="font-mono text-[8px] uppercase tracking-widest text-primary/70">
                          Enriching labels & token metadata...
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setFlowFilters(DEFAULT_TRACE_FLOW_FILTERS)}
                      disabled={!hasActiveFilters}
                      className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-muted-foreground disabled:opacity-40 cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">From</span>
                      <input
                        type="date"
                        value={flowFilters.dateFrom}
                        max={flowFilters.dateTo || undefined}
                        onChange={(e) => setFlowFilters((current) => ({ ...current, dateFrom: e.target.value }))}
                        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">To</span>
                      <input
                        type="date"
                        value={flowFilters.dateTo}
                        min={flowFilters.dateFrom || undefined}
                        onChange={(e) => setFlowFilters((current) => ({ ...current, dateTo: e.target.value }))}
                        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Asset Type</span>
                      <select
                        value={flowFilters.assetKind}
                        onChange={(e) => setFlowFilters((current) => ({
                          ...current,
                          assetKind: e.target.value as TraceFlowFilters["assetKind"],
                          assetId: TRACE_ALL_ASSETS,
                        }))}
                        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
                      >
                        <option value="all">All assets</option>
                        <option value="native">Native SOL</option>
                        <option value="token">Tokens / NFTs</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Token</span>
                      <select
                        value={flowFilters.assetId}
                        onChange={(e) => setFlowFilters((current) => ({ ...current, assetId: e.target.value }))}
                        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
                      >
                        <option value={TRACE_ALL_ASSETS}>All tokens</option>
                        {assetOptions.map((asset) => (
                          <option key={asset.assetId} value={asset.assetId}>{formatAssetOption(asset)}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="space-y-1 block">
                    <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Min Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={flowFilters.minAmount}
                      onChange={(e) => setFlowFilters((current) => ({ ...current, minAmount: e.target.value }))}
                      placeholder="0"
                      className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
                    />
                    <span className="font-mono text-[8px] text-muted-foreground/60">
                      Per-asset units{flowFilters.assetId === TRACE_ALL_ASSETS ? "; compare tokens carefully" : ""}
                    </span>
                  </label>
                </div>

                {panelData.events.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center px-4 text-center">
                    <span className="font-mono text-[10px] text-muted-foreground">No direct transfer flows</span>
                  </div>
                ) : filteredEvents.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center px-4 text-center">
                    <span className="font-mono text-[10px] text-muted-foreground">No flows match the current filters</span>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto min-h-0">
                    <FlowGroup
                      title="Outflow →"
                      color="#ff2d2d"
                      collapsed={collapsed.outflow}
                      onToggle={() => setCollapsed((current) => ({ ...current, outflow: !current.outflow }))}
                      counterparties={outflow}
                      transferCount={outflowTransfers}
                      notAdded={outflowNotAdded}
                      direction="outflow"
                      selectedAddress={selectedAddress}
                      graphEdges={graphEdges}
                      onAddAll={() => handleAddAll(selectedNodeAddr, outflowNotAdded.slice(0, 20), "outflow")}
                      onAddOne={(cp) => handleAddCp(selectedNodeAddr, cp, "outflow")}
                    />
                    <FlowGroup
                      title="← Inflow"
                      color="#00ff88"
                      collapsed={collapsed.inflow}
                      onToggle={() => setCollapsed((current) => ({ ...current, inflow: !current.inflow }))}
                      counterparties={inflow}
                      transferCount={inflowTransfers}
                      notAdded={inflowNotAdded}
                      direction="inflow"
                      selectedAddress={selectedAddress}
                      graphEdges={graphEdges}
                      onAddAll={() => handleAddAll(selectedNodeAddr, inflowNotAdded.slice(0, 20), "inflow")}
                      onAddOne={(cp) => handleAddCp(selectedNodeAddr, cp, "inflow")}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowGroup({
  title,
  color,
  collapsed,
  onToggle,
  counterparties,
  transferCount,
  notAdded,
  direction,
  selectedAddress,
  graphEdges,
  onAddAll,
  onAddOne,
}: {
  title: string;
  color: string;
  collapsed: boolean;
  onToggle: () => void;
  counterparties: TraceCounterparty[];
  transferCount: number;
  notAdded: TraceCounterparty[];
  direction: TraceDirection;
  selectedAddress: string;
  graphEdges: Set<string>;
  onAddAll: () => void;
  onAddOne: (cp: TraceCounterparty) => void;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="sticky top-0 z-10 bg-card px-3 py-1.5 border-b border-border/60">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onToggle}
            className="flex items-center gap-1.5 min-w-0 cursor-pointer"
          >
            {collapsed ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color }}>
              {title}
            </span>
            <span className="font-mono text-[8px] text-muted-foreground/70">
              {counterparties.length} cps · {transferCount} flows
            </span>
          </button>
          {notAdded.length > 0 && (
            <button
              onClick={onAddAll}
              className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground hover:text-primary cursor-pointer"
            >
              + Top 20
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        counterparties.length === 0 ? (
          <div className="px-3 py-2">
            <span className="font-mono text-[9px] text-muted-foreground/50">None</span>
          </div>
        ) : (
          counterparties.map((cp) => (
            <CpRow
              key={cp.address}
              cp={cp}
              direction={direction}
              isAdded={direction === "outflow"
                ? graphEdges.has(`${selectedAddress}:${cp.address}`)
                : graphEdges.has(`${cp.address}:${selectedAddress}`)}
              onAdd={() => onAddOne(cp)}
            />
          ))
        )
      )}
    </div>
  );
}

function CpRow({
  cp,
  direction,
  isAdded,
  onAdd,
}: {
  cp: TraceCounterparty;
  direction: TraceDirection;
  isAdded: boolean;
  onAdd: () => void;
}) {
  const amountColor = direction === "outflow" ? "#ff2d2d" : "#00ff88";
  const primaryAsset = getPrimaryDirectionalAsset(cp, direction);
  const assets = getDirectionalAssets(cp, direction);
  const txCount = getDirectionalTxCount(cp, direction);
  const transferCount = getDirectionalTransferCount(cp, direction);
  const topAssets = assets.slice(0, 2);
  const dateSpan = formatDateSpan(cp.firstSeen, cp.lastSeen);

  return (
    <div className="flex items-center gap-2 px-3 py-2 table-row-hover" style={{ opacity: isAdded ? 0.4 : 1 }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {cp.label ? (
            <span className="font-mono text-[10px] font-bold text-foreground truncate">{cp.label}</span>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground">{truncAddr(cp.address)}</span>
          )}
          {cp.category && (
            <span className="font-mono text-[7px] uppercase text-muted-foreground/60">{cp.category}</span>
          )}
        </div>
        <div className="font-mono text-[8px] text-muted-foreground/70 flex flex-wrap gap-x-2 gap-y-1">
          <span style={{ color: amountColor }}>
            {primaryAsset ? formatAssetSummary(primaryAsset) : `${fmtCompact(transferCount)} moves`}
          </span>
          <span>{txCount} tx</span>
          <span>{transferCount} moves</span>
          {dateSpan && <span>{dateSpan}</span>}
        </div>
        {assets.length > 1 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {topAssets.map((asset) => (
              <span
                key={asset.assetId}
                className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[7px] text-muted-foreground/80"
              >
                {formatAssetSummary(asset)}
              </span>
            ))}
            {assets.length > topAssets.length && (
              <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[7px] text-muted-foreground/60">
                +{assets.length - topAssets.length} more assets
              </span>
            )}
          </div>
        )}
      </div>
      {!isAdded ? (
        <button
          onClick={onAdd}
          className="flex-none font-mono text-[10px] text-primary hover:text-primary/80 cursor-pointer px-1.5 py-0.5 rounded border border-primary/20 hover:border-primary/40 transition-colors"
        >
          +
        </button>
      ) : (
        <span className="flex-none font-mono text-[8px] text-muted-foreground/40">added</span>
      )}
    </div>
  );
}
