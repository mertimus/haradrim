import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getBatchIdentity, getIdentity, type WalletIdentity } from "@/api";
import type { SelectedCounterpartyDetail } from "@/components/CounterpartyDetailPanel";
import type { FlowTransferHistoryItem } from "@/components/FlowTransferHistoryPanel";
import {
  getEnhancedCounterpartyHistory,
  getWalletPairSignals,
  type WalletPairSignal,
  type WalletPairSignalsResult,
} from "@/lib/backend-api";
import type { CounterpartyFlow, OverlayWallet, ParsedTransaction } from "@/lib/parse-transactions";
import type { ComparisonWallet, CounterpartyDisplay } from "@/lib/wallet-explorer";
import { describeWallet } from "@/lib/wallet-explorer";

interface UseCounterpartyDetailParams {
  address: string;
  identity: WalletIdentity | null;
  transactions: ParsedTransaction[];
  txCount: number;
  lastBlockTime: number;
  analysisEpoch: number;
  filteredCounterparties: CounterpartyFlow[];
  overlayWallets: OverlayWallet[];
  detailIdentityByAddress: Map<string, WalletIdentity | null>;
  comparisonWallets: ComparisonWallet[];
  mergedCounterparties: CounterpartyDisplay[];
  currentTableCounterparties: CounterpartyDisplay[];
  rankedGraphCounterparties: CounterpartyFlow[];
  effectiveGraphNodeBudget: number;
  isFlowPage: boolean;
  walletColors: string[];
  cacheDetailIdentity: (address: string, identity: WalletIdentity | null) => void;
  cacheDetailIdentities: (entries: Iterable<[string, WalletIdentity | null]>) => void;
}

export interface SelectedForensicData {
  signals: WalletPairSignal[];
  totalScore: number;
}

export interface UseCounterpartyDetailResult {
  selectedCounterpartyAddress: string | null;
  setSelectedCounterpartyAddress: Dispatch<SetStateAction<string | null>>;
  currentSelectedCounterpartyDetail: SelectedCounterpartyDetail | null;
  flowTransferHistory: FlowTransferHistoryItem[];
  flowHistoryLoading: boolean;
  flowHistoryError: string | null;
  walletPairSignals: WalletPairSignalsResult[];
  selectedForensicData: SelectedForensicData | null;
}

