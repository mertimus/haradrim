import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { Node, Edge } from "@xyflow/react";
import { ChevronDown, ChevronRight, Copy, Check, RotateCcw, Filter, Search } from "lucide-react";
import { ExplorerLanding } from "@/components/ExplorerLanding";
import { SearchBar } from "@/components/SearchBar";
import { TraceGraph } from "@/components/TraceGraph";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getIdentity, getBatchSolDomains } from "@/api";
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
  getDirectionalTxCount,
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
  return asset.symbol || asset.name || (asset.kind === "native" ? "SOL" : truncAddr(asset.mint ?? asset.assetId));
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

/* ── Sortable table helpers ───────────────────────────────────────── */

type CpSortKey = "name" | "txs" | "lastSeen";
type CpSortDir = "asc" | "desc";

const TH =
  "font-mono text-[8px] uppercase tracking-wider text-muted-foreground";

function CpSortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: CpSortKey;
  sortKey: CpSortKey | null;
  sortDir: CpSortDir;
}) {
  const active = sortKey === col;
  return (
    <span className="ml-0.5 inline-flex flex-col leading-none align-middle">
      <span
        className={`text-[6px] leading-[7px] ${active && sortDir === "asc" ? "text-primary" : "text-muted-foreground/30"}`}
      >
        {"\u25B2"}
      </span>
      <span
        className={`text-[6px] leading-[7px] ${active && sortDir === "desc" ? "text-primary" : "text-muted-foreground/30"}`}
      >
        {"\u25BC"}
      </span>
    </span>
  );
}

function formatCompactDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const month = d.toLocaleDateString(undefined, { month: "short" });
  const day = d.getDate();
  if (d.getFullYear() === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, '${String(d.getFullYear()).slice(2)}`;
}

/* ── Custom filter dropdown ───────────────────────────────────────── */

