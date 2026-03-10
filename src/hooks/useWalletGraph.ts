import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { WalletIdentity } from "@/api";
import type { CounterpartySortDir, CounterpartySortKey } from "@/components/CounterpartyTable";
import { sortCounterparties } from "@/lib/counterparty-sorting";
import {
  buildGraphData,
  buildMergedGraphData,
  countSharedCounterparties,
  projectCounterpartiesForGraphFlow,
  type CounterpartyFlow,
  type GraphFlowFilter,
  type GraphOverrides,
  type OverlayWallet,
} from "@/lib/parse-transactions";
import {
  filterCounterpartiesByGraphScope,
  sortCounterpartiesByTableOrder,
  type CounterpartyDisplay,
  type GraphScopeFilter,
  type GraphTypeFilter,
} from "@/lib/wallet-explorer";

interface UseWalletGraphParams {
  address: string;
  identity: WalletIdentity | null;
  filteredCounterparties: CounterpartyFlow[];
  filteredOverlayWallets: OverlayWallet[];
  mergedCounterparties: CounterpartyDisplay[];
  graphTypeFilter: GraphTypeFilter;
  graphFlowFilter: GraphFlowFilter;
  graphScopeFilter: GraphScopeFilter;
  graphScopeNowTs: number;
  graphNodeBudget: number;
  setGraphNodeBudget: Dispatch<SetStateAction<number>>;
  graphOverrides?: GraphOverrides;
  walletColors: string[];
  tableSortKey: CounterpartySortKey | null;
  tableSortDir: CounterpartySortDir;
}

export interface UseWalletGraphResult {
  nodes: Node[];
  edges: Edge[];
  graphAddresses: Set<string>;
  currentTableCounterparties: CounterpartyDisplay[];
  rankedGraphCounterparties: CounterpartyFlow[];
  effectiveGraphNodeBudget: number;
}