export function useCounterpartyDetail({
  address,
  identity,
  transactions,
  txCount,
  lastBlockTime,
  analysisEpoch,
  filteredCounterparties,
  overlayWallets,
  detailIdentityByAddress,
  comparisonWallets,
  mergedCounterparties,
  currentTableCounterparties,
  rankedGraphCounterparties,
  effectiveGraphNodeBudget,
  isFlowPage,
  walletColors,
  cacheDetailIdentity,
  cacheDetailIdentities,
}: UseCounterpartyDetailParams): UseCounterpartyDetailResult {
  const [selectedCounterpartyAddress, setSelectedCounterpartyAddress] = useState<string | null>(null);
  const pendingIdentityAddressesRef = useRef<Set<string>>(new Set());
  const [walletPairSignals, setWalletPairSignals] = useState<WalletPairSignalsResult[]>([]);
  const walletPairSignalsRequestRef = useRef(0);
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

  useEffect(() => {
    pendingIdentityAddressesRef.current = new Set();
    walletPairSignalsRequestRef.current += 1;
    flowHistoryRequestIdRef.current += 1;
    flowHistoryCacheRef.current = new Map();
    setSelectedCounterpartyAddress(null);
    setWalletPairSignals([]);
    setFlowHistoryLoading(false);
    setFlowHistoryError(null);
    setFlowEnhancedBySignature(new Map());
  }, [analysisEpoch]);

  useEffect(() => {
    if (!selectedCounterpartyAddress) return;
    if (detailIdentityByAddress.has(selectedCounterpartyAddress)) return;

    let cancelled = false;
    void getIdentity(selectedCounterpartyAddress)
      .then((result) => {
        if (cancelled) return;
        cacheDetailIdentity(selectedCounterpartyAddress, result);
      })
      .catch(() => {
        if (cancelled) return;
        cacheDetailIdentity(selectedCounterpartyAddress, null);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheDetailIdentity, detailIdentityByAddress, selectedCounterpartyAddress]);

  const selectedCounterpartyDetail = useMemo((): SelectedCounterpartyDetail | null => {
    if (!selectedCounterpartyAddress) return null;
    const counterparty = mergedCounterparties.find((cp) => cp.address === selectedCounterpartyAddress);
    if (!counterparty) return null;

    const identityOverride = detailIdentityByAddress.get(selectedCounterpartyAddress);
    const connectedWallets = comparisonWallets
      .filter((wallet) => wallet.counterparties.some((cp) => cp.address === counterparty.address))
      .map((wallet) => ({
        address: wallet.address,
        label: wallet.label,
        color: wallet.color,
        role: wallet.role,
      }));

    return {
      address: counterparty.address,
      label: counterparty.label ?? identityOverride?.label ?? identityOverride?.name,
      category: counterparty.category ?? identityOverride?.category,
      accountType: counterparty.accountType,
      tokenName: counterparty.tokenName,
      tokenSymbol: counterparty.tokenSymbol,
      txCount: counterparty.txCount,
      solSent: counterparty.solSent,
      solReceived: counterparty.solReceived,
      solNet: counterparty.solNet,
      firstSeen: counterparty.firstSeen,
      lastSeen: counterparty.lastSeen,
      connectedWallets,
      sourceStats: counterparty.sourceStats,
      connectionScore: counterparty.connectionScore,
    };
  }, [comparisonWallets, detailIdentityByAddress, mergedCounterparties, selectedCounterpartyAddress]);

  const flowSelectedCounterpartyDetail = useMemo((): SelectedCounterpartyDetail | null => {
    if (!selectedCounterpartyAddress) return null;
    const counterparty = filteredCounterparties.find((cp) => cp.address === selectedCounterpartyAddress);
    if (!counterparty) return null;

    const identityOverride = detailIdentityByAddress.get(selectedCounterpartyAddress);
    return {
      address: counterparty.address,
      label: counterparty.label ?? identityOverride?.label ?? identityOverride?.name,
      category: counterparty.category ?? identityOverride?.category,
      accountType: counterparty.accountType,
      tokenName: counterparty.tokenName,
      tokenSymbol: counterparty.tokenSymbol,
      txCount: counterparty.txCount,
      solSent: counterparty.solSent,
      solReceived: counterparty.solReceived,
      solNet: counterparty.solNet,
      firstSeen: counterparty.firstSeen,
      lastSeen: counterparty.lastSeen,
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

  const selectedForensicData = useMemo((): SelectedForensicData | null => {
    if (walletPairSignals.length === 0 || !selectedCounterpartyAddress) return null;
    const bestByKind = new Map<string, WalletPairSignal>();
    for (const pairResult of walletPairSignals) {
      const match = pairResult.signals.find((signal) => signal.counterparty === selectedCounterpartyAddress);
      if (!match) continue;
      for (const signal of match.signals) {
        const existing = bestByKind.get(signal.kind);
        if (!existing || signal.score > existing.score) {
          bestByKind.set(signal.kind, signal);
        }
      }
    }
    if (bestByKind.size === 0) return null;
    const signals = [...bestByKind.values()];
    const totalScore = signals.reduce((sum, signal) => sum + signal.score, 0);
    return { signals, totalScore };
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

    for (const nextAddress of uniqueAddresses) {
      pendingIdentityAddressesRef.current.add(nextAddress);
    }

    let cancelled = false;
    void getBatchIdentity(uniqueAddresses)
      .then((identityMap) => {
        if (cancelled) return;
        cacheDetailIdentities(uniqueAddresses.map((nextAddress) => [nextAddress, identityMap.get(nextAddress) ?? null]));
      })
      .catch(() => {
        if (cancelled) return;
        cacheDetailIdentities(uniqueAddresses.map((nextAddress) => [nextAddress, null]));
      })
      .finally(() => {
        for (const nextAddress of uniqueAddresses) {
          pendingIdentityAddressesRef.current.delete(nextAddress);
        }
      });

    return () => {
      cancelled = true;
      for (const nextAddress of uniqueAddresses) {
        pendingIdentityAddressesRef.current.delete(nextAddress);
      }
    };
  }, [
    cacheDetailIdentities,
    currentTableCounterparties,
    detailIdentityByAddress,
    effectiveGraphNodeBudget,
    rankedGraphCounterparties,
  ]);

  useEffect(() => {
    const readyOverlays = overlayWallets.filter((wallet) => !wallet.loading && !wallet.error);
    if (readyOverlays.length === 0 || !address) {
      setWalletPairSignals([]);
      return;
    }

    const rid = ++walletPairSignalsRequestRef.current;

    void Promise.all(
      readyOverlays.map((wallet) => getWalletPairSignals(address, wallet.address).catch(() => null)),
    ).then((results) => {
      if (rid !== walletPairSignalsRequestRef.current) return;
      setWalletPairSignals(results.filter((result): result is WalletPairSignalsResult => result != null));
    });

    return () => {
      walletPairSignalsRequestRef.current += 1;
    };
  }, [address, overlayWallets]);

  // Pre-build index: counterparty address → relevant transactions
  const txByCounterparty = useMemo(() => {
    const index = new Map<string, ParsedTransaction[]>();
    for (const tx of transactions) {
      const seen = new Set<string>();
      for (const transfer of tx.transfers) {
        if (transfer.counterparty && !seen.has(transfer.counterparty)) {
          seen.add(transfer.counterparty);
          let list = index.get(transfer.counterparty);
          if (!list) {
            list = [];
            index.set(transfer.counterparty, list);
          }
          list.push(tx);
        }
      }
    }
    return index;
  }, [transactions]);

  const flowTransferHistory = useMemo<FlowTransferHistoryItem[]>(() => {
    if (!selectedCounterpartyAddress) return [];

    const relevantTxs = txByCounterparty.get(selectedCounterpartyAddress) ?? [];
    return relevantTxs
      .map((tx) => {
        const transfers = tx.transfers.filter((transfer) => transfer.counterparty === selectedCounterpartyAddress);
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
          targetMap.set(transfer.assetId, {
            assetId: transfer.assetId,
            kind: transfer.kind,
            mint: transfer.mint,
            symbol: transfer.symbol,
            name: transfer.name,
            logoUri: transfer.logoUri,
            uiAmount: (existing?.uiAmount ?? 0) + transfer.uiAmount,
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
  }, [flowEnhancedBySignature, selectedCounterpartyAddress, txByCounterparty]);

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
    const selectableCounterparties = isFlowPage ? filteredCounterparties : currentTableCounterparties;
    if (selectableCounterparties.length === 0) {
      if (selectedCounterpartyAddress != null) setSelectedCounterpartyAddress(null);
      return;
    }
    if (
      selectedCounterpartyAddress
      && !selectableCounterparties.some((cp) => cp.address === selectedCounterpartyAddress)
    ) {
      setSelectedCounterpartyAddress(null);
    }
  }, [currentTableCounterparties, filteredCounterparties, isFlowPage, selectedCounterpartyAddress]);

  return {
    selectedCounterpartyAddress,
    setSelectedCounterpartyAddress,
    currentSelectedCounterpartyDetail,
    flowTransferHistory,
    flowHistoryLoading,
    flowHistoryError,
    walletPairSignals,
    selectedForensicData,
  };
}
