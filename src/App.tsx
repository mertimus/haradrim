import { startTransition, useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import { SearchBar } from "@/components/SearchBar";
import { ExplorerLanding } from "@/components/ExplorerLanding";
import { WalletProfile } from "@/components/WalletProfile";
import { CounterpartyTable } from "@/components/CounterpartyTable";
import type {
  CounterpartyDisplay,
  TimeRange,
  CounterpartySortKey,
  CounterpartySortDir,
} from "@/components/CounterpartyTable";
import { CounterpartyDetailPanel } from "@/components/CounterpartyDetailPanel";
import type { SelectedCounterpartyDetail } from "@/components/CounterpartyDetailPanel";
import { FlowTransferHistoryPanel } from "@/components/FlowTransferHistoryPanel";
import type { FlowTransferHistoryItem } from "@/components/FlowTransferHistoryPanel";
import { TransactionGraph } from "@/components/TransactionGraph";
import { WalletFlowView } from "@/components/WalletFlowView";
import { WalletConnectionsCoachmark } from "@/components/WalletConnectionsCoachmark";
import { WalletOverlayPanel } from "@/components/WalletOverlayPanel";
import { WalletInsightsStrip } from "@/components/WalletInsightsStrip";
import type { WalletInsight } from "@/components/WalletInsightsStrip";
import { TraceExplorer } from "@/components/TraceExplorer";
import {
  getIdentity,
  getBatchIdentity,
  getBalances,
  getFunding,
  getPreferredSolDomain,
} from "@/api";
import type { WalletIdentity, WalletBalances, FundingSource } from "@/api";
import {
  buildGraphData,
  buildMergedGraphData,
  countSharedCounterparties,
  getWalletColor,
  projectCounterpartiesForGraphFlow,
  type ParsedTransaction,
} from "@/lib/parse-transactions";
import type {
  CounterpartyFlow,
  ForceSimData,
  OverlayWallet,
  GraphOverrides,
  GraphFlowFilter,
} from "@/lib/parse-transactions";
import { sortCounterparties } from "@/lib/counterparty-sorting";
import {
  getEnhancedCounterpartyHistory,
  getWalletAnalysis,
  getWalletPairSignals,
} from "@/lib/backend-api";
import type { WalletPairSignalsResult } from "@/lib/backend-api";

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

const DEFAULT_GRAPH_TYPE_FILTER: GraphTypeFilter = {
  wallet: true,
  token: true,
  program: true,
};

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

function isAddressFallbackLabel(label: string, address: string): boolean {
  return label === address
    || label === `${address.slice(0, 3)}...${address.slice(-3)}`
    || label === `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function shouldUseIdentityLabel(
  currentLabel: string | undefined,
  identityLabel: string | undefined,
  address: string,
): boolean {
  if (!identityLabel) return false;
  if (!currentLabel) return true;
  if (currentLabel === identityLabel) return false;
  if (isAddressFallbackLabel(currentLabel, address)) return true;
  if (!currentLabel.toLowerCase().endsWith(".sol") && identityLabel.toLowerCase().endsWith(".sol")) {
    return true;
  }
  return false;
}

function applyCounterpartyIdentityOverrides<T extends CounterpartyFlow>(
  counterparties: T[],
  identityByAddress: Map<string, WalletIdentity | null>,
): T[] {
  if (identityByAddress.size === 0) return counterparties;

  let changed = false;
  const next = counterparties.map((cp) => {
    const identity = identityByAddress.get(cp.address);
    if (!identity) return cp;

    const identityLabel = identity.label ?? identity.name;
    const label = shouldUseIdentityLabel(cp.label, identityLabel, cp.address)
      ? identityLabel
      : cp.label;
    const category = cp.category ?? identity.category;
    if (label === cp.label && category === cp.category) return cp;

    changed = true;
    return {
      ...cp,
      label,
      category,
    };
  });

  return changed ? next : counterparties;
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

function computeConnectionScore(
  walletCount: number,
  totalVolume: number,
  totalTxCount: number,
  multiWalletRecent: boolean,
): number {
  return (
    walletCount * 2.0 +
    Math.log(1 + totalVolume) * 0.3 +
    Math.log(1 + totalTxCount) * 0.2 +
    (multiWalletRecent ? 0.5 : 0)
  );
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
  const recentCutoff = Math.floor(Date.now() / 1000) - THIRTY_DAY_WINDOW_SECONDS;

  interface MergedEntry extends CounterpartyDisplay {
    sourceIndices: number[];
    sourceStats: Map<string, { txCount: number; solSent: number; solReceived: number }>;
  }

  const merged = new Map<string, MergedEntry>();

  for (const cp of filteredCounterparties) {
    if (hubAddresses.has(cp.address)) continue;
    merged.set(cp.address, {
      ...cp,
      sourceIndices: [0],
      walletColors: [],
      sourceStats: new Map([[address, { txCount: cp.txCount, solSent: cp.solSent, solReceived: cp.solReceived }]]),
    });
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
        existing.sourceStats.set(overlay.address, { txCount: cp.txCount, solSent: cp.solSent, solReceived: cp.solReceived });
      } else {
        merged.set(cp.address, {
          ...cp,
          sourceIndices: [colorIdx],
          walletColors: [],
          sourceStats: new Map([[overlay.address, { txCount: cp.txCount, solSent: cp.solSent, solReceived: cp.solReceived }]]),
        });
      }
    }
  }

  return Array.from(merged.values()).map((cp) => {
    const walletCount = cp.sourceIndices.length;
    const totalVolume = cp.solSent + cp.solReceived;
    const multiWalletRecent = walletCount > 1 && cp.lastSeen >= recentCutoff;
    return {
      ...cp,
      walletColors: cp.sourceIndices.map((index) => walletColors[index]),
      connectionScore: computeConnectionScore(walletCount, totalVolume, cp.txCount, multiWalletRecent),
      sourceStats: cp.sourceStats,
    };
  });
}

function getAddressFromUrl(): string {
  // Support /wallet/:addr, /flows/:addr and ?address= (legacy)
  const pathMatch = window.location.pathname.match(/^\/(?:wallet|flows)\/([A-Za-z0-9]+)$/);
  if (pathMatch) return pathMatch[1];
  const params = new URLSearchParams(window.location.search);
  return params.get("address") ?? "";
}

function setModeInUrl(mode: AppMode, address = ""): void {
  if (mode === "wallet") {
    window.history.pushState({}, "", address ? `/wallet/${address}` : "/");
    return;
  }
  if (mode === "flows") {
    window.history.pushState({}, "", address ? `/flows/${address}` : "/flows");
    return;
  }
  if (mode === "trace") {
    window.history.pushState({}, "", address ? `/trace/${address}` : "/trace");
    return;
  }
  window.history.pushState({}, "", `/${mode}`);
}

function isDisabledTokenPath(pathname = window.location.pathname): boolean {
  return pathname === "/tokens" || pathname.startsWith("/token/");
}

function normalizeDisabledTokenRoute(): boolean {
  if (!isDisabledTokenPath()) return false;
  window.history.replaceState({}, "", "/");
  return true;
}

function getModeFromUrl(): AppMode {
  if (window.location.pathname.startsWith("/flows")) return "flows";
  if (window.location.pathname.startsWith("/trace")) return "trace";
  return "wallet";
}

function getTraceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/trace\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

export type AppMode = "wallet" | "flows" | "programs" | "trace";

export default function App() {
  const [mode, setMode] = useState<AppMode>(getModeFromUrl);
  const [address, setAddress] = useState(getAddressFromUrl);
  const [loading, setLoading] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [fundingLoading, setFundingLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [fundingError, setFundingError] = useState<string | null>(null);

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
  const [graphTypeFilter, setGraphTypeFilter] = useState<GraphTypeFilter>(DEFAULT_GRAPH_TYPE_FILTER);
  const [graphFlowFilter, setGraphFlowFilter] = useState<GraphFlowFilter>("all");
  const [graphScopeFilter, setGraphScopeFilter] = useState<GraphScopeFilter>("all");
  const [graphScopeNowTs, setGraphScopeNowTs] = useState(() => Math.floor(Date.now() / 1000));
  const [graphNodeBudget, setGraphNodeBudget] = useState(50);
  const [selectedCounterpartyAddress, setSelectedCounterpartyAddress] = useState<string | null>(null);
  const [tableSortKey, setTableSortKey] = useState<CounterpartySortKey | null>(null);
  const [tableSortDir, setTableSortDir] = useState<CounterpartySortDir>("desc");
  const rawTxsRef = useRef<ParsedTransaction[]>([]);
  const allTimeTxsRef = useRef<ParsedTransaction[]>([]);
  const allTimeCounterpartiesRef = useRef<CounterpartyFlow[]>([]);
  const allTimeLastBlockTimeRef = useRef(0);
  const lookupRequestIdRef = useRef(0);
  const timeRangeRequestIdRef = useRef(0);
  const overlayRequestIdsRef = useRef(new Map<string, number>());
  const flowHistoryRequestIdRef = useRef(0);
  const flowHistoryCacheRef = useRef(new Map<string, Map<string, {
    type?: string;
    description?: string;
    source?: string;
    protocol?: string;
    programs?: Array<{ id: string; label: string }>;
    timestamp?: number;
  }>>());
  const [flowHistoryLoading, setFlowHistoryLoading] = useState(false);
  const [flowHistoryError, setFlowHistoryError] = useState<string | null>(null);
  const [flowEnhancedBySignature, setFlowEnhancedBySignature] = useState<Map<string, {
    type?: string;
    description?: string;
    source?: string;
    protocol?: string;
    programs?: Array<{ id: string; label: string }>;
    timestamp?: number;
  }>>(new Map());
  const [detailIdentityByAddress, setDetailIdentityByAddress] = useState<Map<string, WalletIdentity | null>>(new Map());
  const pendingIdentityAddressesRef = useRef<Set<string>>(new Set());
  const [walletPairSignals, setWalletPairSignals] = useState<WalletPairSignalsResult[]>([]);
  const walletPairSignalsRequestRef = useRef(0);
  const hasAutoSortedRef = useRef(false);
  const searchDisplayValue = address ? (getPreferredSolDomain(address) ?? address) : "";
  const enrichedCounterparties = useMemo(
    () => applyCounterpartyIdentityOverrides(counterparties, detailIdentityByAddress),
    [counterparties, detailIdentityByAddress],
  );
  const enrichedAllTimeCounterparties = useMemo(
    () => applyCounterpartyIdentityOverrides(allTimeCounterparties, detailIdentityByAddress),
    [allTimeCounterparties, detailIdentityByAddress],
  );
  const enrichedOverlayWallets = useMemo(
    () => overlayWallets.map((wallet) => ({
      ...wallet,
      counterparties: applyCounterpartyIdentityOverrides(wallet.counterparties, detailIdentityByAddress),
    })),
    [detailIdentityByAddress, overlayWallets],
  );

  // Ref-based hover highlight — no React re-renders, pure DOM manipulation
  const graphWrapperRef = useRef<HTMLDivElement>(null);
  const handleHoverAddress = useCallback((address: string | null) => {
    const container = graphWrapperRef.current;
    if (!container) return;
    const prevNode = container.querySelector(".react-flow__node.node-highlighted");
    if (prevNode) prevNode.classList.remove("node-highlighted");
    const prevLane = container.querySelector(".wallet-flow-lane.flow-lane-highlighted");
    if (prevLane) prevLane.classList.remove("flow-lane-highlighted");
    if (address) {
      const nodeEl = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(address)}"]`,
      );
      if (nodeEl) nodeEl.classList.add("node-highlighted");
      const laneEl = container.querySelector(
        `.wallet-flow-lane[data-flow-address="${CSS.escape(address)}"]`,
      );
      if (laneEl) laneEl.classList.add("flow-lane-highlighted");
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
    if (!f) return enrichedCounterparties;
    return enrichedCounterparties.filter(cp =>
      (f.minVolume <= 0 || cp.solSent + cp.solReceived >= f.minVolume) &&
      (f.minTxCount <= 0 || cp.txCount >= f.minTxCount) &&
      (f.netThreshold === 0 || (f.netThreshold > 0 ? cp.solNet >= f.netThreshold : cp.solNet <= f.netThreshold))
    );
  }, [enrichedCounterparties, walletFilters]);

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

    const stats: WalletStats[] = [computeStats(enrichedCounterparties, walletFilters.get(0))];
    for (let i = 0; i < enrichedOverlayWallets.length; i++) {
      stats.push(computeStats(enrichedOverlayWallets[i].counterparties, walletFilters.get(i + 1)));
    }
    return stats;
  }, [enrichedCounterparties, enrichedOverlayWallets, walletFilters]);

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
    setGraphScopeNowTs(Math.floor(Date.now() / 1000));
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
  const hasOverlayComparison = overlayWallets.length > 0;
  const isFlowPage = mode === "flows";

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
    return enrichedOverlayWallets.map((ow, i) => {
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
  }, [enrichedOverlayWallets, walletFilters]);

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

    // Multi-wallet mode — use worker for force layout when 50+ nodes
    const wallets = [
      { address, counterparties: scopedGraphCounterparties, identity },
      ...readyOverlays.map((ow) => ({
        address: ow.address,
        counterparties: ow.counterparties,
        identity: ow.identity,
      })),
    ];
    const totalNodes = wallets.reduce((sum, w) => sum + w.counterparties.length, wallets.length);
    const useWorker = totalNodes >= 50;

    const graphData = buildMergedGraphData(
      wallets,
      walletColors,
      graphOverrides,
      effectiveGraphNodeBudget,
      graphRankByAddress,
      useWorker ? { skipSimulation: true } : undefined,
    );
    setNodes(graphData.nodes);
    setEdges(graphData.edges);

    if (!useWorker || !graphData.forceSimData) return;

    const worker = new Worker(
      new URL("@/workers/force-layout.worker.ts", import.meta.url),
      { type: "module" },
    );
    const simData = graphData.forceSimData;
    worker.postMessage({ nodes: simData.simNodes, links: simData.simLinks });
    worker.onmessage = (e: MessageEvent<{ positions: Record<string, { x: number; y: number }> }>) => {
      const { positions } = e.data;
      setNodes((prev) =>
        prev.map((node) => {
          const pos = positions[node.id];
          return pos ? { ...node, position: pos } : node;
        }),
      );
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
    };
    return () => {
      worker.terminate();
    };
  }, [
    address,
    rankedGraphCounterparties,
    identity,
    rankedGraphOverlayWallets,
    walletColors,
    graphOverrides,
    effectiveGraphNodeBudget,
    graphRankByAddress,
    scopedGraphCounterparties,
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

  const sharedFunders = useMemo(() => {
    const readyOverlays = overlayWallets.filter((ow) => !ow.loading && !ow.error);
    if (readyOverlays.length === 0 || !funding) return [];
    const primaryFunder = funding.address;
    return readyOverlays
      .filter((ow) => ow.funding?.address === primaryFunder)
      .map((ow) => ({
        overlayAddress: ow.address,
        funderAddress: primaryFunder,
        funderLabel: funding.label ?? ow.funding?.label,
      }));
  }, [funding, overlayWallets]);

  // Phase 6: Auto-suggested comparisons (only when no overlays)
  const suggestedComparisons = useMemo(() => {
    if (overlayWallets.length > 0) return [];
    const suggestions: { address: string; reason: string }[] = [];
    const seen = new Set<string>();
    seen.add(address);

    // Suggestion 1: The wallet's funder
    if (funding?.address && !seen.has(funding.address)) {
      suggestions.push({
        address: funding.address,
        reason: `Funder${funding.label ? ` (${funding.label})` : ""}`,
      });
      seen.add(funding.address);
    }

    // Suggestion 2: Largest bidirectional counterparty (single-pass max)
    let topMutual: CounterpartyFlow | null = null;
    let topMutualVol = -1;
    let topFrequency: CounterpartyFlow | null = null;
    let topFrequencyTx = -1;
    for (const cp of filteredCounterparties) {
      if (seen.has(cp.address) || cp.accountType === "program" || cp.accountType === "token") continue;
      if (cp.solSent > 0 && cp.solReceived > 0) {
        const vol = cp.solSent + cp.solReceived;
        if (vol > topMutualVol) { topMutual = cp; topMutualVol = vol; }
      }
      if (cp.txCount > topFrequencyTx) { topFrequency = cp; topFrequencyTx = cp.txCount; }
    }
    if (topMutual) {
      suggestions.push({
        address: topMutual.address,
        reason: `Top mutual${topMutual.label ? ` (${topMutual.label})` : ""}`,
      });
      seen.add(topMutual.address);
    }

    // Suggestion 3: Most frequent counterparty
    if (topFrequency && !seen.has(topFrequency.address)) {
      suggestions.push({
        address: topFrequency.address,
        reason: `Most active (${topFrequency.txCount} tx)`,
      });
      seen.add(topFrequency.address);
    }

    return suggestions;
  }, [address, filteredCounterparties, funding, overlayWallets.length]);

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
    const historicalCounterparties = enrichedAllTimeCounterparties.length > 0 ? enrichedAllTimeCounterparties : filteredCounterparties;
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
      sharedFunders.length > 0
        ? {
            id: "shared-funder",
            title: "Shared Funder",
            value: sharedFunders[0].funderLabel ?? truncAddr(sharedFunders[0].funderAddress),
            description: `${sharedFunders.length + 1} wallets funded by same source`,
            accentColor: "#ff2d2d",
            address: sharedFunders[0].funderAddress,
          }
        : sharedComparisonCount > 0 && strongestSharedCounterparty
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
  }, [enrichedAllTimeCounterparties, filteredCounterparties, sharedComparisonCount, sharedFunders, strongestSharedCounterparty]);

  useEffect(() => {
    if (!selectedCounterpartyAddress) return;
    if (detailIdentityByAddress.has(selectedCounterpartyAddress)) return;

    let cancelled = false;
    void getIdentity(selectedCounterpartyAddress)
      .then((result) => {
        if (cancelled) return;
        setDetailIdentityByAddress((prev) => {
          if (prev.has(selectedCounterpartyAddress)) return prev;
          const next = new Map(prev);
          next.set(selectedCounterpartyAddress, result);
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setDetailIdentityByAddress((prev) => {
          if (prev.has(selectedCounterpartyAddress)) return prev;
          const next = new Map(prev);
          next.set(selectedCounterpartyAddress, null);
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [detailIdentityByAddress, selectedCounterpartyAddress]);

  const selectedCounterpartyDetail = useMemo((): SelectedCounterpartyDetail | null => {
    if (!selectedCounterpartyAddress) return null;
    const cp = mergedCounterparties.find((counterparty) => counterparty.address === selectedCounterpartyAddress);
    if (!cp) return null;
    const identityOverride = detailIdentityByAddress.get(selectedCounterpartyAddress);

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
      label: cp.label ?? identityOverride?.label ?? identityOverride?.name,
      category: cp.category ?? identityOverride?.category,
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
      sourceStats: cp.sourceStats,
      connectionScore: cp.connectionScore,
    };
  }, [comparisonWallets, detailIdentityByAddress, mergedCounterparties, selectedCounterpartyAddress]);

  const flowSelectedCounterpartyDetail = useMemo((): SelectedCounterpartyDetail | null => {
    if (!selectedCounterpartyAddress) return null;
    const cp = filteredCounterparties.find((counterparty) => counterparty.address === selectedCounterpartyAddress);
    if (!cp) return null;
    const identityOverride = detailIdentityByAddress.get(selectedCounterpartyAddress);

    return {
      address: cp.address,
      label: cp.label ?? identityOverride?.label ?? identityOverride?.name,
      category: cp.category ?? identityOverride?.category,
      accountType: cp.accountType,
      tokenName: cp.tokenName,
      tokenSymbol: cp.tokenSymbol,
      txCount: cp.txCount,
      solSent: cp.solSent,
      solReceived: cp.solReceived,
      solNet: cp.solNet,
      firstSeen: cp.firstSeen,
      lastSeen: cp.lastSeen,
      connectedWallets: [
        {
          address,
          label: describeWallet(address, identity),
          color: walletColors[0],
          role: "Primary",
        },
      ],
    };
  }, [address, detailIdentityByAddress, filteredCounterparties, identity, selectedCounterpartyAddress, walletColors]);

  const currentSelectedCounterpartyDetail = isFlowPage
    ? flowSelectedCounterpartyDetail
    : selectedCounterpartyDetail;
  const currentTableCounterparties = sortedMergedCounterparties;

  // Look up forensic signals for the selected counterparty (merge across all pairs, keep highest score per kind)
  const selectedForensicData = useMemo(() => {
    if (walletPairSignals.length === 0 || !selectedCounterpartyAddress) return null;
    const bestByKind = new Map<string, import("@/lib/backend-api").WalletPairSignal>();
    for (const pairResult of walletPairSignals) {
      const match = pairResult.signals.find((s) => s.counterparty === selectedCounterpartyAddress);
      if (match) {
        for (const sig of match.signals) {
          const existing = bestByKind.get(sig.kind);
          if (!existing || sig.score > existing.score) {
            bestByKind.set(sig.kind, sig);
          }
        }
      }
    }
    if (bestByKind.size === 0) return null;
    const allSignals = [...bestByKind.values()];
    const totalScore = allSignals.reduce((sum, s) => sum + s.score, 0);
    return { signals: allSignals, totalScore };
  }, [walletPairSignals, selectedCounterpartyAddress]);

  useEffect(() => {
    const addressesToPrefetch = [
      ...rankedGraphCounterparties.slice(0, effectiveGraphNodeBudget),
      ...currentTableCounterparties.slice(0, 150),
    ]
      .filter((cp) => !detailIdentityByAddress.has(cp.address) && !pendingIdentityAddressesRef.current.has(cp.address))
      .map((cp) => cp.address);

    const uniqueAddresses = [...new Set(addressesToPrefetch)];
    if (uniqueAddresses.length === 0) return;

    // Mark as pending before the async call fires
    for (const addr of uniqueAddresses) {
      pendingIdentityAddressesRef.current.add(addr);
    }

    let cancelled = false;
    void getBatchIdentity(uniqueAddresses)
      .then((identityMap) => {
        if (cancelled) return;
        setDetailIdentityByAddress((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const addr of uniqueAddresses) {
            if (next.has(addr)) continue;
            next.set(addr, identityMap.get(addr) ?? null);
            changed = true;
          }
          return changed ? next : prev;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setDetailIdentityByAddress((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const addr of uniqueAddresses) {
            if (next.has(addr)) continue;
            next.set(addr, null);
            changed = true;
          }
          return changed ? next : prev;
        });
      })
      .finally(() => {
        for (const addr of uniqueAddresses) {
          pendingIdentityAddressesRef.current.delete(addr);
        }
      });

    return () => {
      cancelled = true;
      for (const addr of uniqueAddresses) {
        pendingIdentityAddressesRef.current.delete(addr);
      }
    };
  }, [
    currentTableCounterparties,
    detailIdentityByAddress,
    effectiveGraphNodeBudget,
    rankedGraphCounterparties,
  ]);

  // Fetch wallet-pair forensic signals for all overlay pairs
  useEffect(() => {
    const readyOverlays = overlayWallets.filter((ow) => !ow.loading && !ow.error);
    if (readyOverlays.length === 0 || !address) {
      setWalletPairSignals([]);
      return;
    }

    const rid = ++walletPairSignalsRequestRef.current;

    void Promise.all(
      readyOverlays.map((ow) => getWalletPairSignals(address, ow.address).catch(() => null)),
    ).then((results) => {
      if (rid !== walletPairSignalsRequestRef.current) return;
      setWalletPairSignals(results.filter((r): r is WalletPairSignalsResult => r != null));
    });

    return () => {
      walletPairSignalsRequestRef.current++;
    };
  }, [address, overlayWallets]);

  const flowTransferHistory = useMemo<FlowTransferHistoryItem[]>(() => {
    if (!selectedCounterpartyAddress) return [];

    return rawTxsRef.current
      .map((tx) => {
        const transfers = tx.transfers.filter(
          (transfer) => transfer.counterparty === selectedCounterpartyAddress,
        );
        if (transfers.length === 0) return null;

        const sentMap = new Map<string, {
          assetId: string;
          kind: "native" | "token";
          mint?: string;
          symbol?: string;
          name?: string;
          logoUri?: string;
          uiAmount: number;
        }>();
        const receivedMap = new Map<string, {
          assetId: string;
          kind: "native" | "token";
          mint?: string;
          symbol?: string;
          name?: string;
          logoUri?: string;
          uiAmount: number;
        }>();
        let sentSol = 0;
        let receivedSol = 0;

        for (const transfer of transfers) {
          const targetMap = transfer.direction === "outflow" ? sentMap : receivedMap;
          const existing = targetMap.get(transfer.assetId);
          const nextAmount = (existing?.uiAmount ?? 0) + transfer.uiAmount;
          targetMap.set(transfer.assetId, {
            assetId: transfer.assetId,
            kind: transfer.kind,
            mint: transfer.mint,
            symbol: transfer.symbol,
            name: transfer.name,
            logoUri: transfer.logoUri,
            uiAmount: nextAmount,
          });
          if (transfer.kind === "native") {
            if (transfer.direction === "outflow") sentSol += transfer.uiAmount;
            else receivedSol += transfer.uiAmount;
          }
        }

        const sent = [...sentMap.values()].sort((a, b) => b.uiAmount - a.uiAmount);
        const received = [...receivedMap.values()].sort((a, b) => b.uiAmount - a.uiAmount);
        const distinctAssetCount = new Set(transfers.map((transfer) => transfer.assetId)).size;
        const semantic: FlowTransferHistoryItem["semantic"] = sent.length > 0 && received.length > 0
          ? (distinctAssetCount > 1 ? "swap" : "two-way")
          : (received.length > 0 ? "inflow" : "outflow");

        return {
          signature: tx.signature,
          timestamp: tx.timestamp,
          sent,
          received,
          solNet: receivedSol - sentSol,
          fee: tx.fee,
          totalTransferCount: transfers.length,
          semantic,
        };
      })
      .filter((item): item is FlowTransferHistoryItem => item !== null)
      .map((item) => {
        const enhanced = flowEnhancedBySignature.get(item.signature);
        return enhanced
          ? {
              ...item,
              enhancedType: enhanced.type,
              enhancedDescription: enhanced.description,
              enhancedSource: enhanced.source,
              protocol: enhanced.protocol,
              programs: enhanced.programs,
            }
          : item;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [flowEnhancedBySignature, selectedCounterpartyAddress]);

  useEffect(() => {
    if (!isFlowPage || !address || !selectedCounterpartyAddress) {
      flowHistoryRequestIdRef.current += 1;
      setFlowHistoryLoading(false);
      setFlowHistoryError(null);
      setFlowEnhancedBySignature(new Map());
      return;
    }

    const cacheKey = `${address}:${selectedCounterpartyAddress}:${txCount}:${lastBlockTime}`;
  const cached = flowHistoryCacheRef.current.get(cacheKey);
    if (cached) {
      setFlowEnhancedBySignature(cached);
      setFlowHistoryLoading(false);
      setFlowHistoryError(null);
      return;
    }

    const rid = ++flowHistoryRequestIdRef.current;
    setFlowHistoryLoading(true);
    setFlowHistoryError(null);
    setFlowEnhancedBySignature(new Map());

    void getEnhancedCounterpartyHistory(address, selectedCounterpartyAddress)
      .then((result) => {
        if (rid !== flowHistoryRequestIdRef.current) return;
        const next = new Map(
          result.annotations.map((annotation) => [
            annotation.signature,
            {
              type: annotation.type,
              description: annotation.description,
              source: annotation.source,
              protocol: annotation.protocol,
              programs: annotation.programs,
              timestamp: annotation.timestamp,
            },
          ]),
        );
        flowHistoryCacheRef.current.set(cacheKey, next);
        setFlowEnhancedBySignature(next);
        setFlowHistoryLoading(false);
      })
      .catch((err) => {
        if (rid !== flowHistoryRequestIdRef.current) return;
        setFlowHistoryError(err instanceof Error ? err.message : "Failed to enhance flow history");
        setFlowHistoryLoading(false);
      });
  }, [address, isFlowPage, lastBlockTime, selectedCounterpartyAddress, txCount]);

  useEffect(() => {
    const selectableCounterparties = isFlowPage ? filteredCounterparties : sortedMergedCounterparties;
    if (selectableCounterparties.length === 0) {
      if (selectedCounterpartyAddress != null) setSelectedCounterpartyAddress(null);
      return;
    }
    if (selectedCounterpartyAddress && !selectableCounterparties.some((cp) => cp.address === selectedCounterpartyAddress)) {
      setSelectedCounterpartyAddress(null);
    }
  }, [filteredCounterparties, isFlowPage, selectedCounterpartyAddress, sortedMergedCounterparties]);

  const applyWalletAnalysis = useCallback((counterpartyData: CounterpartyFlow[], transactions: ParsedTransaction[], count: number, blockTime: number) => {
    rawTxsRef.current = transactions;
    startTransition(() => {
      setCounterparties(counterpartyData);
      setTxCount(count);
      setLastBlockTime(blockTime);
      setTableLoading(false);
      setGraphLoading(false);
    });
  }, []);

  const resetWalletView = useCallback(() => {
    lookupRequestIdRef.current += 1;
    timeRangeRequestIdRef.current += 1;
    overlayRequestIdsRef.current = new Map();
    flowHistoryRequestIdRef.current += 1;
    flowHistoryCacheRef.current = new Map();
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
    setGraphTypeFilter(DEFAULT_GRAPH_TYPE_FILTER);
    setGraphFlowFilter("all");
    setGraphScopeFilter("all");
    setGraphScopeNowTs(Math.floor(Date.now() / 1000));
    setSelectedCounterpartyAddress(null);
    setFlowHistoryLoading(false);
    setFlowHistoryError(null);
    setFlowEnhancedBySignature(new Map());
    setWalletError(null);
    setIdentityError(null);
    setBalancesError(null);
    setFundingError(null);
    setLoading(false);
    setIdentityLoading(false);
    setBalancesLoading(false);
    setFundingLoading(false);
    setGraphLoading(false);
    setTableLoading(false);
    rawTxsRef.current = [];
    allTimeTxsRef.current = [];
    allTimeCounterpartiesRef.current = [];
    allTimeLastBlockTimeRef.current = 0;
    pendingIdentityAddressesRef.current = new Set();
    setWalletPairSignals([]);
    walletPairSignalsRequestRef.current++;
    hasAutoSortedRef.current = false;
  }, []);

  const lookup = useCallback(async (addr: string) => {
    if (!addr) return;
    const rid = ++lookupRequestIdRef.current;
    timeRangeRequestIdRef.current += 1;

    setLoading(true);
    setIdentityLoading(true);
    setBalancesLoading(true);
    setFundingLoading(true);
    setGraphLoading(true);
    setTableLoading(true);
    setWalletError(null);
    setIdentityError(null);
    setBalancesError(null);
    setFundingError(null);
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
    setGraphTypeFilter(DEFAULT_GRAPH_TYPE_FILTER);
    setGraphFlowFilter("all");
    setGraphScopeFilter("all");
    setGraphScopeNowTs(Math.floor(Date.now() / 1000));
    setSelectedCounterpartyAddress(null);
    rawTxsRef.current = [];
    allTimeTxsRef.current = [];
    allTimeCounterpartiesRef.current = [];
    allTimeLastBlockTimeRef.current = 0;

    void getIdentity(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setIdentity(result);
        setIdentityError(null);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setIdentity(null);
        setIdentityError("Identity unavailable");
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setIdentityLoading(false);
      });

    void getBalances(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setBalances(result);
        setBalancesError(null);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setBalances(null);
        setBalancesError("Balances unavailable");
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setBalancesLoading(false);
      });

    void getFunding(addr)
      .then((result) => {
        if (rid !== lookupRequestIdRef.current) return;
        setFunding(result);
        setFundingError(null);
      })
      .catch(() => {
        if (rid !== lookupRequestIdRef.current) return;
        setFunding(null);
        setFundingError("Funding unavailable");
      })
      .finally(() => {
        if (rid === lookupRequestIdRef.current) setFundingLoading(false);
      });

    try {
      const analysis = await getWalletAnalysis(addr);
      if (rid !== lookupRequestIdRef.current) return;
      rawTxsRef.current = analysis.transactions;
      allTimeTxsRef.current = analysis.transactions;
      allTimeCounterpartiesRef.current = analysis.counterparties;
      allTimeLastBlockTimeRef.current = analysis.lastBlockTime;
      startTransition(() => {
        setAllTimeCounterparties(analysis.counterparties);
      });
      applyWalletAnalysis(
        analysis.counterparties,
        analysis.transactions,
        analysis.txCount,
        analysis.lastBlockTime,
      );
      setLoading(false);
    } catch (err) {
      if (rid !== lookupRequestIdRef.current) return;
      setWalletError(err instanceof Error ? err.message : "Wallet lookup failed");
      setGraphLoading(false);
      setTableLoading(false);
      setLoading(false);
    }
  }, [applyWalletAnalysis]);

  const handleAddOverlay = useCallback(
    async (overlayAddr: string) => {
      if (overlayAddr === address) return;
      if (overlayWallets.some((ow) => ow.address === overlayAddr)) return;
      const walletGeneration = lookupRequestIdRef.current;
      const requestId = (overlayRequestIdsRef.current.get(overlayAddr) ?? 0) + 1;
      overlayRequestIdsRef.current.set(overlayAddr, requestId);

      // Add loading entry
      const newOverlay: OverlayWallet = {
        address: overlayAddr,
        identity: null,
        counterparties: [],
        loading: true,
      };
      setOverlayWallets((prev) => [...prev, newOverlay]);

      try {
        const existingCp = enrichedCounterparties.find(c => c.address === overlayAddr)
          ?? enrichedOverlayWallets.flatMap(ow => ow.counterparties).find(c => c.address === overlayAddr);
        const ident: WalletIdentity | null = existingCp?.label
          ? { address: overlayAddr, name: existingCp.label, label: existingCp.label, category: existingCp.category }
          : null;
        const [analysis, overlayFunding] = await Promise.all([
          getWalletAnalysis(overlayAddr),
          getFunding(overlayAddr).catch(() => null),
        ]);
        if (lookupRequestIdRef.current !== walletGeneration) return;
        if (overlayRequestIdsRef.current.get(overlayAddr) !== requestId) return;

        setOverlayWallets((prev) =>
          prev.map((ow) =>
            ow.address === overlayAddr
              ? { ...ow, identity: ident, counterparties: analysis.counterparties, funding: overlayFunding, loading: false, error: undefined }
              : ow,
          ),
        );
        // Auto-sort by connection score only when the first overlay loads
        if (!hasAutoSortedRef.current) {
          hasAutoSortedRef.current = true;
          setTableSortKey("score");
          setTableSortDir("desc");
        }
      } catch (err) {
        if (lookupRequestIdRef.current !== walletGeneration) return;
        if (overlayRequestIdsRef.current.get(overlayAddr) !== requestId) return;
        setOverlayWallets((prev) =>
          prev.map((ow) =>
            ow.address === overlayAddr
              ? { ...ow, loading: false, error: err instanceof Error ? err.message : "Failed" }
              : ow,
          ),
        );
      }
    },
    [address, enrichedCounterparties, enrichedOverlayWallets, overlayWallets],
  );

  const handleRemoveOverlay = useCallback((overlayAddr: string) => {
    overlayRequestIdsRef.current.set(
      overlayAddr,
      (overlayRequestIdsRef.current.get(overlayAddr) ?? 0) + 1,
    );
    setOverlayWallets((prev) => prev.filter((ow) => ow.address !== overlayAddr));
  }, []);

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    if (range.start == null && range.end == null) {
      rawTxsRef.current = allTimeTxsRef.current;
      setCounterparties(allTimeCounterpartiesRef.current);
      setTxCount(allTimeTxsRef.current.length);
      setLastBlockTime(allTimeLastBlockTimeRef.current);
      setWalletError(null);
      return;
    }

    const rid = ++timeRangeRequestIdRef.current;
    setTableLoading(true);
    setGraphLoading(true);
    setWalletError(null);

    void getWalletAnalysis(address, range)
      .then((analysis) => {
        if (rid !== timeRangeRequestIdRef.current) return;
        applyWalletAnalysis(
          analysis.counterparties,
          analysis.transactions,
          analysis.txCount,
          analysis.lastBlockTime,
        );
      })
      .catch((err) => {
        if (rid !== timeRangeRequestIdRef.current) return;
        setWalletError(err instanceof Error ? `Failed to refresh filtered view: ${err.message}` : "Failed to refresh filtered view");
        setTableLoading(false);
        setGraphLoading(false);
      });
  }, [address, applyWalletAnalysis]);

  const handleSearch = useCallback(
    (addr: string) => {
      const nextMode: AppMode = mode === "flows" ? "flows" : "wallet";
      setMode(nextMode);
      setAddress(addr);
      setModeInUrl(nextMode, addr);
      lookup(addr);
    },
    [lookup, mode],
  );

  const handleNavigate = useCallback(
    (addr: string) => {
      handleSearch(addr);
    },
    [handleSearch],
  );

  useEffect(() => {
    normalizeDisabledTokenRoute();
  }, []);

  useEffect(() => {
    function onPop() {
      normalizeDisabledTokenRoute();
      // Update mode based on URL path
      setMode(getModeFromUrl());
      const addr = getAddressFromUrl();
      if (addr) {
        setAddress(addr);
        lookup(addr);
      } else {
        resetWalletView();
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [lookup, resetWalletView]);

  useEffect(() => {
    const initial = getAddressFromUrl();
    if (initial) {
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
              resetWalletView();
              setModeInUrl("wallet");
            }}
          >
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">
              HARADRIM
            </h1>
          </button>
          <div className="h-3 w-px bg-border" />
          <nav className="flex gap-1">
            {(["wallet", "flows", "trace"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setModeInUrl(m, m === "wallet" || m === "flows" ? address : "");
                }}
                className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded transition-colors cursor-pointer"
                style={{
                  color: mode === m ? "#00d4ff" : "#6b7b8d",
                  background: mode === m ? "rgba(0, 212, 255, 0.08)" : "transparent",
                }}
              >
                {m === "wallet" ? "shared connections" : m}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          <div className="w-full max-w-md">
            <SearchBar
              key={`${mode}:${address}:header`}
              onSearch={handleSearch}
              loading={loading}
              defaultValue={searchDisplayValue}
              autoFocus={Boolean(address) && mode !== "trace"}
              enableShortcut={Boolean(address) && mode !== "trace"}
            />
          </div>
        </div>
      </header>

      {(mode === "wallet" || mode === "flows") && (
        <>
          {!address && !loading ? (
            <ExplorerLanding
              mode={mode}
              action={(
                <div className="w-full">
                  <SearchBar
                    key={`${mode}:${address}:empty`}
                    onSearch={handleSearch}
                    loading={loading}
                    defaultValue={searchDisplayValue}
                    autoFocus
                    enableShortcut
                  />
                </div>
              )}
            />
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
                  identityFailed={Boolean(identityError)}
                  balancesFailed={Boolean(balancesError)}
                  fundingFailed={Boolean(fundingError)}
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

              {walletError && (
                <div className="flex-none border-b border-destructive/30 bg-destructive/5 px-3 py-2 flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] text-destructive/90">{walletError}</span>
                  <button
                    onClick={() => lookup(address)}
                    className="rounded border border-destructive/40 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.2em] text-destructive transition-colors hover:bg-destructive/10"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Bottom: graph + table side by side */}
              <div className="flex flex-1 overflow-hidden">
                {/* Graph: takes most of the space */}
                <div ref={graphWrapperRef} className="flex-1 overflow-hidden relative">
                  {mode === "wallet" && hasOverlayComparison && (
                    <div className="absolute right-3 top-3 z-20 rounded border border-primary/20 bg-card/90 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.18em] text-primary">
                      Topology
                    </div>
                  )}
                  {mode === "wallet" && (
                    <WalletConnectionsCoachmark
                      comparedCount={overlayWallets.length + 1}
                      selectedLabel={
                        currentSelectedCounterpartyDetail
                          ? currentSelectedCounterpartyDetail.label
                            ?? currentSelectedCounterpartyDetail.tokenSymbol
                            ?? currentSelectedCounterpartyDetail.tokenName
                            ?? truncAddr(currentSelectedCounterpartyDetail.address)
                          : null
                      }
                    />
                  )}

                  {mode === "flows" ? (
                    <WalletFlowView
                      key={address}
                      address={address}
                      identity={identity}
                      counterparties={filteredCounterparties}
                      loading={graphLoading}
                      selectedAddress={selectedCounterpartyAddress}
                      onSelectAddress={setSelectedCounterpartyAddress}
                    />
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                {/* Right panel: table + overlay */}
                <div className="w-[420px] flex-none border-l border-border overflow-hidden flex flex-col">
                  {mode === "flows" ? (
                    <FlowTransferHistoryPanel
                      detail={currentSelectedCounterpartyDetail}
                      items={flowTransferHistory}
                      loading={tableLoading}
                      parsingEnhanced={flowHistoryLoading}
                      parseError={flowHistoryError}
                    />
                  ) : (
                    <>
                      <div className="flex-none border-b border-border">
                        <CounterpartyDetailPanel
                          detail={currentSelectedCounterpartyDetail}
                          loading={tableLoading}
                          graphAddresses={graphAddresses}
                          onNavigate={handleNavigate}
                          onAddNode={handleGraphAddNode}
                          onRemoveNode={handleGraphRemoveNode}
                          onAddOverlay={handleAddOverlay}
                          surface="graph"
                          highlightCompareAction={!hasOverlayComparison}
                          forensicSignals={selectedForensicData?.signals}
                          forensicScore={selectedForensicData?.totalScore}
                        />
                      </div>
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <CounterpartyTable
                          key={`${address}:table`}
                          counterparties={currentTableCounterparties}
                          loading={tableLoading}
                          onNavigate={handleNavigate}
                          onHoverAddress={handleHoverAddress}
                          selectedAddress={selectedCounterpartyAddress}
                          onSelectAddress={setSelectedCounterpartyAddress}
                          graphAddresses={graphAddresses}
                          onAddNode={handleGraphAddNode}
                          onRemoveNode={handleGraphRemoveNode}
                          onAddOverlay={handleAddOverlay}
                          onTimeRangeChange={handleTimeRangeChange}
                          graphFlowFilter={graphFlowFilter}
                          onGraphFlowFilterChange={handleGraphFlowFilterChange}
                          sortKey={tableSortKey}
                          sortDir={tableSortDir}
                          onSortChange={handleTableSortChange}
                          surface="graph"
                        />
                      </div>
                    </>
                  )}
                  {mode === "wallet" && (
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
                        sharedFunders={sharedFunders}
                        suggestedComparisons={suggestedComparisons}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

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
