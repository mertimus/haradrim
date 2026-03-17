import { API_BASE_URL } from "@/lib/constants";
import type { TokenHolder } from "@/birdeye-api";
import type { CounterpartyFlow, ParsedTransaction } from "@/lib/parse-transactions";
import type { TraceNodeFlows } from "@/lib/trace-types";
import type { ForensicEvidenceEdge, SuspiciousCluster } from "@/lib/suspicious-clusters";

export interface WalletAnalysisResult {
  address: string;
  counterparties: CounterpartyFlow[];
  transactions: ParsedTransaction[];
  txCount: number;
  lastBlockTime: number;
}

export interface SolBalanceHistoryPoint {
  signature: string;
  slot: number;
  timestamp: number;
  balanceSol: number;
  deltaSol: number;
}

export interface WalletSolBalanceHistoryResult {
  address: string;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  txCount: number;
  estimatedTxCount: number;
  currentBalanceSol: number;
  startingBalanceSol: number;
  netChangeSol: number;
  minBalanceSol: number;
  maxBalanceSol: number;
  downsampled: boolean;
  strategy: "empty" | "two-sided-direct" | "two-sided-gap-fill" | "legacy-gsfa-get-transaction";
  points: SolBalanceHistoryPoint[];
}

export interface AssetBalanceHistoryPoint {
  signature: string;
  slot: number;
  timestamp: number;
  balance: number;
  delta: number;
}

export interface WalletAssetBalanceHistory {
  assetId: string;
  kind: "native" | "token";
  mint: string | null;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals: number;
  pointCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  currentBalance: number;
  startingBalance: number;
  netChange: number;
  minBalance: number;
  maxBalance: number;
  currentlyHeld: boolean;
  downsampled: boolean;
  points: AssetBalanceHistoryPoint[];
}

export interface WalletAssetBalanceHistoryResult {
  address: string;
  strategy: "gtfa-wallet-assets";
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  txCount: number;
  estimatedTxCount: number;
  assetCount: number;
  currentAssetCount: number;
  historicalAssetCount: number;
  assets: WalletAssetBalanceHistory[];
}

export interface EnhancedHistoryAnnotation {
  signature: string;
  type?: string;
  description?: string;
  source?: string;
  protocol?: string;
  programs?: Array<{ id: string; label: string }>;
  timestamp?: number;
}

export interface EnhancedCounterpartyHistoryResult {
  counterparty: string;
  annotations: EnhancedHistoryAnnotation[];
}

export interface ProvenanceSource {
  address: string;
  label?: string;
  category?: string;
  accountType?: string;
  signature: string;
  timestamp: number;
  rawAmount: string;
  uiAmount: number;
  stopReason?: string | null;
  upstream?: ProvenanceTrail | null;
  symbol?: string;
  name?: string;
  logoUri?: string;
}

export interface ProvenanceTrail {
  wallet: string;
  assetId: string;
  depth: number;
  attribution: "exact" | "possible" | "unknown";
  stopReason?: string | null;
  requiredRawAmount: string;
  requiredUiAmount: number;
  balanceBeforeRawAmount: string;
  balanceBeforeUiAmount: number;
  pooledBalanceBeforeRawAmount: string;
  pooledBalanceBeforeUiAmount: number;
  coveredByCandidateSourcesRawAmount: string;
  coveredByCandidateSourcesUiAmount: number;
  candidateSources: ProvenanceSource[];
  symbol?: string;
  name?: string;
  logoUri?: string;
}

export interface TokenAcquisitionTransfer extends ProvenanceSource {
  assetId: string;
  kind: string;
  mint?: string;
  decimals: number;
}

export interface TokenPaymentRequirement {
  assetId: string;
  kind: string;
  mint?: string;
  decimals: number;
  rawAmount: string;
  uiAmount: number;
  counterparties: string[];
  attribution: "exact" | "possible" | "unknown";
  balanceBeforeRawAmount: string;
  balanceBeforeUiAmount: number;
  pooledBalanceBeforeRawAmount: string;
  pooledBalanceBeforeUiAmount: number;
  coveredByCandidateSourcesRawAmount: string;
  coveredByCandidateSourcesUiAmount: number;
  upstream?: ProvenanceTrail | null;
  symbol?: string;
  name?: string;
  logoUri?: string;
}

export interface WalletMintProvenanceResult {
  wallet: string;
  mint: string;
  maxDepth: number;
  candidateLimit: number;
  acquisition: {
    signature: string;
    slot: number;
    timestamp: number;
    decimals: number;
    acquiredRawAmount: string;
    acquiredUiAmount: number;
    classification:
      | "purchase_or_swap"
      | "transfer_or_airdrop"
      | "programmatic_acquisition"
      | "balance_delta_only"
      | "unknown";
    acquisitionTransfers: TokenAcquisitionTransfer[];
    paymentRequirements: TokenPaymentRequirement[];
    networkFeeSol: number;
  } | null;
  notes: string[];
}

