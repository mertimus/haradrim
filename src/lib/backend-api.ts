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

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Request failed (${res.status})`);
  }
  return payload as T;
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
): Promise<TraceNodeFlows> {
  return fetchJson<TraceNodeFlows>(
    `/traces/${address}/flows${buildQuery(range)}`,
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
