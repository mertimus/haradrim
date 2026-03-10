import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFunding, type FundingSource, type WalletIdentity } from "@/api";
import type { WalletInsight } from "@/components/WalletInsightsStrip";
import { getWalletAnalysis } from "@/lib/backend-api";
import {
  countSharedCounterparties,
  getWalletColor,
  type CounterpartyFlow,
  type OverlayWallet,
} from "@/lib/parse-transactions";
import {
  applyCounterpartyIdentityOverrides,
  applyWalletFilter,
  buildWalletInsights,
  computeWalletStats,
  describeWallet,
  mergeDisplayCounterparties,
  type ComparisonWallet,
  type CounterpartyDisplay,
  type SharedFunder,
  type WalletFilter,
  type WalletStats,
} from "@/lib/wallet-explorer";

interface UseCounterpartyMergeParams {
  address: string;
  identity: WalletIdentity | null;
  funding: FundingSource | null;
  counterparties: CounterpartyFlow[];
  allTimeCounterparties: CounterpartyFlow[];
  analysisEpoch: number;
  colorOverrides: Map<number, string>;
  walletFilters: Map<number, WalletFilter>;
  onAutoSort: () => void;
}

export interface UseCounterpartyMergeResult {
  overlayWallets: OverlayWallet[];
  walletColors: string[];
  detailIdentityByAddress: Map<string, WalletIdentity | null>;
  enrichedCounterparties: CounterpartyFlow[];
  enrichedAllTimeCounterparties: CounterpartyFlow[];
  filteredCounterparties: CounterpartyFlow[];
  filteredOverlayWallets: OverlayWallet[];
  comparisonWallets: ComparisonWallet[];
  mergedCounterparties: CounterpartyDisplay[];
  walletInsights: WalletInsight[];
  suggestedComparisons: Array<{ address: string; reason: string }>;
  sharedFunders: SharedFunder[];
  walletStats: WalletStats[];
  handleAddOverlay: (address: string) => Promise<void>;
  handleRemoveOverlay: (address: string) => void;
  cacheDetailIdentity: (address: string, identity: WalletIdentity | null) => void;
  cacheDetailIdentities: (entries: Iterable<[string, WalletIdentity | null]>) => void;
}

