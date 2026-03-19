import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchBar } from "@/components/SearchBar";
import { ExplorerLanding } from "@/components/ExplorerLanding";
import { WalletProfile } from "@/components/WalletProfile";
import { CounterpartyTable } from "@/components/CounterpartyTable";
import type {
  CounterpartySortDir,
  CounterpartySortKey,
} from "@/components/CounterpartyTable";
import { CounterpartyDetailPanel } from "@/components/CounterpartyDetailPanel";
import { TransactionGraph } from "@/components/TransactionGraph";
import { WalletConnectionsCoachmark } from "@/components/WalletConnectionsCoachmark";
import { WalletOverlayPanel } from "@/components/WalletOverlayPanel";
import { WalletInsightsStrip } from "@/components/WalletInsightsStrip";
import { useCounterpartyDetail } from "@/hooks/useCounterpartyDetail";
import { useCounterpartyMerge } from "@/hooks/useCounterpartyMerge";
import { useWalletAnalysis } from "@/hooks/useWalletAnalysis";
import { useWalletGraph } from "@/hooks/useWalletGraph";
import type { GraphFlowFilter, GraphOverrides } from "@/lib/parse-transactions";
import {
  DEFAULT_GRAPH_TYPE_FILTER,
  truncAddr,
  type GraphPreset,
  type GraphScopeFilter,
  type GraphTypeFilter,
  type WalletFilter,
} from "@/lib/wallet-explorer";

function setCounterpartyRoute(address = ""): void {
  window.history.pushState({}, "", address ? `/counterparties/${address}` : "/counterparties");
}

interface CounterpartyExplorerProps {
  initialAddress?: string;
  onRouteAddressChange?: (address: string) => void;
}