export interface TokenHolderSnapshotResult {
  mint: string;
  supply: number;
  holderCount: number;
  holders: TokenHolder[];
  snapshotAt: number;
  source?: string;
  accountLimit?: number | null;
  ownerLimit?: number | null;
  partial?: boolean;
  tokenAccountCount?: number | null;
}

export interface TokenForensicsHolder {
  address: string;
  label?: string;
  uiAmount: number;
  percentage: number;
  firstAcquisitionSlot: number | null;
  firstAcquisitionTimestamp: number | null;
  firstAcquisitionUiAmount: number | null;
  firstAcquisitionClassification: string | null;
  feePayer: string | null;
  signers: string[];
  fundingSourceCount: number;
  directTokenSourceCount?: number;
  tradeVenueCount?: number;
  mintVenueBuyUiAmount?: number;
  mintVenueSellUiAmount?: number;
  twoWayVenueTrader?: boolean;
  notes: string[];
}

export interface TokenForensicsSummary {
  analyzedHolderCount: number;
  visibleEdgeCount: number;
  clusterCount: number;
  implicatedWalletCount: number;
  implicatedSupplyPct: number;
  controllerLinkedPairs: number;
  fundingLinkedPairs: number;
  directDistributionPairs: number;
  coordinatedEntryPairs: number;
  washLikeClusters: number;
}

export interface TokenForensicsReport {
  mint: string;
  analysisVersion: string;
  snapshotAt: number;
  holderCount: number;
  supply: number;
  scopeLimit: number;
  maxDepth: number;
  candidateLimit: number;
  scopeAddresses: string[];
  analyzedHolders: TokenForensicsHolder[];
  edges: ForensicEvidenceEdge[];
  clusters: SuspiciousCluster[];
  summary: TokenForensicsSummary;
  warnings: string[];
}

function buildQuery(range?: { start?: number | null; end?: number | null }): string {
  if (!range) return "";
  const params = new URLSearchParams();
  if (range.start != null) params.set("start", String(range.start));
  if (range.end != null) params.set("end", String(range.end));
  const query = params.toString();
  return query ? `?${query}` : "";
}

interface FetchJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function createAbortSignal(options: FetchJsonOptions = {}): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timeoutId = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "AbortError"));
  }, timeoutMs);

  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

async function fetchJson<T>(path: string, options?: FetchJsonOptions): Promise<T> {
  const { signal, cleanup } = createAbortSignal(options);

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { signal });
    const text = await res.text();
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const payload = text ? JSON.parse(text) : null;
        if (payload?.message || payload?.error) {
          message = payload.message ?? payload.error;
        }
      } catch {
        // Server returned non-JSON (e.g. HTML error page) — use status text
      }
      throw new Error(message);
    }
    const payload = text ? JSON.parse(text) : null;
    return payload as T;
  } finally {
    cleanup();
  }
}

export function getWalletAnalysis(
  address: string,
  range?: { start?: number | null; end?: number | null },
): Promise<WalletAnalysisResult> {
  return fetchJson<WalletAnalysisResult>(
    `/wallets/${address}/analysis${buildQuery(range)}`,
  );
}

export function getTraceAnalysis(
  address: string,
  range?: { start?: number | null; end?: number | null },
  options?: { limit?: number },
): Promise<TraceNodeFlows> {
  const params = new URLSearchParams();
  if (range?.start != null) params.set("start", String(range.start));
  if (range?.end != null) params.set("end", String(range.end));
  if (options?.limit != null) params.set("limit", String(options.limit));
  const query = params.toString();
  return fetchJson<TraceNodeFlows>(
    `/traces/${address}/flows${query ? `?${query}` : ""}`,
    { timeoutMs: 120_000 },
  );
}

export function getWalletSolBalanceHistory(
  address: string,
  options?: FetchJsonOptions,
): Promise<WalletSolBalanceHistoryResult> {
  return fetchJson<WalletSolBalanceHistoryResult>(
    `/wallets/${address}/balances/sol-history`,
    options,
  );
}

export function getWalletAssetBalanceHistory(
  address: string,
  options?: FetchJsonOptions,
): Promise<WalletAssetBalanceHistoryResult> {
  return fetchJson<WalletAssetBalanceHistoryResult>(
    `/wallets/${address}/balances/assets-history`,
    options,
  );
}

export function getWalletSolBalanceHistoryLegacy(
  address: string,
  options?: FetchJsonOptions,
): Promise<WalletSolBalanceHistoryResult> {
  return fetchJson<WalletSolBalanceHistoryResult>(
    `/wallets/${address}/balances/sol-history-legacy`,
    options,
  );
}