export function useWalletGraph({
  address,
  identity,
  filteredCounterparties,
  filteredOverlayWallets,
  mergedCounterparties,
  graphTypeFilter,
  graphFlowFilter,
  graphScopeFilter,
  graphScopeNowTs,
  graphNodeBudget,
  setGraphNodeBudget,
  graphOverrides,
  walletColors,
  tableSortKey,
  tableSortDir,
}: UseWalletGraphParams): UseWalletGraphResult {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const workerRef = useRef<Worker | null>(null);

  const currentTableCounterparties = useMemo(
    () => sortCounterparties(mergedCounterparties, tableSortKey, tableSortDir),
    [mergedCounterparties, tableSortKey, tableSortDir],
  );

  const graphRankByAddress = useMemo(() => {
    const rank = new Map<string, number>();
    currentTableCounterparties.forEach((cp, index) => {
      rank.set(cp.address, index);
    });
    return rank;
  }, [currentTableCounterparties]);

  const directionalGraphCounterparties = useMemo(
    () => projectCounterpartiesForGraphFlow(filteredCounterparties, graphFlowFilter),
    [filteredCounterparties, graphFlowFilter],
  );

  const graphCounterparties = useMemo(() => {
    const { wallet, token, program } = graphTypeFilter;
    if (wallet && token && program) return directionalGraphCounterparties;
    return directionalGraphCounterparties.filter((cp) => {
      const type = cp.accountType;
      if (type === "wallet" || !type) return wallet;
      if (type === "token") return token;
      if (type === "program") return program;
      return wallet;
    });
  }, [directionalGraphCounterparties, graphTypeFilter]);

  const directionalOverlayWallets = useMemo(
    () => filteredOverlayWallets.map((wallet) => ({
      ...wallet,
      counterparties: projectCounterpartiesForGraphFlow(wallet.counterparties, graphFlowFilter),
    })),
    [filteredOverlayWallets, graphFlowFilter],
  );

  const graphOverlayWallets = useMemo(() => {
    const { wallet: showWallets, token, program } = graphTypeFilter;
    if (showWallets && token && program) return directionalOverlayWallets;
    return directionalOverlayWallets.map((overlay) => ({
      ...overlay,
      counterparties: overlay.counterparties.filter((cp) => {
        const type = cp.accountType;
        if (type === "wallet" || !type) return showWallets;
        if (type === "token") return token;
        if (type === "program") return program;
        return showWallets;
      }),
    }));
  }, [directionalOverlayWallets, graphTypeFilter]);

  const sharedGraphAddresses = useMemo(() => {
    const counts = new Map<string, number>();
    const readyOverlays = graphOverlayWallets.filter((wallet) => !wallet.loading && !wallet.error);

    for (const cp of graphCounterparties) {
      counts.set(cp.address, 1);
    }

    for (const wallet of readyOverlays) {
      const seen = new Set<string>();
      for (const cp of wallet.counterparties) {
        seen.add(cp.address);
      }
      for (const nextAddress of seen) {
        counts.set(nextAddress, (counts.get(nextAddress) ?? 0) + 1);
      }
    }

    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([nextAddress]) => nextAddress),
    );
  }, [graphCounterparties, graphOverlayWallets]);

  const scopedGraphCounterparties = useMemo(
    () => filterCounterpartiesByGraphScope(
      graphCounterparties,
      graphScopeFilter,
      sharedGraphAddresses,
      graphScopeNowTs,
    ),
    [graphCounterparties, graphScopeFilter, sharedGraphAddresses, graphScopeNowTs],
  );

  const scopedGraphOverlayWallets = useMemo(
    () => graphOverlayWallets.map((wallet) => ({
      ...wallet,
      counterparties: filterCounterpartiesByGraphScope(
        wallet.counterparties,
        graphScopeFilter,
        sharedGraphAddresses,
        graphScopeNowTs,
      ),
    })),
    [graphOverlayWallets, graphScopeFilter, sharedGraphAddresses, graphScopeNowTs],
  );

  const rankedGraphCounterparties = useMemo(
    () => sortCounterpartiesByTableOrder(scopedGraphCounterparties, graphRankByAddress),
    [scopedGraphCounterparties, graphRankByAddress],
  );

  const rankedGraphOverlayWallets = useMemo(
    () => scopedGraphOverlayWallets.map((wallet) => ({
      ...wallet,
      counterparties: sortCounterpartiesByTableOrder(wallet.counterparties, graphRankByAddress),
    })),
    [scopedGraphOverlayWallets, graphRankByAddress],
  );

  const readyGraphWallets = useMemo(() => {
    const readyOverlays = rankedGraphOverlayWallets.filter((wallet) => !wallet.loading && !wallet.error);
    return [
      { address, counterparties: rankedGraphCounterparties },
      ...readyOverlays.map((wallet) => ({
        address: wallet.address,
        counterparties: wallet.counterparties,
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
  }, [graphNodeBudget, minGraphNodeBudget, setGraphNodeBudget]);

  useEffect(() => {
    const existingWorker = workerRef.current;
    if (existingWorker) {
      existingWorker.onmessage = null;
      existingWorker.onerror = null;
      existingWorker.terminate();
      workerRef.current = null;
    }

    if (!address) {
      setNodes([]);
      setEdges([]);
      return;
    }

    if (rankedGraphCounterparties.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const readyOverlays = rankedGraphOverlayWallets.filter((wallet) => !wallet.loading && !wallet.error);

    if (readyOverlays.length === 0) {
      const graphData = buildGraphData(
        address,
        rankedGraphCounterparties,
        identity,
        graphOverrides,
        effectiveGraphNodeBudget,
      );
      setNodes(graphData.nodes);
      setEdges(graphData.edges);
      return;
    }

    const wallets = [
      { address, counterparties: scopedGraphCounterparties, identity },
      ...readyOverlays.map((wallet) => ({
        address: wallet.address,
        counterparties: wallet.counterparties,
        identity: wallet.identity,
      })),
    ];
    const totalNodes = wallets.reduce((sum, wallet) => sum + wallet.counterparties.length, wallets.length);
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
    workerRef.current = worker;

    const simData = graphData.forceSimData;
    worker.postMessage({ nodes: simData.simNodes, links: simData.simLinks });
    worker.onmessage = (event: MessageEvent<{ positions: Record<string, { x: number; y: number }> }>) => {
      if (workerRef.current !== worker) return;
      const { positions } = event.data;
      setNodes((prev) => prev.map((node) => {
        const position = positions[node.id];
        return position ? { ...node, position } : node;
      }));
      workerRef.current = null;
      worker.terminate();
    };
    worker.onerror = () => {
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      worker.terminate();
    };

    return () => {
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
  }, [
    address,
    effectiveGraphNodeBudget,
    graphOverrides,
    graphRankByAddress,
    identity,
    rankedGraphCounterparties,
    rankedGraphOverlayWallets,
    scopedGraphCounterparties,
    walletColors,
  ]);

  const graphAddresses = useMemo(
    () => new Set(nodes.map((node) => node.id)),
    [nodes],
  );

  return {
    nodes,
    edges,
    graphAddresses,
    currentTableCounterparties,
    rankedGraphCounterparties,
    effectiveGraphNodeBudget,
  };
}