function TokenFilterDropdown({ label, value, allValue, options, onChange }: {
  label: string;
  value: string;
  allValue: string;
  options: TraceAssetOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = value === allValue
    ? "All tokens"
    : formatAssetOption(options.find((o) => o.assetId === value) ?? { assetId: value, kind: "token" as const, decimals: 0, transferCount: 0, txCount: 0, uiAmount: 0 });

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter((a) => {
      const text = `${a.symbol ?? ""} ${a.name ?? ""} ${a.mint ?? a.assetId}`.toLowerCase();
      return text.includes(q);
    });
  }, [options, search]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  return (
    <div className="space-y-1" ref={ref}>
      <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full cursor-pointer items-center justify-between rounded border border-border/50 bg-background px-2 py-1.5 font-mono text-[10px] text-foreground transition-colors hover:border-border focus:border-primary/60 focus:outline-none"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className={`ml-1 h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full z-40 mt-0.5 overflow-hidden rounded border border-border/50 bg-background shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            <div className="border-b border-border/30 px-2 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tokens..."
                className="w-full bg-transparent font-mono text-[10px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
              />
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {!search && (
                <button
                  type="button"
                  onClick={() => { onChange(allValue); setOpen(false); }}
                  className={`flex w-full cursor-pointer px-2 py-1.5 text-left font-mono text-[10px] transition-colors hover:bg-primary/8 ${
                    value === allValue ? "text-primary" : "text-foreground/80"
                  }`}
                >
                  All tokens
                </button>
              )}
              {filtered.map((asset) => (
                <button
                  key={asset.assetId}
                  type="button"
                  onClick={() => { onChange(asset.assetId); setOpen(false); }}
                  className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left font-mono text-[10px] transition-colors hover:bg-primary/8 ${
                    asset.assetId === value ? "text-primary" : "text-foreground/80"
                  }`}
                >
                  <span className="truncate">{formatAssetOption(asset)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/40">{fmtCompact(asset.transferCount)}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-2 py-3 text-center font-mono text-[10px] text-muted-foreground/50">No matches</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TraceExplorerProps {
  initialAddress?: string;
  onNavigateToWallet?: (address: string) => void;
  onRouteAddressChange?: (address: string) => void;
}

export function TraceExplorer({
  initialAddress,
  onNavigateToWallet,
  onRouteAddressChange,
}: TraceExplorerProps) {
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
  const [collapsed, setCollapsed] = useState({ outflow: false, inflow: true });
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [cpSearch, setCpSearch] = useState("");
  const [domainMap, setDomainMap] = useState<Map<string, string>>(new Map());

  const fetchedFlowsRef = useRef<Map<string, TraceNodeFlows>>(new Map());
  const quickScannedRef = useRef<Set<string>>(new Set());
  const inflightFlowsRef = useRef<Map<string, Promise<TraceNodeFlows>>>(new Map());
  const flowListenersRef = useRef<Map<string, Set<(data: TraceNodeFlows) => void>>>(new Map());
  const panelSubscriptionCleanupRef = useRef<(() => void) | null>(null);
  const domainQueriedRef = useRef<Set<string>>(new Set());
  const pollTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const requestIdRef = useRef(0);
  const panelRequestIdRef = useRef(0);
  const autoSelectRef = useRef<string | null>(null);

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

  const fetchFlows = useCallback(async (address: string, isSeed = false): Promise<TraceNodeFlows> => {
    const cached = fetchedFlowsRef.current.get(address);
    if (cached && !cached.metadataPending) return cached;

    const inflight = inflightFlowsRef.current.get(address);
    if (inflight) return inflight;

    // Non-seed nodes use a tx limit to avoid timeouts on large program accounts
    const opts = isSeed ? undefined : { limit: 2000 };
    if (!isSeed) quickScannedRef.current.add(address);
    const request = getTraceAnalysis(address, undefined, opts)
      .then((data) => {
        fetchedFlowsRef.current.set(address, data);
        publishFlowUpdate(address, data);

        // If metadata is still pending, poll until enriched
        if (data.metadataPending) {
          const poll = (attempt: number) => {
            const delay = Math.min(2000 * attempt, 10000);
            const timer = setTimeout(async () => {
              pollTimersRef.current.delete(timer);
              try {
                const enriched = await getTraceAnalysis(address, undefined, opts);
                fetchedFlowsRef.current.set(address, enriched);
                publishFlowUpdate(address, enriched);
                if (enriched.metadataPending && attempt < 10) poll(attempt + 1);
              } catch {
                if (attempt < 10) poll(attempt + 1);
              }
            }, delay);
            pollTimersRef.current.add(timer);
          };
          poll(1);
        }

        return data;
      })
      .finally(() => {
        inflightFlowsRef.current.delete(address);
      });

    inflightFlowsRef.current.set(address, request);
    return request;
  }, [publishFlowUpdate]);

  const resetTrace = useCallback(() => {
    requestIdRef.current += 1;
    panelRequestIdRef.current += 1;
    autoSelectRef.current = null;
    clearPanelSubscription();
    for (const t of pollTimersRef.current) clearTimeout(t);
    pollTimersRef.current.clear();
    setSeedAddress("");
    setSeedIdentity(null);
    setTraceState(null);
    setNodes([]);
    setEdges([]);
    setLoading(false);
    setTraceError(null);
    setSelectedNodeAddr(null);
    setPanelLoading(false);
    setPanelData(null);
    setPanelError(null);
    setCollapsed({ outflow: false, inflow: true });
    fetchedFlowsRef.current = new Map();
    inflightFlowsRef.current = new Map();
  }, [clearPanelSubscription]);

  const startTrace = useCallback(async (
    address: string,
    options: { updateHistory?: boolean } = {},
  ) => {
    if (!address) return;
    const { updateHistory = true } = options;

    const rid = ++requestIdRef.current;
    setSeedAddress(address);
    setSeedIdentity(null);
    setTraceState(null);
    setNodes([]);
    setEdges([]);
    setLoading(true);
    setTraceError(null);
    clearPanelSubscription();
    for (const t of pollTimersRef.current) clearTimeout(t);
    pollTimersRef.current.clear();
    setSelectedNodeAddr(null);
    setPanelData(null);
    setPanelError(null);
    setCollapsed({ outflow: false, inflow: true });
    fetchedFlowsRef.current = new Map();
    inflightFlowsRef.current = new Map();
    panelRequestIdRef.current += 1;

    if (updateHistory) {
      window.history.pushState({}, "", `/trace/${address}`);
      onRouteAddressChange?.(address);
    }

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
      // Auto-open the inspection panel for the seed node
      autoSelectRef.current = address;
    } catch (err) {
      if (rid === requestIdRef.current) {
        setTraceError(err instanceof Error ? err.message : "Trace failed");
      }
    } finally {
      if (rid === requestIdRef.current) setLoading(false);
    }
  }, [clearPanelSubscription, onRouteAddressChange]);

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
    setCollapsed({ outflow: false, inflow: true });
    setCpSearch("");

    try {
      const isSeed = address === seedAddress;
      const data = await fetchFlows(address, isSeed);
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
  }, [clearPanelSubscription, fetchFlows, subscribeFlowUpdates, seedAddress]);

  const handleFullScan = useCallback(async (address: string) => {
    const rid = ++panelRequestIdRef.current;
    clearPanelSubscription();
    panelSubscriptionCleanupRef.current = subscribeFlowUpdates(address, (data) => {
      fetchedFlowsRef.current.set(address, data);
      if (rid !== panelRequestIdRef.current) return;
      setPanelData(data);
    });
    setPanelLoading(true);
    setPanelError(null);

    // Clear cached quick-scan result so fetchFlows doesn't return it
    fetchedFlowsRef.current.delete(address);
    quickScannedRef.current.delete(address);

    try {
      const data = await fetchFlows(address, true);
      if (rid !== panelRequestIdRef.current) return;
      setPanelData(data);
    } catch (err) {
      if (rid === panelRequestIdRef.current) {
        setPanelError(err instanceof Error ? err.message : "Full scan failed");
      }
    } finally {
      if (rid === panelRequestIdRef.current) setPanelLoading(false);
    }
  }, [clearPanelSubscription, fetchFlows, subscribeFlowUpdates]);

  // Auto-select seed node after trace initializes
  useEffect(() => {
    if (autoSelectRef.current && traceState && !selectedNodeAddr) {
      const addr = autoSelectRef.current;
      autoSelectRef.current = null;
      void handleNodeClick(addr);
    }
  }, [traceState, selectedNodeAddr, handleNodeClick]);

  const applyDomainLabel = useCallback((cp: TraceCounterparty): TraceCounterparty => {
    if (cp.label) return cp;
    const domain = domainMap.get(cp.address);
    return domain ? { ...cp, label: domain } : cp;
  }, [domainMap]);

  const handleAddCp = useCallback((
    sourceAddr: string,
    cp: TraceCounterparty,
    direction: TraceDirection,
  ) => {
    if (!traceState) return;
    const newState = addCounterpartiesToGraph(traceState, sourceAddr, [applyDomainLabel(cp)], direction);
    const graph = buildTraceGraph(newState);
    setTraceState(newState);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    // Defer inspection to next tick so state updates flush first
    queueMicrotask(() => void handleNodeClick(cp.address));
  }, [traceState, applyDomainLabel, handleNodeClick]);

  const handleAddAll = useCallback((
    sourceAddr: string,
    cps: TraceCounterparty[],
    direction: TraceDirection,
  ) => {
    if (!traceState || cps.length === 0) return;
    const newState = addCounterpartiesToGraph(traceState, sourceAddr, cps.map(applyDomainLabel), direction);
    const graph = buildTraceGraph(newState);
    setTraceState(newState);
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [traceState, applyDomainLabel]);

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
    resetTrace();
    window.history.pushState({}, "", "/trace");
    onRouteAddressChange?.("");
  }, [onRouteAddressChange, resetTrace]);

  useEffect(() => () => {
    clearPanelSubscription();
    for (const t of pollTimersRef.current) clearTimeout(t);
    pollTimersRef.current.clear();
  }, [clearPanelSubscription]);

  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialAddress) {
      void startTrace(initialAddress, { updateHistory: false });
    }
  }, [initialAddress, startTrace]);

  useEffect(() => {
    if (!startedRef.current) return;
    if (!initialAddress) {
      if (seedAddress) resetTrace();
      return;
    }
    if (initialAddress !== seedAddress) {
      void startTrace(initialAddress, { updateHistory: false });
    }
  }, [initialAddress, resetTrace, seedAddress, startTrace]);

  const assetOptions = useMemo(() => {
    if (!panelData) return [] as TraceAssetOption[];
    return panelData.assets.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "native" ? -1 : 1;
      return b.transferCount - a.transferCount;
    });
  }, [panelData]);

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

  // Resolve SNS .sol domains for unlabeled counterparties
  useEffect(() => {
    const unlabeled = panelCps
      .filter((cp) => !cp.label && !domainQueriedRef.current.has(cp.address))
      .map((cp) => cp.address);
    if (unlabeled.length === 0) return;
    for (const addr of unlabeled) domainQueriedRef.current.add(addr);
    let cancelled = false;
    getBatchSolDomains(unlabeled).then((resolved) => {
      if (cancelled || resolved.size === 0) return;
      setDomainMap((prev) => {
        const next = new Map(prev);
        for (const [addr, domain] of resolved) next.set(addr, domain);
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [panelCps]);

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
    || flowFilters.maxAmount !== ""
    || flowFilters.dateFrom !== ""
    || flowFilters.dateTo !== ""
    || flowFilters.assetId !== TRACE_ALL_ASSETS;
  const activeFilterCount =
    (flowFilters.minAmount !== "" ? 1 : 0)
    + (flowFilters.maxAmount !== "" ? 1 : 0)
    + (flowFilters.dateFrom !== "" ? 1 : 0)
    + (flowFilters.dateTo !== "" ? 1 : 0)
    + (flowFilters.assetId !== TRACE_ALL_ASSETS ? 1 : 0);

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
          <div className="w-[460px] flex-none border-l border-border overflow-hidden flex flex-col bg-card">
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
                {/* Compact summary bar — always visible */}
                <div className="flex-none border-b border-border px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] text-foreground/80">
                        {fmtCompact(filteredEvents.length)} transfers · {fmtCompact(panelCps.length)} cps
                        {(filteredRange || availableRange) && (
                          <span className="text-muted-foreground/60"> · {filteredRange || availableRange}</span>
                        )}
                      </div>
                      {panelData.metadataPending && (
                        <div className="font-mono text-[8px] uppercase tracking-widest text-primary/70">
                          Enriching labels...
                        </div>
                      )}
                      {selectedNodeAddr && quickScannedRef.current.has(selectedNodeAddr) && (
                        <button
                          onClick={() => handleFullScan(selectedNodeAddr)}
                          className="font-mono text-[8px] text-primary/60 underline underline-offset-2 cursor-pointer hover:text-primary"
                        >
                          Quick scan (2k tx) — full history
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {hasActiveFilters && (
                        <button
                          onClick={() => setFlowFilters(DEFAULT_TRACE_FLOW_FILTERS)}
                          className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground cursor-pointer hover:text-primary"
                        >
                          <RotateCcw className="h-2.5 w-2.5" />
                          Reset
                        </button>
                      )}
                      <button
                        onClick={() => setFiltersExpanded((v) => !v)}
                        className="relative inline-flex items-center rounded border border-border/60 p-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
                      >
                        <Filter className="h-3 w-3" />
                        {activeFilterCount > 0 && (
                          <span className="absolute -right-1 -top-1 flex h-3 min-w-[12px] items-center justify-center rounded-full bg-primary px-0.5 font-mono text-[7px] font-bold text-primary-foreground">
                            {activeFilterCount}
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expandable filter controls */}
                {filtersExpanded && (
                  <div className="flex-none border-b border-border px-3 py-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">From</span>
                        <input
                          type="date"
                          value={flowFilters.dateFrom}
                          max={flowFilters.dateTo || undefined}
                          onChange={(e) => setFlowFilters((current) => ({ ...current, dateFrom: e.target.value }))}
                          className="w-full rounded border border-border/50 bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary/60 focus:outline-none"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">To</span>
                        <input
                          type="date"
                          value={flowFilters.dateTo}
                          min={flowFilters.dateFrom || undefined}
                          onChange={(e) => setFlowFilters((current) => ({ ...current, dateTo: e.target.value }))}
                          className="w-full rounded border border-border/50 bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary/60 focus:outline-none"
                        />
                      </label>
                    </div>

                    <TokenFilterDropdown
                      label="Asset"
                      value={flowFilters.assetId}
                      allValue={TRACE_ALL_ASSETS}
                      options={assetOptions}
                      onChange={(v) => setFlowFilters((current) => ({ ...current, assetId: v }))}
                    />

                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Min Amount</span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={flowFilters.minAmount}
                          onChange={(e) => setFlowFilters((current) => ({ ...current, minAmount: e.target.value }))}
                          placeholder="0"
                          className="w-full rounded border border-border/50 bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary/60 focus:outline-none"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">Max Amount</span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          value={flowFilters.maxAmount}
                          onChange={(e) => setFlowFilters((current) => ({ ...current, maxAmount: e.target.value }))}
                          placeholder="∞"
                          className="w-full rounded border border-border/50 bg-background px-2 py-1.5 font-mono text-[10px] text-foreground focus:border-primary/60 focus:outline-none"
                        />
                      </label>
                    </div>
                  </div>
                )}

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
                    {/* Counterparty search */}
                    <div className="flex-none border-b border-border/40 px-3 py-1.5">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40" />
                        <input
                          type="text"
                          value={cpSearch}
                          onChange={(e) => setCpSearch(e.target.value)}
                          placeholder="Search counterparties..."
                          className="w-full rounded border border-border/50 bg-background pl-7 pr-2 py-1 font-mono text-[10px] text-foreground placeholder:text-muted-foreground/40 focus:border-primary/60 focus:outline-none"
                        />
                      </div>
                    </div>
                    <FlowGroup
                      title="Outflow →"
                      color="#ffb800"
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
                      domainMap={domainMap}
                      searchQuery={cpSearch}
                    />
                    <FlowGroup
                      title="← Inflow"
                      color="#00d4ff"
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
                      domainMap={domainMap}
                      searchQuery={cpSearch}
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
  domainMap,
  searchQuery = "",
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
  domainMap: Map<string, string>;
  searchQuery?: string;
}) {
  const [sortKey, setSortKey] = useState<CpSortKey | null>(null);
  const [sortDir, setSortDir] = useState<CpSortDir>("desc");

  const handleSort = (key: CpSortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setSortDir("desc");
  };

  const sorted = useMemo(() => {
    if (!sortKey) return counterparties;
    const mult = sortDir === "desc" ? -1 : 1;
    return [...counterparties].sort((a, b) => {
      switch (sortKey) {
        case "name": {
          const aName = (a.label ?? domainMap.get(a.address) ?? a.address).toLowerCase();
          const bName = (b.label ?? domainMap.get(b.address) ?? b.address).toLowerCase();
          return mult * aName.localeCompare(bName);
        }
        case "txs":
          return mult * (getDirectionalTxCount(a, direction) - getDirectionalTxCount(b, direction));
        case "lastSeen":
          return mult * ((a.lastSeen ?? 0) - (b.lastSeen ?? 0));
        default:
          return 0;
      }
    });
  }, [counterparties, sortKey, sortDir, direction, domainMap]);

  const displayed = useMemo(() => {
    if (!searchQuery) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((cp) => {
      const label = cp.label?.toLowerCase() ?? "";
      const addr = cp.address.toLowerCase();
      const domain = domainMap.get(cp.address)?.toLowerCase() ?? "";
      return label.includes(q) || addr.includes(q) || domain.includes(q);
    });
  }, [sorted, searchQuery, domainMap]);

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
              {searchQuery && displayed.length !== counterparties.length
                ? `${displayed.length}/${counterparties.length}`
                : counterparties.length} cps · {transferCount} flows
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
        displayed.length === 0 ? (
          <div className="px-3 py-2">
            <span className="font-mono text-[9px] text-muted-foreground/50">{searchQuery ? "No matches" : "None"}</span>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-[29px] z-[9] bg-card">
              <TableRow className="border-border/40">
                <TableHead className={`${TH} h-6 cursor-pointer select-none px-3`} onClick={() => handleSort("name")}>
                  Name <CpSortIcon col="name" sortKey={sortKey} sortDir={sortDir} />
                </TableHead>
                <TableHead className={`${TH} h-6 cursor-pointer select-none text-right`} onClick={() => handleSort("txs")}>
                  Txs <CpSortIcon col="txs" sortKey={sortKey} sortDir={sortDir} />
                </TableHead>
                <TableHead className={`${TH} h-6 cursor-pointer select-none text-right`} onClick={() => handleSort("lastSeen")}>
                  Last <CpSortIcon col="lastSeen" sortKey={sortKey} sortDir={sortDir} />
                </TableHead>
                <TableHead className={`${TH} h-6 w-20 text-center`}>Add to graph</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayed.map((cp) => {
                const isAdded = direction === "outflow"
                  ? graphEdges.has(`${selectedAddress}:${cp.address}`)
                  : graphEdges.has(`${cp.address}:${selectedAddress}`);
                return (
                  <CpTableRow
                    key={cp.address}
                    cp={cp}
                    direction={direction}
                    color={color}
                    isAdded={isAdded}
                    onAdd={() => onAddOne(cp)}
                    domainMap={domainMap}
                  />
                );
              })}
            </TableBody>
          </Table>
        )
      )}
    </div>
  );
}

function CpTableRow({
  cp,
  direction,
  color,
  isAdded,
  onAdd,
  domainMap,
}: {
  cp: TraceCounterparty;
  direction: TraceDirection;
  color: string;
  isAdded: boolean;
  onAdd: () => void;
  domainMap: Map<string, string>;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const assets = getDirectionalAssets(cp, direction);
  const txCount = getDirectionalTxCount(cp, direction);
  const displayLabel = cp.label ?? domainMap.get(cp.address);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cp.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <TableRow
        className="table-row-hover border-border/20 cursor-pointer"
        style={{ opacity: isAdded ? 0.4 : 1 }}
        onClick={() => setExpanded((v) => !v)}
      >
        <TableCell className="px-3 py-1.5 max-w-[160px] group/name">
          <div className="flex items-center gap-1.5">
            <ChevronRight className={`h-2.5 w-2.5 shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`} />
            <div className="min-w-0">
              {displayLabel ? (
                <>
                  <div className="truncate font-mono text-[9px] font-bold text-foreground">{displayLabel}</div>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[8px] text-muted-foreground/50">{truncAddr(cp.address)}</span>
                    <button
                      onClick={handleCopy}
                      className="shrink-0 opacity-0 group-hover/name:opacity-100 transition-opacity cursor-pointer text-muted-foreground/40 hover:text-primary"
                      title="Copy address"
                    >
                      {copied
                        ? <Check className="h-2.5 w-2.5 text-green-500" />
                        : <Copy className="h-2.5 w-2.5" />}
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1">
                  <span className="font-mono text-[9px] text-muted-foreground truncate">{truncAddr(cp.address)}</span>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 opacity-0 group-hover/name:opacity-100 transition-opacity cursor-pointer text-muted-foreground/40 hover:text-primary"
                    title="Copy address"
                  >
                    {copied
                      ? <Check className="h-2.5 w-2.5 text-green-500" />
                      : <Copy className="h-2.5 w-2.5" />}
                  </button>
                </div>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="py-1.5 text-right">
          <span className="font-mono text-[9px] text-muted-foreground">{txCount}</span>
        </TableCell>
        <TableCell className="py-1.5 text-right">
          <span className="font-mono text-[9px] text-muted-foreground">{formatCompactDate(cp.lastSeen)}</span>
        </TableCell>
        <TableCell className="w-20 py-1.5 text-center">
          {!isAdded ? (
            <button
              onClick={(e) => { e.stopPropagation(); onAdd(); }}
              className="font-mono text-[11px] leading-none text-primary hover:text-primary-foreground hover:bg-primary/80 cursor-pointer px-2 py-1 rounded border border-primary/30 hover:border-primary transition-colors"
            >
              +
            </button>
          ) : (
            <span className="font-mono text-[7px] text-muted-foreground/40">added</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && assets.length > 0 && (
        <TableRow className="border-border/10">
          <TableCell colSpan={4} className="px-3 py-1.5 pl-8">
            <div className="space-y-1">
              {assets.map((asset) => (
                <div key={asset.assetId} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[8px] text-muted-foreground/70">{assetTicker(asset)}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[8px]" style={{ color }}>{fmtCompact(asset.uiAmount)}</span>
                    <span className="font-mono text-[8px] text-muted-foreground/50">{asset.txCount} tx</span>
                  </div>
                </div>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