export function useCounterpartyMerge({
  address,
  identity,
  funding,
  counterparties,
  allTimeCounterparties,
  analysisEpoch,
  colorOverrides,
  walletFilters,
  onAutoSort,
}: UseCounterpartyMergeParams): UseCounterpartyMergeResult {
  const [overlayWallets, setOverlayWallets] = useState<OverlayWallet[]>([]);
  const [detailIdentityByAddress, setDetailIdentityByAddress] = useState<Map<string, WalletIdentity | null>>(new Map());
  const overlayRequestIdsRef = useRef(new Map<string, number>());
  const hasAutoSortedRef = useRef(false);
  const analysisEpochRef = useRef(analysisEpoch);

  useEffect(() => {
    analysisEpochRef.current = analysisEpoch;
    overlayRequestIdsRef.current = new Map();
    hasAutoSortedRef.current = false;
    setOverlayWallets([]);
  }, [analysisEpoch]);

  const cacheDetailIdentity = useCallback((nextAddress: string, nextIdentity: WalletIdentity | null) => {
    setDetailIdentityByAddress((prev) => {
      if (prev.has(nextAddress)) return prev;
      const next = new Map(prev);
      next.set(nextAddress, nextIdentity);
      return next;
    });
  }, []);

  const cacheDetailIdentities = useCallback((entries: Iterable<[string, WalletIdentity | null]>) => {
    setDetailIdentityByAddress((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const [nextAddress, nextIdentity] of entries) {
        if (next.has(nextAddress)) continue;
        next.set(nextAddress, nextIdentity);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const enrichedCounterparties = useMemo(
    () => applyCounterpartyIdentityOverrides(counterparties, detailIdentityByAddress),
    [counterparties, detailIdentityByAddress],
  );

  const walletColors = useMemo(
    () => Array.from({ length: overlayWallets.length + 1 }, (_, index) => getWalletColor(index, colorOverrides)),
    [colorOverrides, overlayWallets.length],
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

  const filteredCounterparties = useMemo(
    () => applyWalletFilter(enrichedCounterparties, walletFilters.get(0)),
    [enrichedCounterparties, walletFilters],
  );

  const filteredOverlayWallets = useMemo(
    () => enrichedOverlayWallets.map((wallet, index) => ({
      ...wallet,
      counterparties: applyWalletFilter(wallet.counterparties, walletFilters.get(index + 1)),
    })),
    [enrichedOverlayWallets, walletFilters],
  );

  const comparisonWallets = useMemo<ComparisonWallet[]>(() => {
    const readyOverlays = filteredOverlayWallets.filter((wallet) => !wallet.loading && !wallet.error);
    return [
      {
        address,
        label: describeWallet(address, identity),
        color: walletColors[0],
        role: "Primary",
        counterparties: filteredCounterparties,
      },
      ...readyOverlays.map((wallet, index) => ({
        address: wallet.address,
        label: describeWallet(wallet.address, wallet.identity),
        color: walletColors[index + 1],
        role: "Overlay" as const,
        counterparties: wallet.counterparties,
      })),
    ];
  }, [address, filteredCounterparties, filteredOverlayWallets, identity, walletColors]);

  const mergedCounterparties = useMemo(
    () => mergeDisplayCounterparties(filteredCounterparties, filteredOverlayWallets, address, walletColors),
    [filteredCounterparties, filteredOverlayWallets, address, walletColors],
  );

  const sharedComparisonCount = useMemo(
    () => countSharedCounterparties(
      comparisonWallets.map((wallet) => ({
        address: wallet.address,
        counterparties: wallet.counterparties,
      })),
    ),
    [comparisonWallets],
  );

  const sharedFunders = useMemo<SharedFunder[]>(() => {
    const readyOverlays = overlayWallets.filter((wallet) => !wallet.loading && !wallet.error);
    if (readyOverlays.length === 0 || !funding) return [];
    return readyOverlays
      .filter((wallet) => wallet.funding?.address === funding.address)
      .map((wallet) => ({
        overlayAddress: wallet.address,
        funderAddress: funding.address,
        funderLabel: funding.label ?? wallet.funding?.label,
      }));
  }, [funding, overlayWallets]);

  const suggestedComparisons = useMemo(() => {
    if (overlayWallets.length > 0) return [];

    const suggestions: Array<{ address: string; reason: string }> = [];
    const seen = new Set<string>([address]);

    if (funding?.address && !seen.has(funding.address)) {
      suggestions.push({
        address: funding.address,
        reason: `Funder${funding.label ? ` (${funding.label})` : ""}`,
      });
      seen.add(funding.address);
    }

    let topMutual: CounterpartyFlow | null = null;
    let topMutualVol = -1;
    let topFrequency: CounterpartyFlow | null = null;
    let topFrequencyTx = -1;

    for (const cp of filteredCounterparties) {
      if (seen.has(cp.address) || cp.accountType === "program" || cp.accountType === "token") continue;
      if (cp.solSent > 0 && cp.solReceived > 0) {
        const volume = cp.solSent + cp.solReceived;
        if (volume > topMutualVol) {
          topMutual = cp;
          topMutualVol = volume;
        }
      }
      if (cp.txCount > topFrequencyTx) {
        topFrequency = cp;
        topFrequencyTx = cp.txCount;
      }
    }

    if (topMutual) {
      suggestions.push({
        address: topMutual.address,
        reason: `Top mutual${topMutual.label ? ` (${topMutual.label})` : ""}`,
      });
      seen.add(topMutual.address);
    }

    if (topFrequency && !seen.has(topFrequency.address)) {
      suggestions.push({
        address: topFrequency.address,
        reason: `Most active (${topFrequency.txCount} tx)`,
      });
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

  const walletInsights = useMemo(
    () => buildWalletInsights({
      enrichedAllTimeCounterparties,
      filteredCounterparties,
      sharedComparisonCount,
      sharedFunders,
      strongestSharedCounterparty,
    }),
    [
      enrichedAllTimeCounterparties,
      filteredCounterparties,
      sharedComparisonCount,
      sharedFunders,
      strongestSharedCounterparty,
    ],
  );

  const walletStats = useMemo<WalletStats[]>(
    () => [
      computeWalletStats(enrichedCounterparties, walletFilters.get(0)),
      ...enrichedOverlayWallets.map((wallet, index) => computeWalletStats(wallet.counterparties, walletFilters.get(index + 1))),
    ],
    [enrichedCounterparties, enrichedOverlayWallets, walletFilters],
  );

  const handleAddOverlay = useCallback(async (overlayAddress: string) => {
    if (!overlayAddress || overlayAddress === address) return;
    if (overlayWallets.some((wallet) => wallet.address === overlayAddress)) return;

    const walletGeneration = analysisEpochRef.current;
    const requestId = (overlayRequestIdsRef.current.get(overlayAddress) ?? 0) + 1;
    overlayRequestIdsRef.current.set(overlayAddress, requestId);

    setOverlayWallets((prev) => [
      ...prev,
      {
        address: overlayAddress,
        identity: null,
        counterparties: [],
        loading: true,
      },
    ]);

    try {
      const existingCounterparty = enrichedCounterparties.find((cp) => cp.address === overlayAddress)
        ?? enrichedOverlayWallets.flatMap((wallet) => wallet.counterparties).find((cp) => cp.address === overlayAddress);
      const overlayIdentity: WalletIdentity | null = existingCounterparty?.label
        ? {
            address: overlayAddress,
            name: existingCounterparty.label,
            label: existingCounterparty.label,
            category: existingCounterparty.category,
          }
        : null;
      const [analysis, overlayFunding] = await Promise.all([
        getWalletAnalysis(overlayAddress),
        getFunding(overlayAddress).catch(() => null),
      ]);
      if (analysisEpochRef.current !== walletGeneration) return;
      if (overlayRequestIdsRef.current.get(overlayAddress) !== requestId) return;

      setOverlayWallets((prev) =>
        prev.map((wallet) => (
          wallet.address === overlayAddress
            ? {
                ...wallet,
                identity: overlayIdentity,
                counterparties: analysis.counterparties,
                funding: overlayFunding,
                loading: false,
                error: undefined,
              }
            : wallet
        )),
      );

      if (!hasAutoSortedRef.current) {
        hasAutoSortedRef.current = true;
        onAutoSort();
      }
    } catch (err) {
      if (analysisEpochRef.current !== walletGeneration) return;
      if (overlayRequestIdsRef.current.get(overlayAddress) !== requestId) return;
      setOverlayWallets((prev) =>
        prev.map((wallet) => (
          wallet.address === overlayAddress
            ? { ...wallet, loading: false, error: err instanceof Error ? err.message : "Failed" }
            : wallet
        )),
      );
    }
  }, [address, enrichedCounterparties, enrichedOverlayWallets, onAutoSort, overlayWallets]);

  const handleRemoveOverlay = useCallback((overlayAddress: string) => {
    overlayRequestIdsRef.current.set(
      overlayAddress,
      (overlayRequestIdsRef.current.get(overlayAddress) ?? 0) + 1,
    );
    setOverlayWallets((prev) => prev.filter((wallet) => wallet.address !== overlayAddress));
  }, []);

  return {
    overlayWallets,
    walletColors,
    detailIdentityByAddress,
    enrichedCounterparties,
    enrichedAllTimeCounterparties,
    filteredCounterparties,
    filteredOverlayWallets,
    comparisonWallets,
    mergedCounterparties,
    walletInsights,
    suggestedComparisons,
    sharedFunders,
    walletStats,
    handleAddOverlay,
    handleRemoveOverlay,
    cacheDetailIdentity,
    cacheDetailIdentities,
  };
}
