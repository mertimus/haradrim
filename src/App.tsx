import { startTransition, useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import { SearchBar } from "@/components/SearchBar";
import { WalletProfile } from "@/components/WalletProfile";
import { CounterpartyTable, sortCounterparties } from "@/components/CounterpartyTable";
import type {
  CounterpartyDisplay,
  TimeRange,
  CounterpartySortKey,
  CounterpartySortDir,
} from "@/components/CounterpartyTable";
import { CounterpartyDetailPanel } from "@/components/CounterpartyDetailPanel";
import type { SelectedCounterpartyDetail } from "@/components/CounterpartyDetailPanel";
import { TransactionGraph } from "@/components/TransactionGraph";
import { WalletOverlayPanel } from "@/components/WalletOverlayPanel";
import { WalletInsightsStrip } from "@/components/WalletInsightsStrip";
import type { WalletInsight } from "@/components/WalletInsightsStrip";
import { TokenExplorer } from "@/components/TokenExplorer";
import { TimeRelapse } from "@/components/TimeRelapse";
import { TraceExplorer } from "@/components/TraceExplorer";
import {
  getTransactions,
  getTransactionsWithProgress,
  getIdentity,
  getBalances,
  getFunding,
} from "@/api";
import type { WalletIdentity, WalletBalances, FundingSource, RpcTransaction } from "@/api";
import { enrichCounterparties } from "@/lib/enrich";
import {
  parseTransactions,
  createWalletParseAccumulator,
  accumulateWalletParseResult,
  finalizeWalletParseAccumulator,
  buildGraphData,
  buildMergedGraphData,
  countSharedCounterparties,
  getWalletColor,
  projectCounterpartiesForGraphFlow,
} from "@/lib/parse-transactions";
import type {
  CounterpartyFlow,
  OverlayWallet,
  GraphOverrides,
  GraphFlowFilter,
} from "@/lib/parse-transactions";

export interface WalletFilter {
  minVolume: number;
  minTxCount: number;
  netThreshold: number; // 0 = show all, >0 = only inflows >= threshold, <0 = only outflows <= threshold
}

export interface GraphTypeFilter {
  wallet: boolean;
  token: boolean;
  program: boolean;
}

export type GraphPreset =
  | "overview"
  | "outflows"
  | "inflows"
  | "mutuals"
  | "active30d"
  | "new30d";

type GraphScopeFilter = "all" | "mutuals" | "active30d" | "new30d";

export interface WalletStats {
  maxVolume: number;
  maxTxCount: number;
  minNet: number;  // most negative solNet across counterparties
  maxNet: number;  // most positive solNet across counterparties
  totalCount: number;
  filteredCount: number;
}

const THIRTY_DAY_WINDOW_SECONDS = 30 * 86400;

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function describeCounterparty(cp: CounterpartyFlow): string {
  return cp.label ?? cp.tokenSymbol ?? cp.tokenName ?? truncAddr(cp.address);
}

function describeWallet(address: string, identity: WalletIdentity | null | undefined): string {
  return identity?.label ?? identity?.name ?? truncAddr(address);
}

function formatSolCompact(sol: number): string {
  if (Math.abs(sol) < 0.001) return "<0.001 SOL";
  if (Math.abs(sol) >= 1000) {
    return `${sol.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL`;
  }
  return `${sol.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} SOL`;
}

function formatDateCompact(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function filterCounterpartiesByGraphScope(
  counterparties: CounterpartyFlow[],
  scope: GraphScopeFilter,
  sharedAddresses: Set<string>,
  nowTs: number,
): CounterpartyFlow[] {
  if (scope === "all") return counterparties;
  if (scope === "mutuals") {
    return counterparties.filter((cp) => sharedAddresses.has(cp.address));
  }
  if (scope === "active30d") {
    const cutoff = nowTs - THIRTY_DAY_WINDOW_SECONDS;
    return counterparties.filter((cp) => cp.lastSeen >= cutoff);
  }
  const cutoff = nowTs - THIRTY_DAY_WINDOW_SECONDS;
  return counterparties.filter((cp) => cp.firstSeen >= cutoff);
}

function sortCounterpartiesByTableOrder<T extends CounterpartyFlow>(
  counterparties: T[],
  rankByAddress: Map<string, number>,
): T[] {
  return [...counterparties].sort((a, b) => {
    const rankA = rankByAddress.get(a.address) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rankByAddress.get(b.address) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

function mergeDisplayCounterparties(
  filteredCounterparties: CounterpartyFlow[],
  filteredOverlayWallets: OverlayWallet[],
  address: string,
  walletColors: string[],
): CounterpartyDisplay[] {
  const readyOverlays = filteredOverlayWallets.filter((ow) => !ow.loading && !ow.error);
  if (readyOverlays.length === 0) {
    return filteredCounterparties.map((cp) => ({
      ...cp,
      walletColors: [walletColors[0]],
    }));
  }

  const hubAddresses = new Set([address, ...readyOverlays.map((overlay) => overlay.address)]);
  const merged = new Map<
    string,
    CounterpartyDisplay & { sourceIndices: number[] }
  >();

  for (const cp of filteredCounterparties) {
    if (hubAddresses.has(cp.address)) continue;
    merged.set(cp.address, { ...cp, sourceIndices: [0], walletColors: [] });
  }

  for (let i = 0; i < readyOverlays.length; i++) {
    const overlay = readyOverlays[i];
    const colorIdx = i + 1;
    for (const cp of overlay.counterparties) {
      if (hubAddresses.has(cp.address)) continue;
      const existing = merged.get(cp.address);
      if (existing) {
        existing.txCount += cp.txCount;
        existing.solSent += cp.solSent;
        existing.solReceived += cp.solReceived;
        existing.solNet = existing.solReceived - existing.solSent;
        existing.firstSeen = Math.min(existing.firstSeen, cp.firstSeen);
        existing.lastSeen = Math.max(existing.lastSeen, cp.lastSeen);
        if (!existing.label && cp.label) existing.label = cp.label;
        if (!existing.sourceIndices.includes(colorIdx)) {
          existing.sourceIndices.push(colorIdx);
        }
      } else {
        merged.set(cp.address, {
          ...cp,
          sourceIndices: [colorIdx],
          walletColors: [],
        });
      }
    }
  }

  return Array.from(merged.values()).map((cp) => ({
    ...cp,
    walletColors: cp.sourceIndices.map((index) => walletColors[index]),
  }));
}

function getAddressFromUrl(): string {
  // Support both /wallet/:addr and ?address= (legacy)
  const pathMatch = window.location.pathname.match(/^\/wallet\/([A-Za-z0-9]+)$/);
  if (pathMatch) return pathMatch[1];
  const params = new URLSearchParams(window.location.search);
  return params.get("address") ?? "";
}

function setAddressInUrl(address: string) {
  window.history.pushState({}, "", `/wallet/${address}`);
}

function getModeFromUrl(): AppMode {
  if (window.location.pathname.startsWith("/token")) return "tokens";
  if (window.location.pathname.startsWith("/trace")) return "trace";
  return "wallet";
}

function getTraceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/trace\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

export type AppMode = "wallet" | "tokens" | "programs" | "trace";

export default function App() {
  const [mode, setMode] = useState<AppMode>(getModeFromUrl);
  const [address, setAddress] = useState(getAddressFromUrl);
  const [loading, setLoading] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [fundingLoading, setFundingLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);

  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [funding, setFunding] = useState<FundingSource | null>(null);
  const [counterparties, setCounterparties] = useState<CounterpartyFlow[]>([]);
  const [allTimeCounterparties, setAllTimeCounterparties] = useState<CounterpartyFlow[]>([]);
  const [txCount, setTxCount] = useState(0);
  const [lastBlockTime, setLastBlockTime] = useState(0);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [overlayWallets, setOverlayWallets] = useState<OverlayWallet[]>([]);
  const [colorOverrides, setColorOverrides] = useState<Map<number, string>>(new Map());
  const [walletFilters, setWalletFilters] = useState<Map<number, WalletFilter>>(new Map());
  const [graphAdded, setGraphAdded] = useState<Set<string>>(new Set());
  const [graphRemoved, setGraphRemoved] = useState<Set<string>>(new Set());
  const [graphTypeFilter, setGraphTypeFilter] = useState<GraphTypeFilter>({ wallet: true, token: false, program: false });
  const [graphFlowFilter, setGraphFlowFilter] = useState<GraphFlowFilter>("all");
  const [graphScopeFilter, setGraphScopeFilter] = useState<GraphScopeFilter>("all");
  const [graphNodeBudget, setGraphNodeBudget] = useState(50);
  const [selectedCounterpartyAddress, setSelectedCounterpartyAddress] = useState<string | null>(null);
  const [tableSortKey, setTableSortKey] = useState<CounterpartySortKey | null>(null);
  const [tableSortDir, setTableSortDir] = useState<CounterpartySortDir>("desc");
  const [timeRange, setTimeRange] = useState<TimeRange>({ start: null, end: null });
  const rawTxsRef = useRef<RpcTransaction[]>([]);
  const allTimeCounterpartiesRef = useRef<CounterpartyFlow[]>([]);
  const lookupRequestIdRef = useRef(0);

  // Ref-based hover highlight — no React re-renders, pure DOM manipulation
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

  // Build wallet colors array based on current overlay count
  const walletColors = useMemo(() => {
    const count = overlayWallets.length + 1; // +1 for primary
    return Array.from({ length: count }, (_, i) => getWalletColor(i, colorOverrides));
  }, [overlayWallets.length, colorOverrides]);

  // Filter counterparties by per-wallet volume, tx count, and net flow thresholds
  const filteredCounterparties = useMemo(() => {
    const f = walletFilters.get(0);
    if (!f) return counterparties;
    return counterparties.filter(cp =>
      (f.minVolume <= 0 || cp.solSent + cp.solReceived >= f.minVolume) &&
      (f.minTxCount <= 0 || cp.txCount >= f.minTxCount) &&
      (f.netThreshold === 0 || (f.netThreshold > 0 ? cp.solNet >= f.netThreshold : cp.solNet <= f.netThreshold))
    );
  }, [counterparties, walletFilters]);

  const directionalGraphCounterparties = useMemo(
    () => projectCounterpartiesForGraphFlow(filteredCounterparties, graphFlowFilter),
    [filteredCounterparties, graphFlowFilter],
  );

  // Apply graph account-type filter on top of volume/tx/net/direction filters
  const graphCounterparties = useMemo(() => {
    const { wallet, token, program } = graphTypeFilter;
    if (wallet && token && program) return directionalGraphCounterparties;
    return directionalGraphCounterparties.filter(cp => {
      const t = cp.accountType;
      if (t === "wallet" || !t) return wallet;
      if (t === "token") return token;
      if (t === "program") return program;
      return wallet; // "other"/"unknown" grouped with wallets
    });
  }, [directionalGraphCounterparties, graphTypeFilter]);

  // Per-wallet stats for slider ranges and counts
  const walletStats = useMemo((): WalletStats[] => {
    function computeStats(cps: CounterpartyFlow[], f: WalletFilter | undefined): WalletStats {
      let maxVol = 0, maxTx = 0, minN = 0, maxN = 0;
      for (const cp of cps) {
        maxVol = Math.max(maxVol, cp.solSent + cp.solReceived);
        maxTx = Math.max(maxTx, cp.txCount);
        minN = Math.min(minN, cp.solNet);
        maxN = Math.max(maxN, cp.solNet);
      }
      const filteredCount = f
        ? cps.filter(cp =>
            (f.minVolume <= 0 || cp.solSent + cp.solReceived >= f.minVolume) &&
            (f.minTxCount <= 0 || cp.txCount >= f.minTxCount) &&
            (f.netThreshold === 0 || (f.netThreshold > 0 ? cp.solNet >= f.netThreshold : cp.solNet <= f.netThreshold))
          ).length
        : cps.length;
      return { maxVolume: maxVol, maxTxCount: maxTx, minNet: minN, maxNet: maxN, totalCount: cps.length, filteredCount };
    }

    const stats: WalletStats[] = [computeStats(counterparties, walletFilters.get(0))];
    for (let i = 0; i < overlayWallets.length; i++) {
      stats.push(computeStats(overlayWallets[i].counterparties, walletFilters.get(i + 1)));
    }
    return stats;
  }, [counterparties, overlayWallets, walletFilters]);

  const handleColorChange = useCallback((walletIndex: number, color: string) => {
    setColorOverrides((prev) => {
      const next = new Map(prev);
      next.set(walletIndex, color);
      return next;
    });
  }, []);

  const handleWalletFilterChange = useCallback((walletIndex: number, filter: WalletFilter) => {
    setWalletFilters(prev => {
      const next = new Map(prev);
      next.set(walletIndex, filter);
      return next;
    });
  }, []);

  const handleGraphFlowFilterChange = useCallback((filter: GraphFlowFilter) => {
    setGraphFlowFilter(filter);
  }, []);

  const handleTableSortChange = useCallback(
    (sortKey: CounterpartySortKey | null, sortDir: CounterpartySortDir) => {
      setTableSortKey(sortKey);
      setTableSortDir(sortDir);
    },
    [],
  );

  const handleGraphPresetChange = useCallback((preset: GraphPreset) => {
    switch (preset) {
      case "overview":
        setGraphFlowFilter("all");
        setGraphScopeFilter("all");
        break;
      case "outflows":
        setGraphFlowFilter("outflow");
        setGraphScopeFilter("all");
        break;
      case "inflows":
        setGraphFlowFilter("inflow");
        setGraphScopeFilter("all");
        break;
      case "mutuals":
        setGraphFlowFilter("all");
        setGraphScopeFilter("mutuals");
        break;
      case "active30d":
        setGraphFlowFilter("all");
        setGraphScopeFilter("active30d");
        break;
      case "new30d":
        setGraphFlowFilter("all");
        setGraphScopeFilter("new30d");
        break;
    }
  }, []);

  // Compute graph overrides object
  const graphOverrides = useMemo((): GraphOverrides | undefined => {
    if (graphAdded.size === 0 && graphRemoved.size === 0) return undefined;
    return { added: graphAdded, removed: graphRemoved };
  }, [graphAdded, graphRemoved]);

  // Compute which addresses are currently in the graph
  const graphAddresses = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);

  // Handlers for add/remove graph nodes
  const handleGraphAddNode = useCallback((addr: string) => {
    setGraphAdded(prev => { const next = new Set(prev); next.add(addr); return next; });
    setGraphRemoved(prev => { const next = new Set(prev); next.delete(addr); return next; });
  }, []);

  const handleGraphRemoveNode = useCallback((addr: string) => {
    setGraphRemoved(prev => { const next = new Set(prev); next.add(addr); return next; });
    setGraphAdded(prev => { const next = new Set(prev); next.delete(addr); return next; });
  }, []);

  // Filter overlay counterparties by per-wallet volume, tx count, and net flow thresholds
  const filteredOverlayWallets = useMemo(() => {
    return overlayWallets.map((ow, i) => {
      const f = walletFilters.get(i + 1);
      if (!f) return ow;
      return {
        ...ow,
        counterparties: ow.counterparties.filter(cp =>
          (f.minVolume <= 0 || cp.solSent + cp.solReceived >= f.minVolume) &&
          (f.minTxCount <= 0 || cp.txCount >= f.minTxCount) &&
          (f.netThreshold === 0 || (f.netThreshold > 0 ? cp.solNet >= f.netThreshold : cp.solNet <= f.netThreshold))
        ),
      };
    });
  }, [overlayWallets, walletFilters]);

  const mergedCounterparties = useMemo(
    () => mergeDisplayCounterparties(filteredCounterparties, filteredOverlayWallets, address, walletColors),
    [filteredCounterparties, filteredOverlayWallets, address, walletColors],
  );

  const sortedMergedCounterparties = useMemo(
    () => sortCounterparties(mergedCounterparties, tableSortKey, tableSortDir),
    [mergedCounterparties, tableSortKey, tableSortDir],
  );

  const graphRankByAddress = useMemo(() => {
    const rank = new Map<string, number>();
    sortedMergedCounterparties.forEach((cp, index) => {
      rank.set(cp.address, index);
    });
    return rank;
  }, [sortedMergedCounterparties]);

  const directionalOverlayWallets = useMemo(
    () => filteredOverlayWallets.map((ow) => ({
      ...ow,
      counterparties: projectCounterpartiesForGraphFlow(ow.counterparties, graphFlowFilter),
    })),
    [filteredOverlayWallets, graphFlowFilter],
  );

  // Apply graph account-type filter to overlays
  const graphOverlayWallets = useMemo(() => {
    const { wallet, token, program } = graphTypeFilter;
    if (wallet && token && program) return directionalOverlayWallets;
    return directionalOverlayWallets.map(ow => ({
      ...ow,
      counterparties: ow.counterparties.filter(cp => {
        const t = cp.accountType;
        if (t === "wallet" || !t) return wallet;
        if (t === "token") return token;
        if (t === "program") return program;
        return wallet;
      }),
    }));
  }, [directionalOverlayWallets, graphTypeFilter]);

  const graphSourceCounterparties = graphCounterparties;
  const graphSourceOverlayWallets = graphOverlayWallets;
  const graphScopeNowTs = useMemo(() => Math.floor(Date.now() / 1000), [graphScopeFilter]);

  const sharedGraphAddresses = useMemo(() => {
    const counts = new Map<string, number>();
    const readyOverlays = graphSourceOverlayWallets.filter((ow) => !ow.loading && !ow.error);

    for (const cp of graphSourceCounterparties) {
      counts.set(cp.address, 1);
    }

    for (const ow of readyOverlays) {
      const seen = new Set<string>();
      for (const cp of ow.counterparties) {
        seen.add(cp.address);
      }
      for (const address of seen) {
        counts.set(address, (counts.get(address) ?? 0) + 1);
      }
    }

    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([address]) => address),
    );
  }, [graphSourceCounterparties, graphSourceOverlayWallets]);

  const scopedGraphCounterparties = useMemo(
    () => filterCounterpartiesByGraphScope(
      graphSourceCounterparties,
      graphScopeFilter,
      sharedGraphAddresses,
      graphScopeNowTs,
    ),
    [graphSourceCounterparties, graphScopeFilter, sharedGraphAddresses, graphScopeNowTs],
  );

  const scopedGraphOverlayWallets = useMemo(
    () => graphSourceOverlayWallets.map((ow) => ({
      ...ow,
      counterparties: filterCounterpartiesByGraphScope(
        ow.counterparties,
        graphScopeFilter,
        sharedGraphAddresses,
        graphScopeNowTs,
      ),
    })),
    [graphSourceOverlayWallets, graphScopeFilter, sharedGraphAddresses, graphScopeNowTs],
  );

  const rankedGraphCounterparties = useMemo(
    () => sortCounterpartiesByTableOrder(scopedGraphCounterparties, graphRankByAddress),
    [scopedGraphCounterparties, graphRankByAddress],
  );

  const rankedGraphOverlayWallets = useMemo(
    () => scopedGraphOverlayWallets.map((ow) => ({
      ...ow,
      counterparties: sortCounterpartiesByTableOrder(ow.counterparties, graphRankByAddress),
    })),
    [scopedGraphOverlayWallets, graphRankByAddress],
  );

  const readyGraphWallets = useMemo(() => {
    const readyOverlays = rankedGraphOverlayWallets.filter((ow) => !ow.loading && !ow.error);
    return [
      { address, counterparties: rankedGraphCounterparties },
      ...readyOverlays.map((ow) => ({
        address: ow.address,
        counterparties: ow.counterparties,
      })),
    ];
  }, [address, rankedGraphCounterparties, rankedGraphOverlayWallets]);

  const minGraphNodeBudget = useMemo(
    () => countSharedCounterparties(readyGraphWallets),
    [readyGraphWallets],
  );

  const effectiveGraphNodeBudget = Math.max(graphNodeBudget, minGraphNodeBudget);

  useEffect(() => {
    if (graphNodeBudget < minGraphNodeBudget) {
      setGraphNodeBudget(minGraphNodeBudget);
    }
  }, [graphNodeBudget, minGraphNodeBudget]);

  // Rebuild graph when overlays change
  useEffect(() => {
    if (!address) return;
    if (rankedGraphCounterparties.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNodes([]);
      setEdges([]);
      return;
    }

    const readyOverlays = rankedGraphOverlayWallets.filter((ow) => !ow.loading && !ow.error);

    if (readyOverlays.length === 0) {
      // Single wallet mode
      const graphData = buildGraphData(address, rankedGraphCounterparties, identity, graphOverrides, effectiveGraphNodeBudget);
      setNodes(graphData.nodes);
      setEdges(graphData.edges);
      return;
    }

    // Multi-wallet mode
    const wallets = [
      { address, counterparties: scopedGraphCounterparties, identity },
      ...readyOverlays.map((ow) => ({
        address: ow.address,
        counterparties: ow.counterparties,
        identity: ow.identity,
      })),
    ];
    const graphData = buildMergedGraphData(
      wallets,
      walletColors,
      graphOverrides,
      effectiveGraphNodeBudget,
      graphRankByAddress,
    );
    setNodes(graphData.nodes);
    setEdges(graphData.edges);
  }, [
    address,
    rankedGraphCounterparties,
    identity,
    rankedGraphOverlayWallets,
    walletColors,
    graphOverrides,
    effectiveGraphNodeBudget,
    graphRankByAddress,
  ]);

  // Merged counterparty table data
  const comparisonWallets = useMemo(() => {
    const readyOverlays = filteredOverlayWallets.filter((ow) => !ow.loading && !ow.error);
    return [
      {
        address,
        label: describeWallet(address, identity),
        color: walletColors[0],
        role: "Primary" as const,
        counterparties: filteredCounterparties,
      },
      ...readyOverlays.map((ow, index) => ({
        address: ow.address,
        label: describeWallet(ow.address, ow.identity),
        color: walletColors[index + 1],
        role: "Overlay" as const,
        counterparties: ow.counterparties,
      })),
    ];
  }, [address, filteredCounterparties, filteredOverlayWallets, identity, walletColors]);

  const sharedComparisonCount = useMemo(
    () => countSharedCounterparties(
      comparisonWallets.map((wallet) => ({
        address: wallet.address,
        counterparties: wallet.counterparties,
      })),
    ),
    [comparisonWallets],
  );

  const strongestSharedCounterparty = useMemo(
    () => mergedCounterparties
      .filter((cp) => (cp.walletColors?.length ?? 0) > 1)
      .sort((a, b) => {
        const volumeDiff = (b.solSent + b.solReceived) - (a.solSent + a.solReceived);
        if (volumeDiff !== 0) return volumeDiff;
        return b.txCount - a.txCount;
      })[0] ?? null,
    [mergedCounterparties],
  );

  const walletInsights = useMemo((): WalletInsight[] => {
    const historicalCounterparties = allTimeCounterparties.length > 0 ? allTimeCounterparties : filteredCounterparties;
    const byOutflow = filteredCounterparties
      .filter((cp) => cp.solSent > 0)
      .sort((a, b) => b.solSent - a.solSent)[0];
    const byInflow = filteredCounterparties
      .filter((cp) => cp.solReceived > 0)
      .sort((a, b) => b.solReceived - a.solReceived)[0];
    const byOldest = historicalCounterparties
      .filter((cp) => cp.firstSeen > 0)
      .sort((a, b) => a.firstSeen - b.firstSeen)[0];
    const byNewest = historicalCounterparties
      .filter((cp) => cp.firstSeen > 0)
      .sort((a, b) => b.firstSeen - a.firstSeen)[0];

    return [
      byOutflow
        ? {
            id: "largest-outflow",
            title: "Largest Outflow",
            value: describeCounterparty(byOutflow),
            description: `${formatSolCompact(byOutflow.solSent)} sent across ${byOutflow.txCount.toLocaleString()} tx`,
            accentColor: "#ff2d2d",
            address: byOutflow.address,
            preset: "outflows",
          }
        : {
            id: "largest-outflow",
            title: "Largest Outflow",
            value: "No direct outflows",
            description: "Nothing in the current wallet view has outgoing volume.",
            accentColor: "#ff2d2d",
            preset: "outflows",
          },
      byInflow
        ? {
            id: "largest-inflow",
            title: "Largest Inflow",
            value: describeCounterparty(byInflow),
            description: `${formatSolCompact(byInflow.solReceived)} received across ${byInflow.txCount.toLocaleString()} tx`,
            accentColor: "#00ff88",
            address: byInflow.address,
            preset: "inflows",
          }
        : {
            id: "largest-inflow",
            title: "Largest Inflow",
            value: "No direct inflows",
            description: "Nothing in the current wallet view has incoming volume.",
            accentColor: "#00ff88",
            preset: "inflows",
          },
      sharedComparisonCount > 0 && strongestSharedCounterparty
        ? {
            id: "mutual-overlap",
            title: "Mutual Overlap",
            value: `${sharedComparisonCount.toLocaleString()} shared`,
            description: `Strongest overlap: ${describeCounterparty(strongestSharedCounterparty)}`,
            accentColor: "#00d4ff",
            address: strongestSharedCounterparty.address,
            preset: "mutuals",
          }
        : byOldest
          ? {
              id: "oldest-relationship",
              title: "Oldest Relationship",
              value: describeCounterparty(byOldest),
              description: `Active since ${formatDateCompact(byOldest.firstSeen)}`,
              accentColor: "#ffb800",
              address: byOldest.address,
            }
          : {
              id: "oldest-relationship",
              title: "Oldest Relationship",
              value: "No history yet",
              description: "The current view has no dated counterparties.",
              accentColor: "#ffb800",
            },
      byNewest
        ? {
            id: "newest-counterparty",
            title: "Newest Counterparty",
            value: describeCounterparty(byNewest),
            description: `First seen ${formatDateCompact(byNewest.firstSeen)}`,
            accentColor: "#a855f7",
            address: byNewest.address,
            preset: "new30d",
          }
        : {
            id: "newest-counterparty",
            title: "Newest Counterparty",
            value: "No new counterparties",
            description: "No counterparties are available in the current view.",
            accentColor: "#a855f7",
            preset: "new30d",
          },
    ];
  }, [allTimeCounterparties, filteredCounterparties, sharedComparisonCount, strongestSharedCounterparty]);

  const selectedCounterpartyDetail = useMemo((): SelectedCounterpartyDetail | null => {
    if (!selectedCounterpartyAddress) return null;
    const cp = mergedCounterparties.find((counterparty) => counterparty.address === selectedCounterpartyAddress);
    if (!cp) return null;

    const connectedWallets = comparisonWallets
      .filter((wallet) => wallet.counterparties.some((counterparty) => counterparty.address === cp.address))
      .map((wallet) => ({
        address: wallet.address,
        label: wallet.label,
        color: wallet.color,
        role: wallet.role,
      }));

    return {
      address: cp.address,
      label: cp.label,
      category: cp.category,
      accountType: cp.accountType,
      tokenName: cp.tokenName,
      tokenSymbol: cp.tokenSymbol,
      txCount: cp.txCount,
      solSent: cp.solSent,
      solReceived: cp.solReceived,
      solNet: cp.solNet,
      firstSeen: cp.firstSeen,
      lastSeen: cp.lastSeen,
      connectedWallets,
    };
  }, [comparisonWallets, mergedCounterparties, selectedCounterpartyAddress]);

  useEffect(() => {
    if (sortedMergedCounterparties.length === 0) {
      if (selectedCounterpartyAddress != null) setSelectedCounterpartyAddress(null);
      return;
    }
    if (!selectedCounterpartyAddress || !sortedMergedCounterparties.some((cp) => cp.address === selectedCounterpartyAddress)) {
      setSelectedCounterpartyAddress(sortedMergedCounterparties[0].address);
    }
  }, [sortedMergedCounterparties, selectedCounterpartyAddress]);

  const lookup = useCallback(async (addr: string) => {
    if (!addr) return;
    const rid = ++lookupRequestIdRef.current;

    setLoading(true);
    setIdentityLoading(true);
    setBalancesLoading(true);
    setFundingLoading(true);
    setGraphLoading(true);
    setTableLoading(true);
    setIdentity(null);
    setBalances(null);
    setFunding(null);
    setCounterparties([]);
    setAllTimeCounterparties([]);
    setTxCount(0);
    setLastBlockTime(0);
    setNodes([]);
    setEdges([]);
    setOverlayWallets([]);
    setColorOverrides(new Map());
    setWalletFilters(new Map());
    setGraphAdded(new Set());
    setGraphRemoved(new Set());
    setGraphTypeFilter({ wallet: true, token: false, program: false });
    setGraphFlowFilter("all");
    setGraphScopeFilter("all");
    setTimeRange({ start: null, end: null });
    setSelectedCounterpartyAddress(null);
    rawTxsRef.current = [];
    allTimeCounterpartiesRef.current = [];

    void getIdentity(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setIdentity(result);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setIdentity(null);
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setIdentityLoading(false);
      });

    void getBalances(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setBalances(result);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setBalances(null);
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setBalancesLoading(false);
      });

    void getFunding(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setFunding(result);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setFunding(null);
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setFundingLoading(false);
      });

    const accumulator = createWalletParseAccumulator();
    const seenSignatures = new Set<string>();
    const uniqueTxs: RpcTransaction[] = [];
    let maxBlockTime = 0;
    let lastCommitMs = 0;
    let surfacedFirstResult = false;

    const commitPartial = (force = false) => {
      if (rid !== lookupRequestIdRef.current) return;
      const now = performance.now();
      if (!force && now - lastCommitMs < 150) return;
      lastCommitMs = now;

      const partial = finalizeWalletParseAccumulator(accumulator);
      rawTxsRef.current = [...uniqueTxs];
      allTimeCounterpartiesRef.current = partial.counterparties;

      startTransition(() => {
        setAllTimeCounterparties(partial.counterparties);
        setTxCount(uniqueTxs.length);
        setLastBlockTime(maxBlockTime);
        setCounterparties(partial.counterparties);
        setTableLoading(false);
        setGraphLoading(false);
      });
      if (!surfacedFirstResult) {
        surfacedFirstResult = true;
        setLoading(false);
      }
    };

    try {
      const txs = await getTransactionsWithProgress(addr, (sliceTxs: RpcTransaction[]) => {
        if (rid !== lookupRequestIdRef.current) return;

        const uniqueSlice: RpcTransaction[] = [];
        for (const tx of sliceTxs) {
          const signature = tx.transaction.signatures[0];
          if (!signature || seenSignatures.has(signature)) continue;
          seenSignatures.add(signature);
          uniqueSlice.push(tx);
          maxBlockTime = Math.max(maxBlockTime, tx.blockTime ?? 0);
        }

        if (uniqueSlice.length === 0) return;
        uniqueTxs.push(...uniqueSlice);
        accumulateWalletParseResult(accumulator, uniqueSlice, addr);
        commitPartial();
      });

      if (rid !== lookupRequestIdRef.current) return;

      if (accumulator.seenSignatures.size !== txs.length) {
        accumulateWalletParseResult(accumulator, txs, addr);
        maxBlockTime = txs.reduce(
          (max: number, tx: RpcTransaction) => Math.max(max, tx.blockTime ?? 0),
          maxBlockTime,
        );
      }

      rawTxsRef.current = txs;
      const parsed = finalizeWalletParseAccumulator(accumulator);
      allTimeCounterpartiesRef.current = parsed.counterparties;

      startTransition(() => {
        setAllTimeCounterparties(parsed.counterparties);
        setTxCount(txs.length);
        setLastBlockTime(maxBlockTime);
        setCounterparties(parsed.counterparties);
        setTableLoading(false);
        setGraphLoading(false);
      });

      setLoading(false);

      void enrichCounterparties(parsed.counterparties)
        .then((enriched) => {
          if (rid !== lookupRequestIdRef.current) return;
          allTimeCounterpartiesRef.current = enriched;
          startTransition(() => {
            setAllTimeCounterparties(enriched);
            setCounterparties(enriched);
          });
        })
        .catch((err) => {
          console.error("Wallet enrichment failed:", err);
        });
    } catch (err) {
      if (rid !== lookupRequestIdRef.current) return;
      console.error("Wallet lookup failed:", err);
      setGraphLoading(false);
      setTableLoading(false);
      setLoading(false);
    }
  }, []);

  const handleAddOverlay = useCallback(
    async (overlayAddr: string) => {
      if (overlayAddr === address) return;
      if (overlayWallets.some((ow) => ow.address === overlayAddr)) return;

      // Add loading entry
      const newOverlay: OverlayWallet = {
        address: overlayAddr,
        identity: null,
        counterparties: [],
        loading: true,
      };
      setOverlayWallets((prev) => [...prev, newOverlay]);

      try {
        // Reuse identity already fetched during enrichment instead of a duplicate getIdentity call
        const existingCp = counterparties.find(c => c.address === overlayAddr)
          ?? overlayWallets.flatMap(ow => ow.counterparties).find(c => c.address === overlayAddr);
        const ident: WalletIdentity | null = existingCp?.label
          ? { address: overlayAddr, name: existingCp.label, label: existingCp.label, category: existingCp.category }
          : null;

        const txResult = await getTransactions(overlayAddr);
        const { counterparties: cps } = parseTransactions(txResult, overlayAddr);
        const enriched = await enrichCounterparties(cps);

        setOverlayWallets((prev) =>
          prev.map((ow) =>
            ow.address === overlayAddr
              ? { ...ow, identity: ident, counterparties: enriched, loading: false }
              : ow,
          ),
        );
      } catch {
        setOverlayWallets((prev) =>
          prev.map((ow) =>
            ow.address === overlayAddr
              ? { ...ow, loading: false, error: "Failed" }
              : ow,
          ),
        );
      }
    },
    [address, overlayWallets, counterparties],
  );

  const handleRemoveOverlay = useCallback((overlayAddr: string) => {
    setOverlayWallets((prev) => prev.filter((ow) => ow.address !== overlayAddr));
  }, []);

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range);

    if (range.start == null && range.end == null) {
      // Restore all-time data
      setCounterparties(allTimeCounterpartiesRef.current);
      setTxCount(rawTxsRef.current.length);
      return;
    }

    if (rawTxsRef.current.length === 0) return;

    // Filter raw txs by time range
    const filtered = rawTxsRef.current.filter(tx => {
      const bt = tx.blockTime;
      if (bt == null) return false;
      if (range.start != null && bt < range.start) return false;
      if (range.end != null && bt > range.end) return false;
      return true;
    });

    setTxCount(filtered.length);
    const { counterparties: cps } = parseTransactions(filtered, address);

    // Apply enrichment from all-time data (instant, no API calls)
    const enrichMap = new Map<string, CounterpartyFlow>();
    for (const cp of allTimeCounterpartiesRef.current) {
      enrichMap.set(cp.address, cp);
    }

    const enriched = cps.map(cp => {
      const prev = enrichMap.get(cp.address);
      if (!prev) return cp;
      return {
        ...cp,
        label: prev.label,
        category: prev.category,
        accountType: prev.accountType,
        mint: prev.mint,
        tokenName: prev.tokenName,
        tokenSymbol: prev.tokenSymbol,
        tokenLogoUri: prev.tokenLogoUri,
      };
    }).filter(cp => {
      const label = (cp.label ?? "").toLowerCase();
      if (label.includes("spam") || label.includes("dusting")) return false;
      const totalVol = cp.solSent + cp.solReceived;
      if (cp.txCount >= 3 && totalVol < 0.001) return false;
      return true;
    });

    setCounterparties(enriched);
  }, [address]);

  const handleSearch = useCallback(
    (addr: string) => {
      setAddress(addr);
      setAddressInUrl(addr);
      lookup(addr);
    },
    [lookup],
  );

  const handleNavigate = useCallback(
    (addr: string) => {
      handleSearch(addr);
    },
    [handleSearch],
  );

  useEffect(() => {
    function onPop() {
      // Update mode based on URL path
      setMode(getModeFromUrl());
      const addr = getAddressFromUrl();
      if (addr) {
        setAddress(addr);
        lookup(addr);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [lookup]);

  useEffect(() => {
    const initial = getAddressFromUrl();
    if (initial) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      lookup(initial);
    }
  }, [lookup]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-none border-b border-border bg-card/80 px-3 py-1">
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1.5 cursor-pointer"
            onClick={() => {
              setAddress("");
              setIdentity(null);
              setBalances(null);
              setFunding(null);
              setCounterparties([]);
              setAllTimeCounterparties([]);
              setTxCount(0);
              setLastBlockTime(0);
              setNodes([]);
              setEdges([]);
              setOverlayWallets([]);
              setColorOverrides(new Map());
              setWalletFilters(new Map());
              setGraphAdded(new Set());
              setGraphRemoved(new Set());
              setGraphTypeFilter({ wallet: true, token: false, program: false });
              setGraphFlowFilter("all");
              setGraphScopeFilter("all");
              setTimeRange({ start: null, end: null });
              setSelectedCounterpartyAddress(null);
              rawTxsRef.current = [];
              allTimeCounterpartiesRef.current = [];
              setLoading(false);
              window.history.pushState({}, "", "/");
            }}
          >
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">
              HARADRIM
            </h1>
          </button>
          <div className="h-3 w-px bg-border" />
          <nav className="flex gap-1">
            {(["wallet", "tokens", "trace"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded transition-colors cursor-pointer"
                style={{
                  color: mode === m ? "#00d4ff" : "#6b7b8d",
                  background: mode === m ? "rgba(0, 212, 255, 0.08)" : "transparent",
                }}
              >
                {m}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          <div className="w-full max-w-md">
            <SearchBar onSearch={handleSearch} loading={loading} />
          </div>
        </div>
      </header>

      {mode === "wallet" && (
        <>
          {!address && !loading ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <h2 className="font-mono text-xl font-bold tracking-wider text-primary text-glow-cyan">
                HARADRIM
              </h2>
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Solana Wallet Intelligence
              </p>
              <div className="w-full max-w-md">
                <SearchBar onSearch={handleSearch} loading={loading} />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Top strip: wallet profile as horizontal bar */}
              <div className="flex-none border-b border-border">
                <WalletProfile
                  address={address}
                  identity={identity}
                  balances={balances}
                  funding={funding}
                  loading={identityLoading && balancesLoading && fundingLoading}
                  identityLoading={identityLoading}
                  balancesLoading={balancesLoading}
                  fundingLoading={fundingLoading}
                  counterpartyCount={counterparties.length}
                  txCount={txCount}
                  onNavigate={handleNavigate}
                />
              </div>

              <div className="flex-none border-b border-border">
                <WalletInsightsStrip
                  insights={walletInsights}
                  loading={tableLoading}
                  selectedAddress={selectedCounterpartyAddress}
                  onSelectAddress={setSelectedCounterpartyAddress}
                  onGraphPresetChange={handleGraphPresetChange}
                />
              </div>

              {/* Bottom: graph + table side by side */}
              <div className="flex flex-1 overflow-hidden">
                {/* Graph: takes most of the space */}
                <div ref={graphWrapperRef} className="flex-1 overflow-hidden relative">
                  <TransactionGraph
                    nodes={nodes}
                    edges={edges}
                    loading={graphLoading}
                    onNavigate={handleNavigate}
                    onAddOverlay={handleAddOverlay}
                    onRemoveNode={handleGraphRemoveNode}
                    canAddOverlay={!loading && !!address}
                    selectedAddress={selectedCounterpartyAddress}
                    onSelectAddress={setSelectedCounterpartyAddress}
                  />
                  <TimeRelapse
                    containerRef={graphWrapperRef}
                    counterparties={counterparties}
                    rawTxs={rawTxsRef.current}
                    edges={edges}
                    centerAddress={address}
                  />
                </div>

                {/* Right panel: table + overlay */}
                <div className="w-[420px] flex-none border-l border-border overflow-hidden flex flex-col">
                  <div className="flex-none border-b border-border">
                    <CounterpartyDetailPanel
                      detail={selectedCounterpartyDetail}
                      loading={tableLoading}
                      graphAddresses={graphAddresses}
                      onNavigate={handleNavigate}
                      onAddNode={handleGraphAddNode}
                      onRemoveNode={handleGraphRemoveNode}
                      onAddOverlay={handleAddOverlay}
                    />
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <CounterpartyTable
                      counterparties={sortedMergedCounterparties}
                      loading={tableLoading}
                      onNavigate={handleNavigate}
                      onHoverAddress={handleHoverAddress}
                      selectedAddress={selectedCounterpartyAddress}
                      onSelectAddress={setSelectedCounterpartyAddress}
                      graphAddresses={graphAddresses}
                      onAddNode={handleGraphAddNode}
                      onRemoveNode={handleGraphRemoveNode}
                      onAddOverlay={handleAddOverlay}
                      timeRange={timeRange}
                      onTimeRangeChange={handleTimeRangeChange}
                      graphFlowFilter={graphFlowFilter}
                      onGraphFlowFilterChange={handleGraphFlowFilterChange}
                      sortKey={tableSortKey}
                      sortDir={tableSortDir}
                      onSortChange={handleTableSortChange}
                    />
                  </div>
                  <div className="flex-none border-t border-border">
                    <WalletOverlayPanel
                      primaryAddress={address}
                      primaryIdentity={identity}
                      overlayWallets={overlayWallets}
                      walletColors={walletColors}
                      onAdd={handleAddOverlay}
                      onRemove={handleRemoveOverlay}
                      onColorChange={handleColorChange}
                      disabled={!address}
                      walletFilters={walletFilters}
                      walletStats={walletStats}
                      onWalletFilterChange={handleWalletFilterChange}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "tokens" && <TokenExplorer />}

      {mode === "programs" && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Program Explorer
            </span>
            <span className="font-mono text-[9px] text-muted-foreground/50">
              Coming soon
            </span>
          </div>
        </div>
      )}

      {mode === "trace" && (
        <TraceExplorer
          initialAddress={getTraceAddressFromUrl()}
          onNavigateToWallet={(addr) => {
            setMode("wallet");
            handleSearch(addr);
          }}
        />
      )}

      {/* Footer */}
      <footer className="flex-none border-t border-border px-3 py-0.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
            {counterparties.length > 0
              ? `${counterparties.length} Counterparties`
              : ""}
            {txCount > 0 && ` | ${txCount} TX Analyzed`}
          </span>
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
            {lastBlockTime > 0 &&
              `Last Scan: ${new Date(lastBlockTime * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
          </span>
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#00ff88]" />
            Helius RPC
          </span>
        </div>
      </footer>
    </div>
  );
}