export function getEnhancedCounterpartyHistory(
  address: string,
  counterparty: string,
  range?: { start?: number | null; end?: number | null },
): Promise<EnhancedCounterpartyHistoryResult> {
  return fetchJson<EnhancedCounterpartyHistoryResult>(
    `/wallets/${address}/counterparties/${counterparty}/enhanced-history${buildQuery(range)}`,
  );
}

export function getWalletMintProvenance(
  address: string,
  mint: string,
  options?: { maxDepth?: number; candidateLimit?: number },
): Promise<WalletMintProvenanceResult> {
  const params = new URLSearchParams();
  if (options?.maxDepth != null) params.set("maxDepth", String(options.maxDepth));
  if (options?.candidateLimit != null) params.set("candidateLimit", String(options.candidateLimit));
  const query = params.toString();
  return fetchJson<WalletMintProvenanceResult>(
    `/wallets/${address}/tokens/${mint}/provenance${query ? `?${query}` : ""}`,
  );
}

export function getTokenHolderSnapshot(
  mint: string,
  options?: { limit?: number },
): Promise<TokenHolderSnapshotResult> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const query = params.toString();
  return fetchJson<TokenHolderSnapshotResult>(
    `/tokens/${mint}/holders${query ? `?${query}` : ""}`,
  );
}

export interface WalletPairSignal {
  kind: string;
  score: number;
  summary: string;
  detail?: string[];
}

export interface WalletPairCounterpartySignals {
  counterparty: string;
  label?: string;
  totalScore: number;
  dominantSignal: string;
  signals: WalletPairSignal[];
}

export interface WalletPairSignalsResult {
  walletA: string;
  walletB: string;
  sharedCounterpartyCount: number;
  signalCount: number;
  sharedFunder: { address: string; label?: string } | null;
  signals: WalletPairCounterpartySignals[];
}

export function getWalletPairSignals(
  addrA: string,
  addrB: string,
): Promise<WalletPairSignalsResult> {
  return fetchJson<WalletPairSignalsResult>(
    `/wallets/${addrA}/compare/${addrB}/signals`,
  );
}

export interface StablecoinInfo {
  ticker: string;
  name: string;
  mint: string;
  uiAmount: number;
  decimals: number;
  sharePct: number;
}

export interface StablecoinHolder {
  owner: string;
  uiAmount: number;
  percentage: number;
  label?: string;
  category?: string;
}

export interface ConcentrationMetrics {
  top10Pct: number;
  top50Pct: number;
  top100Pct: number;
}

export interface StablecoinHolderData {
  holders: StablecoinHolder[];
  concentration: ConcentrationMetrics;
}

export interface OverlapHolder {
  owner: string;
  label?: string;
  holdings: Record<string, { amount: number; pct: number }>;
}

export interface ConcentrationRankEntry {
  ticker: string;
  top10Pct: number;
  top50Pct: number;
  top100Pct: number;
}

export interface DiversificationStats {
  walletCount: number;
  totalValue: number;
  pctOfSupply: number;
}

export interface YieldMarket {
  id: string;
  type: "yield" | "lending";
  name: string;
  ticker: string;
  tokenIcon: string;
  provider: string;
  providerIcon: string;
  depositApy: number;
  baseDepositApy: number;
  baseDepositApy30d: number | null;
  baseDepositApy90d: number | null;
  boosted: boolean;
  totalDepositUsd: number;
  borrowApy: number | null;
  totalBorrowUsd: number | null;
  url: string | null;
}

export interface StablecoinDashboardResult {
  snapshotAt: number;
  stablecoins: StablecoinInfo[];
  totalSupply: number;
  holdersByTicker: Record<string, StablecoinHolderData>;
  overlap: OverlapHolder[];
  concentrationRanking: ConcentrationRankEntry[];
  editorial: string;
  diversification: DiversificationStats;
  yieldMarkets: YieldMarket[];
}

export function getStablecoinDashboard(
  options?: FetchJsonOptions,
): Promise<StablecoinDashboardResult> {
  return fetchJson<StablecoinDashboardResult>("/stablecoins/dashboard", options);
}

export function getTokenForensics(
  mint: string,
  options?: { scopeLimit?: number; maxDepth?: number; candidateLimit?: number },
): Promise<TokenForensicsReport> {
  const params = new URLSearchParams();
  if (options?.scopeLimit != null) params.set("scopeLimit", String(options.scopeLimit));
  if (options?.maxDepth != null) params.set("maxDepth", String(options.maxDepth));
  if (options?.candidateLimit != null) params.set("candidateLimit", String(options.candidateLimit));
  const query = params.toString();
  return fetchJson<TokenForensicsReport>(
    `/tokens/${mint}/forensics${query ? `?${query}` : ""}`,
  );
}