export function CounterpartyExplorer({
  initialAddress = "",
  onRouteAddressChange,
}: CounterpartyExplorerProps) {
  const [colorOverrides, setColorOverrides] = useState<Map<number, string>>(new Map());
  const [walletFilters, setWalletFilters] = useState<Map<number, WalletFilter>>(new Map());
  const [graphAdded, setGraphAdded] = useState<Set<string>>(new Set());
  const [graphRemoved, setGraphRemoved] = useState<Set<string>>(new Set());
  const [graphTypeFilter, setGraphTypeFilter] = useState<GraphTypeFilter>(DEFAULT_GRAPH_TYPE_FILTER);
  const [graphFlowFilter, setGraphFlowFilter] = useState<GraphFlowFilter>("all");
  const [graphScopeFilter, setGraphScopeFilter] = useState<GraphScopeFilter>("all");
  const [graphScopeNowTs, setGraphScopeNowTs] = useState(() => Math.floor(Date.now() / 1000));
  const [graphNodeBudget, setGraphNodeBudget] = useState(50);
  const [tableSortKey, setTableSortKey] = useState<CounterpartySortKey | null>(null);
  const [tableSortDir, setTableSortDir] = useState<CounterpartySortDir>("desc");
  const graphWrapperRef = useRef<HTMLDivElement>(null);

  const analysis = useWalletAnalysis();
  const { handleReset, handleWalletLookup } = analysis;
  const merge = useCounterpartyMerge({
    address: analysis.address,
    identity: analysis.identity,
    funding: analysis.funding,
    counterparties: analysis.counterparties,
    allTimeCounterparties: analysis.allTimeCounterparties,
    analysisEpoch: analysis.analysisEpoch,
    colorOverrides,
    walletFilters,
    onAutoSort: () => {
      setTableSortKey("score");
      setTableSortDir("desc");
    },
  });
  const graphOverrides = useMemo((): GraphOverrides | undefined => {
    if (graphAdded.size === 0 && graphRemoved.size === 0) return undefined;
    return { added: graphAdded, removed: graphRemoved };
  }, [graphAdded, graphRemoved]);
  const graph = useWalletGraph({
    address: analysis.address,
    identity: analysis.identity,
    filteredCounterparties: merge.filteredCounterparties,
    filteredOverlayWallets: merge.filteredOverlayWallets,
    mergedCounterparties: merge.mergedCounterparties,
    graphTypeFilter,
    graphFlowFilter,
    graphScopeFilter,
    graphScopeNowTs,
    graphNodeBudget,
    setGraphNodeBudget,
    graphOverrides,
    walletColors: merge.walletColors,
    tableSortKey,
    tableSortDir,
  });
  const detail = useCounterpartyDetail({
    address: analysis.address,
    identity: analysis.identity,
    transactions: analysis.transactions,
    txCount: analysis.txCount,
    lastBlockTime: analysis.lastBlockTime,
    analysisEpoch: analysis.analysisEpoch,
    filteredCounterparties: merge.filteredCounterparties,
    overlayWallets: merge.overlayWallets,
    detailIdentityByAddress: merge.detailIdentityByAddress,
    comparisonWallets: merge.comparisonWallets,
    mergedCounterparties: merge.mergedCounterparties,
    currentTableCounterparties: graph.currentTableCounterparties,
    rankedGraphCounterparties: graph.rankedGraphCounterparties,
    effectiveGraphNodeBudget: graph.effectiveGraphNodeBudget,
    isFlowPage: false,
    walletColors: merge.walletColors,
    cacheDetailIdentity: merge.cacheDetailIdentity,
    cacheDetailIdentities: merge.cacheDetailIdentities,
  });

  useEffect(() => {
    setColorOverrides(new Map());
    setWalletFilters(new Map());
    setGraphAdded(new Set());
    setGraphRemoved(new Set());
    setGraphTypeFilter(DEFAULT_GRAPH_TYPE_FILTER);
    setGraphFlowFilter("all");
    setGraphScopeFilter("all");
    setGraphScopeNowTs(Math.floor(Date.now() / 1000));
    setGraphNodeBudget(50);
    setTableSortKey(null);
    setTableSortDir("desc");
  }, [analysis.analysisEpoch]);

  const handleSearch = useCallback(async (address: string) => {
    setCounterpartyRoute(address);
    onRouteAddressChange?.(address);
    await handleWalletLookup(address);
  }, [handleWalletLookup, onRouteAddressChange]);

  const handleNavigate = useCallback((address: string) => {
    void handleSearch(address);
  }, [handleSearch]);

  useEffect(() => {
    if (!initialAddress) {
      if (analysis.address) handleReset();
      return;
    }
    if (initialAddress !== analysis.address) {
      void handleWalletLookup(initialAddress);
    }
  }, [analysis.address, handleReset, handleWalletLookup, initialAddress]);

  const handleHoverAddress = useCallback((nextAddress: string | null) => {
    const container = graphWrapperRef.current;
    if (!container) return;
    const previousNode = container.querySelector(".react-flow__node.node-highlighted");
    if (previousNode) previousNode.classList.remove("node-highlighted");
    const previousLane = container.querySelector(".wallet-flow-lane.flow-lane-highlighted");
    if (previousLane) previousLane.classList.remove("flow-lane-highlighted");
    if (!nextAddress) return;
    const nodeElement = container.querySelector(`.react-flow__node[data-id="${CSS.escape(nextAddress)}"]`);
    if (nodeElement) nodeElement.classList.add("node-highlighted");
    const laneElement = container.querySelector(
      `.wallet-flow-lane[data-flow-address="${CSS.escape(nextAddress)}"]`,
    );
    if (laneElement) laneElement.classList.add("flow-lane-highlighted");
  }, []);

  const handleColorChange = useCallback((walletIndex: number, color: string) => {
    setColorOverrides((prev) => {
      const next = new Map(prev);
      next.set(walletIndex, color);
      return next;
    });
  }, []);

  const handleWalletFilterChange = useCallback((walletIndex: number, filter: WalletFilter) => {
    setWalletFilters((prev) => {
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

  const handleGraphAddNode = useCallback((address: string) => {
    setGraphAdded((prev) => {
      const next = new Set(prev);
      next.add(address);
      return next;
    });
    setGraphRemoved((prev) => {
      const next = new Set(prev);
      next.delete(address);
      return next;
    });
  }, []);

  const handleGraphRemoveNode = useCallback((address: string) => {
    setGraphRemoved((prev) => {
      const next = new Set(prev);
      next.add(address);
      return next;
    });
    setGraphAdded((prev) => {
      const next = new Set(prev);
      next.delete(address);
      return next;
    });
  }, []);

  const hasOverlayComparison = merge.overlayWallets.length > 0;

  if (!analysis.address && !analysis.loading) {
    return (
      <ExplorerLanding
        mode="wallet"
        action={(
          <div className="w-full">
            <SearchBar
              key="counterparties:empty"
              onSearch={handleSearch}
              loading={analysis.loading}
              defaultValue={analysis.searchDisplayValue}
              autoFocus
              enableShortcut
            />
          </div>
        )}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-none border-b border-border bg-card/70 px-3 py-2">
        <SearchBar
          key={`counterparties:${analysis.address}:header`}
          onSearch={handleSearch}
          loading={analysis.loading}
          defaultValue={analysis.searchDisplayValue}
          autoFocus={Boolean(analysis.address)}
          enableShortcut={Boolean(analysis.address)}
        />
      </div>

      {analysis.address && !analysis.walletError && (
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border bg-background/70 px-3 py-1.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            {analysis.historyMode === "quick"
              ? `Quick scan · recent ${analysis.txCount.toLocaleString()} tx loaded`
              : `Full history loaded · ${analysis.txCount.toLocaleString()} tx analyzed`}
          </div>
          {analysis.historyMode === "quick" && (
            <button
              type="button"
              onClick={() => {
                void analysis.handleLoadFullHistory();
              }}
              disabled={analysis.fullHistoryLoading || analysis.loading}
              className="rounded border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.18em] text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {analysis.fullHistoryLoading ? "Loading full history..." : "Load full history"}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-none border-b border-border">
          <WalletProfile
            address={analysis.address}
            identity={analysis.identity}
            balances={analysis.balances}
            funding={analysis.funding}
            loading={analysis.identityLoading && analysis.balancesLoading && analysis.fundingLoading}
            identityLoading={analysis.identityLoading}
            balancesLoading={analysis.balancesLoading}
            fundingLoading={analysis.fundingLoading}
            identityFailed={Boolean(analysis.identityError)}
            balancesFailed={Boolean(analysis.balancesError)}
            fundingFailed={Boolean(analysis.fundingError)}
            counterpartyCount={analysis.counterparties.length}
            txCount={analysis.txCount}
            onNavigate={handleNavigate}
          />
        </div>

        <div className="flex-none border-b border-border">
          <WalletInsightsStrip
            insights={merge.walletInsights}
            loading={analysis.tableLoading}
            selectedAddress={detail.selectedCounterpartyAddress}
            onSelectAddress={detail.setSelectedCounterpartyAddress}
            onGraphPresetChange={handleGraphPresetChange}
          />
        </div>

        {analysis.walletError && (
          <div className="flex flex-none items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="font-mono text-[10px] text-destructive/90">{analysis.walletError}</span>
            <button
              onClick={() => {
                void analysis.handleWalletLookup(analysis.address);
              }}
              className="rounded border border-destructive/40 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.2em] text-destructive transition-colors hover:bg-destructive/10"
            >
              Retry
            </button>
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          <div ref={graphWrapperRef} className="relative flex-1 overflow-hidden">
            {hasOverlayComparison && (
              <div className="absolute right-3 top-3 z-20 rounded border border-primary/20 bg-card/90 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.18em] text-primary">
                Topology
              </div>
            )}
            <WalletConnectionsCoachmark
              comparedCount={merge.overlayWallets.length + 1}
              selectedLabel={
                detail.currentSelectedCounterpartyDetail
                  ? detail.currentSelectedCounterpartyDetail.label
                    ?? detail.currentSelectedCounterpartyDetail.tokenSymbol
                    ?? detail.currentSelectedCounterpartyDetail.tokenName
                    ?? truncAddr(detail.currentSelectedCounterpartyDetail.address)
                  : null
              }
            />

            <TransactionGraph
              nodes={graph.nodes}
              edges={graph.edges}
              loading={analysis.graphLoading}
              onNavigate={handleNavigate}
              onAddOverlay={merge.handleAddOverlay}
              onRemoveNode={handleGraphRemoveNode}
              canAddOverlay={!analysis.loading && !!analysis.address}
              selectedAddress={detail.selectedCounterpartyAddress}
              onSelectAddress={detail.setSelectedCounterpartyAddress}
            />
          </div>

          <div className="flex w-[420px] flex-none flex-col overflow-hidden border-l border-border">
            <div className="flex-none border-b border-border">
              <CounterpartyDetailPanel
                detail={detail.currentSelectedCounterpartyDetail}
                loading={analysis.tableLoading}
                graphAddresses={graph.graphAddresses}
                onNavigate={handleNavigate}
                onAddNode={handleGraphAddNode}
                onRemoveNode={handleGraphRemoveNode}
                onAddOverlay={merge.handleAddOverlay}
                surface="graph"
                highlightCompareAction={!hasOverlayComparison}
                forensicSignals={detail.selectedForensicData?.signals}
                forensicScore={detail.selectedForensicData?.totalScore}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <CounterpartyTable
                key={`${analysis.address}:table`}
                counterparties={graph.currentTableCounterparties}
                loading={analysis.tableLoading}
                onNavigate={handleNavigate}
                onHoverAddress={handleHoverAddress}
                selectedAddress={detail.selectedCounterpartyAddress}
                onSelectAddress={detail.setSelectedCounterpartyAddress}
                graphAddresses={graph.graphAddresses}
                onAddNode={handleGraphAddNode}
                onRemoveNode={handleGraphRemoveNode}
                onAddOverlay={merge.handleAddOverlay}
                onTimeRangeChange={analysis.handleTimeRangeChange}
                graphFlowFilter={graphFlowFilter}
                onGraphFlowFilterChange={handleGraphFlowFilterChange}
                sortKey={tableSortKey}
                sortDir={tableSortDir}
                onSortChange={handleTableSortChange}
                surface="graph"
              />
            </div>
            <div className="flex-none border-t border-border">
              <WalletOverlayPanel
                primaryAddress={analysis.address}
                primaryIdentity={analysis.identity}
                overlayWallets={merge.overlayWallets}
                walletColors={merge.walletColors}
                onAdd={merge.handleAddOverlay}
                onRemove={merge.handleRemoveOverlay}
                onColorChange={handleColorChange}
                disabled={!analysis.address}
                walletFilters={walletFilters}
                walletStats={merge.walletStats}
                onWalletFilterChange={handleWalletFilterChange}
                sharedFunders={merge.sharedFunders}
                suggestedComparisons={merge.suggestedComparisons}
              />
            </div>
          </div>
        </div>
      </div>

      <footer className="flex-none border-t border-border px-3 py-0.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
            {analysis.counterparties.length > 0 ? `${analysis.counterparties.length} Counterparties` : ""}
            {analysis.txCount > 0 && ` | ${analysis.txCount} TX Analyzed`}
          </span>
          <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
            {analysis.lastBlockTime > 0
              && `Last Scan: ${new Date(analysis.lastBlockTime * 1000).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}`}
          </span>
          <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#00ff88]" />
            Helius RPC
          </span>
        </div>
      </footer>
    </div>
  );
}
