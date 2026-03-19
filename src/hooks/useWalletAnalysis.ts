import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import {
  getBalances,
  getFunding,
  getIdentity,
  getPreferredSolDomain,
  type FundingSource,
  type WalletBalances,
  type WalletIdentity,
} from "@/api";
import type { TimeRange } from "@/components/CounterpartyTable";
import { getWalletAnalysis } from "@/lib/backend-api";
import type { CounterpartyFlow, ParsedTransaction } from "@/lib/parse-transactions";

export const WALLET_ANALYSIS_QUICK_SCAN_LIMIT = 2000;
export type WalletAnalysisHistoryMode = "quick" | "full";

export interface UseWalletAnalysisResult {
  address: string;
  searchDisplayValue: string;
  loading: boolean;
  identityLoading: boolean;
  balancesLoading: boolean;
  fundingLoading: boolean;
  graphLoading: boolean;
  tableLoading: boolean;
  walletError: string | null;
  identityError: string | null;
  balancesError: string | null;
  fundingError: string | null;
  identity: WalletIdentity | null;
  balances: WalletBalances | null;
  funding: FundingSource | null;
  counterparties: CounterpartyFlow[];
  allTimeCounterparties: CounterpartyFlow[];
  transactions: ParsedTransaction[];
  txCount: number;
  lastBlockTime: number;
  analysisEpoch: number;
  historyMode: WalletAnalysisHistoryMode;
  fullHistoryLoading: boolean;
  handleWalletLookup: (address: string, options?: { fullHistory?: boolean }) => Promise<void>;
  handleLoadFullHistory: () => Promise<void>;
  handleTimeRangeChange: (range: TimeRange) => void;
  handleReset: () => void;
}

export function useWalletAnalysis(): UseWalletAnalysisResult {
  const [address, setAddress] = useState("");
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
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [txCount, setTxCount] = useState(0);
  const [lastBlockTime, setLastBlockTime] = useState(0);
  const [analysisEpoch, setAnalysisEpoch] = useState(0);
  const [historyMode, setHistoryMode] = useState<WalletAnalysisHistoryMode>("quick");
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  const lookupRequestIdRef = useRef(0);
  const timeRangeRequestIdRef = useRef(0);
  const allTimeTxsRef = useRef<ParsedTransaction[]>([]);
  const allTimeCounterpartiesRef = useRef<CounterpartyFlow[]>([]);
  const allTimeLastBlockTimeRef = useRef(0);

  const searchDisplayValue = useMemo(
    () => (address ? (getPreferredSolDomain(address) ?? address) : ""),
    [address],
  );

  const applyWalletAnalysis = useCallback((
    counterpartyData: CounterpartyFlow[],
    nextTransactions: ParsedTransaction[],
    count: number,
    blockTime: number,
  ) => {
    startTransition(() => {
      setTransactions(nextTransactions);
      setCounterparties(counterpartyData);
      setTxCount(count);
      setLastBlockTime(blockTime);
      setTableLoading(false);
      setGraphLoading(false);
    });
  }, []);

  const resetAnalysisState = useCallback((nextAddress = "") => {
    setAddress(nextAddress);
    setIdentity(null);
    setBalances(null);
    setFunding(null);
    setCounterparties([]);
    setAllTimeCounterparties([]);
    setTransactions([]);
    setTxCount(0);
    setLastBlockTime(0);
    setHistoryMode("quick");
    setFullHistoryLoading(false);
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
    allTimeTxsRef.current = [];
    allTimeCounterpartiesRef.current = [];
    allTimeLastBlockTimeRef.current = 0;
  }, []);

  const handleReset = useCallback(() => {
    lookupRequestIdRef.current += 1;
    timeRangeRequestIdRef.current += 1;
    setAnalysisEpoch((prev) => prev + 1);
    resetAnalysisState("");
  }, [resetAnalysisState]);

  const handleWalletLookup = useCallback(async (
    nextAddress: string,
    options?: { fullHistory?: boolean },
  ) => {
    if (!nextAddress) return;
    const targetHistoryMode: WalletAnalysisHistoryMode = options?.fullHistory ? "full" : "quick";
    const requestOptions = targetHistoryMode === "quick"
      ? { limit: WALLET_ANALYSIS_QUICK_SCAN_LIMIT }
      : undefined;

    const rid = ++lookupRequestIdRef.current;
    timeRangeRequestIdRef.current += 1;
    setAnalysisEpoch((prev) => prev + 1);

    setAddress(nextAddress);
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
    setTransactions([]);
    setTxCount(0);
    setLastBlockTime(0);
    setHistoryMode(targetHistoryMode);
    setFullHistoryLoading(false);
    allTimeTxsRef.current = [];
    allTimeCounterpartiesRef.current = [];
    allTimeLastBlockTimeRef.current = 0;

    void getIdentity(nextAddress)
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

    void getBalances(nextAddress)
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

    void getFunding(nextAddress)
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
      const analysis = await getWalletAnalysis(nextAddress, undefined, requestOptions);
      if (rid !== lookupRequestIdRef.current) return;

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
      setHistoryMode(targetHistoryMode);
      setLoading(false);
    } catch (err) {
      if (rid !== lookupRequestIdRef.current) return;
      setWalletError(err instanceof Error ? err.message : "Wallet lookup failed");
      setGraphLoading(false);
      setTableLoading(false);
      setLoading(false);
    }
  }, [applyWalletAnalysis]);

  const handleLoadFullHistory = useCallback(async () => {
    if (!address || fullHistoryLoading || historyMode === "full") return;
    const rid = lookupRequestIdRef.current;

    setWalletError(null);
    setGraphLoading(true);
    setTableLoading(true);
    setFullHistoryLoading(true);

    try {
      const analysis = await getWalletAnalysis(address);
      if (rid !== lookupRequestIdRef.current) return;

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
      setHistoryMode("full");
    } catch (err) {
      if (rid !== lookupRequestIdRef.current) return;
      setWalletError(
        err instanceof Error ? err.message : "Failed to load full history",
      );
      setGraphLoading(false);
      setTableLoading(false);
    } finally {
      setFullHistoryLoading(false);
    }
  }, [address, applyWalletAnalysis, fullHistoryLoading, historyMode]);

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    if (range.start == null && range.end == null) {
      setTransactions(allTimeTxsRef.current);
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
        setWalletError(
          err instanceof Error
            ? `Failed to refresh filtered view: ${err.message}`
            : "Failed to refresh filtered view",
        );
        setTableLoading(false);
        setGraphLoading(false);
      });
  }, [address, applyWalletAnalysis]);

  return {
    address,
    searchDisplayValue,
    loading,
    identityLoading,
    balancesLoading,
    fundingLoading,
    graphLoading,
    tableLoading,
    walletError,
    identityError,
    balancesError,
    fundingError,
    identity,
    balances,
    funding,
    counterparties,
    allTimeCounterparties,
    transactions,
    txCount,
    lastBlockTime,
    analysisEpoch,
    historyMode,
    fullHistoryLoading,
    handleWalletLookup,
    handleLoadFullHistory,
    handleTimeRangeChange,
    handleReset,
  };
}
