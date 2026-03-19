import { Connection, PublicKey } from "@solana/web3.js";
import {
  getDomainKeysWithReverses,
  getAllDomains,
  reverseLookupBatch,
  resolve,
} from "@bonfida/spl-name-service";
import { cached, cacheGet, cacheSet } from "@/lib/cache";
import {
  maybeRedirectForCloudflareChallenge,
  waitForCloudflareChallengeNavigation,
} from "@/lib/cloudflare-challenge";
import { HELIUS_GTFA_RPC_URL, HELIUS_RPC_URL, HELIUS_WALLET_API_BASE } from "@/lib/constants";

// TTLs
const TTL_TX = 10 * 60 * 1000;       // 10 min — transactions (heaviest)
const TTL_BALANCES = 5 * 60 * 1000;   // 5 min — balances change often
const TTL_IDENTITY = 30 * 60 * 1000;  // 30 min — identity rarely changes
const TTL_FUNDING = 30 * 60 * 1000;   // 30 min
const TTL_TOKEN_META = 60 * 60 * 1000; // 1 hour — token metadata is stable
const TTL_SNS = 30 * 60 * 1000;       // 30 min
const TTL_ACCOUNT_TYPE = 60 * 60 * 1000; // 1 hour
const TTL_OWNER_MINT_TOKEN_ACCOUNTS = 15 * 60 * 1000; // 15 min
const MAX_BATCH_IDENTITY_RECOVERY = 10;

const RPC_URL = HELIUS_RPC_URL;
const GTFA_RPC_URL = HELIUS_GTFA_RPC_URL;
const WALLET_API = HELIUS_WALLET_API_BASE;
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const connection = new Connection(RPC_URL);
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PREFERRED_SOL_DOMAIN_NAMESPACE = "preferredSns";

function isValidSolanaAddress(value: string): boolean {
  if (!BASE58_REGEX.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isSolDomainInput(value: string): boolean {
  return value.length > 4 && !/\s/.test(value) && value.toLowerCase().endsWith(".sol");
}

function normalizeSolDomain(value: string): string {
  return value.trim().toLowerCase();
}

function preferredSolDomainCacheKey(address: string): string {
  return `${PREFERRED_SOL_DOMAIN_NAMESPACE}:${address}`;
}

export function rememberPreferredSolDomain(address: string, domain: string): void {
  const normalizedDomain = normalizeSolDomain(domain);
  if (!isSolDomainInput(normalizedDomain)) return;
  cacheSet(preferredSolDomainCacheKey(address), normalizedDomain);
}

export function getPreferredSolDomain(address: string): string | null {
  return cacheGet<string>(preferredSolDomainCacheKey(address), TTL_SNS);
}

function applyPreferredSolDomain(address: string, identity: WalletIdentity | null): WalletIdentity | null {
  const preferredDomain = getPreferredSolDomain(address);
  if (!preferredDomain) return identity;

  const tags = [
    preferredDomain,
    ...(identity?.tags ?? []).filter((tag) => tag !== preferredDomain),
  ];

  if (!identity) {
    return {
      address,
      name: preferredDomain,
      label: preferredDomain,
      category: "SNS Domain",
      tags,
    };
  }

  // Only use preferred domain as label if it's shorter than the existing one
  // (avoids spam domains like "cashfortunememe.sol" overriding "toly.sol")
  const usePreferred = !identity.label || preferredDomain.length <= identity.label.length;
  return {
    ...identity,
    name: usePreferred ? preferredDomain : identity.name,
    label: usePreferred ? preferredDomain : identity.label,
    category: identity.category ?? "SNS Domain",
    tags,
  };
}

function withHeliusApiKey(url: string): string {
  return url;
}

function logBatchIdentityFailure(context: Record<string, unknown>): void {
  console.warn("[batch-identity-request-failed]", context);
}

// --- Raw RPC transaction from getTransactionsForAddress ---
export interface RpcParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
}

export interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      instructions?: RpcParsedInstruction[];
      accountKeys: (
        | string
        | { pubkey: string; signer: boolean; writable: boolean }
      )[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: {
        uiAmount: number | null;
        decimals: number;
        amount: string;
      };
    }[];
    postTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: {
        uiAmount: number | null;
        decimals: number;
        amount: string;
      };
    }[];
    innerInstructions?: {
      index: number;
      instructions: RpcParsedInstruction[];
    }[];
  } | null;
}

interface RpcSignatureRecord {
  signature: string;
  blockTime: number | null;
  slot: number;
}

export interface WalletIdentity {
  address: string;
  name?: string;
  label?: string;
  category?: string;
  tags?: string[];
}

interface BatchIdentityOptions {
  recoveryLimit?: number;
}

export interface TokenBalance {
  mint: string;
  balance: number;
  decimals: number;
  name?: string;
  symbol?: string;
  logoUri?: string;
  pricePerToken?: number;
  usdValue?: number;
}

export interface WalletBalances {
  totalUsdValue: number;
  tokens: TokenBalance[];
}

export interface FundingSource {
  address: string;
  amount: number;
  label?: string;
}

// ---- Transaction fetching via getTransactionsForAddress ----
// GTFA full-history strategy:
// 1. Lightweight signatures probe to get first blockTime + rough history size
// 2. Uniform time slicing across the wallet lifetime
// 3. Fetch full parsed transactions directly from GTFA at limit=1000/page
// 4. Flatten and deduplicate signatures across slices

const GTFA_TOKEN_ACCOUNTS_MODE = "balanceChanged" as const;
const RATE_LIMIT_RETRIES = 5;
const MAX_SIGNATURE_SLICE_CONCURRENCY = 32;
const MAX_METADATA_FETCH_CONCURRENCY = 4;
const MAX_ACCOUNT_TYPE_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;
const GTFA_SIGNATURE_PAGE_LIMIT = 1000;
const GTFA_FULL_PAGE_LIMIT = 1000;
// Empirically, GTFA full-range pagination remains correct at this slice density
// on wallets where a 1000-tx target starts dropping history.
const TARGET_GTFA_TXS_PER_SLICE = 700;
const MAX_TRANSACTION_SLICES = 64;
const BATCH_CACHE_MISS = { __cacheMiss: true } as const;

function readPerItemCachedObject<T>(namespace: string, key: string, ttlMs: number): T | typeof BATCH_CACHE_MISS | null {
  return cacheGet<T | typeof BATCH_CACHE_MISS>(`${namespace}:${key}`, ttlMs);
}

function isBatchCacheMiss(value: unknown): value is typeof BATCH_CACHE_MISS {
  return Boolean(
    value
    && typeof value === "object"
    && "__cacheMiss" in value
    && (value as { __cacheMiss?: unknown }).__cacheMiss === true,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (maybeRedirectForCloudflareChallenge(response, input)) {
      return await waitForCloudflareChallengeNavigation<Response>();
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function gtfaPage(
  address: string,
  opts: {
    sortOrder?: "asc" | "desc";
    paginationToken?: string;
    blockTimeGte?: number;
    blockTimeLt?: number;
    tokenAccountsMode?: "none" | "balanceChanged";
  } = {},
): Promise<{ txs: RpcTransaction[]; nextToken: string | null }> {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    const params: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: opts.sortOrder ?? "asc",
      limit: GTFA_FULL_PAGE_LIMIT,
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    };
    const filters: Record<string, unknown> = {};
    if (opts.tokenAccountsMode && opts.tokenAccountsMode !== "none") {
      filters.tokenAccounts = opts.tokenAccountsMode;
    }
    if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
      const bt: Record<string, number> = {};
      if (opts.blockTimeGte != null) bt.gte = opts.blockTimeGte;
      if (opts.blockTimeLt != null) bt.lt = opts.blockTimeLt;
      filters.blockTime = bt;
    }
    if (Object.keys(filters).length > 0) params.filters = filters;
    if (opts.paginationToken) params.paginationToken = opts.paginationToken;

    let res: Response;
    try {
      res = await fetchWithTimeout(GTFA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransactionsForAddress",
          params: [address, params],
        }),
      });
    } catch (err) {
      if (attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (isRetryableStatus(res.status) && attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`getTransactionsForAddress failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.error) {
      if (json.error.code === -32429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`getTransactionsForAddress RPC error: ${JSON.stringify(json.error)}`);
    }
    const result = json.result ?? {};
    return {
      txs: result.data ?? [],
      nextToken: result.paginationToken ?? null,
    };
  }
  throw new Error("getTransactionsForAddress exceeded retry budget");
}

async function gtfaSignaturePage(
  address: string,
  opts: {
    sortOrder?: "asc" | "desc";
    limit?: number;
    paginationToken?: string;
    blockTimeGte?: number;
    blockTimeLt?: number;
    tokenAccountsMode?: "none" | "balanceChanged";
  } = {},
): Promise<{ txs: RpcSignatureRecord[]; nextToken: string | null }> {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    const params: Record<string, unknown> = {
      transactionDetails: "signatures",
      sortOrder: opts.sortOrder ?? "asc",
      limit: opts.limit ?? GTFA_SIGNATURE_PAGE_LIMIT,
      commitment: "confirmed",
    };
    const filters: Record<string, unknown> = {};
    if (opts.tokenAccountsMode && opts.tokenAccountsMode !== "none") {
      filters.tokenAccounts = opts.tokenAccountsMode;
    }
    if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
      const bt: Record<string, number> = {};
      if (opts.blockTimeGte != null) bt.gte = opts.blockTimeGte;
      if (opts.blockTimeLt != null) bt.lt = opts.blockTimeLt;
      filters.blockTime = bt;
    }
    if (Object.keys(filters).length > 0) params.filters = filters;
    if (opts.paginationToken) params.paginationToken = opts.paginationToken;

    let res: Response;
    try {
      res = await fetchWithTimeout(GTFA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransactionsForAddress",
          params: [address, params],
        }),
      });
    } catch (err) {
      if (attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (isRetryableStatus(res.status) && attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`getTransactionsForAddress signatures failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.error) {
      if (json.error.code === -32429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`getTransactionsForAddress signatures RPC error: ${JSON.stringify(json.error)}`);
    }
    const result = json.result ?? {};
    return {
      txs: result.data ?? [],
      nextToken: result.paginationToken ?? null,
    };
  }
  throw new Error("getTransactionsForAddress signatures exceeded retry budget");
}

interface TimelineProbe {
  firstBlockTime: number;
  estimatedTxCount: number;
}

function blockTimeBounds(
  records: Array<{ blockTime: number | null }>,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    if (record.blockTime == null) continue;
    if (record.blockTime < min) min = record.blockTime;
    if (record.blockTime > max) max = record.blockTime;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * Probe the wallet's transaction timeline using signatures mode.
 * Uses an exact oldest lookup plus a recent sample for slice sizing.
 *
 * Some wallets do not return a strictly oldest-first ordering on large ascending
 * signature pages, so we cannot infer the first blockTime from `asc limit:1000`.
 */
async function probeTimeline(address: string): Promise<TimelineProbe | null> {
  // Fire both probe requests in parallel — they're independent
  const [oldestPage, recentPage] = await Promise.all([
    gtfaSignaturePage(address, {
      sortOrder: "asc",
      limit: 1,
      tokenAccountsMode: GTFA_TOKEN_ACCOUNTS_MODE,
    }),
    gtfaSignaturePage(address, {
      sortOrder: "desc",
      limit: GTFA_SIGNATURE_PAGE_LIMIT,
      tokenAccountsMode: GTFA_TOKEN_ACCOUNTS_MODE,
    }),
  ]);

  const firstBlockTime = oldestPage.txs[0]?.blockTime;
  if (firstBlockTime == null) return null;

  if (recentPage.txs.length === 0) {
    return { firstBlockTime, estimatedTxCount: 1 };
  }
  if (!recentPage.nextToken) {
    return { firstBlockTime, estimatedTxCount: recentPage.txs.length };
  }

  const bounds = blockTimeBounds(recentPage.txs);
  if (!bounds) {
    return {
      firstBlockTime,
      estimatedTxCount: recentPage.txs.length,
    };
  }

  const sampleCoveredSpan = Math.max(bounds.max - bounds.min, 1);
  const totalSpan = Math.max(bounds.max - firstBlockTime, 1);
  const estimate = Math.ceil(recentPage.txs.length * (totalSpan / sampleCoveredSpan));

  return {
    firstBlockTime,
    estimatedTxCount: Math.max(estimate, recentPage.txs.length),
  };
}

/**
 * Choose slice count for the direct GTFA full fetch path.
 * GTFA full pages can hold 1000 transactions, but wider time windows start
 * misbehaving on some wallets before we reach that limit. Targeting ~700 txs per
 * slice gave the best latency we measured while preserving full-history coverage.
 */
function optimalSliceCount(estimatedTxCount: number, totalSpanSecs: number): number {
  if (totalSpanSecs < 86400 * 7) return 1;
  if (estimatedTxCount <= GTFA_SIGNATURE_PAGE_LIMIT) return 1;
  return Math.max(
    2,
    Math.min(
      Math.ceil(estimatedTxCount / TARGET_GTFA_TXS_PER_SLICE),
      MAX_TRANSACTION_SLICES,
    ),
  );
}

/**
 * Uniform time slicing: divides [firstTs, nowTs] into N equal-width windows.
 *
 * Benchmarked against power-law slicing across wallets from 5k to 160k txns.
 * Uniform was 1.69x faster on medium wallets and avoided the load-imbalance
 * that power-law creates on wallets with non-recency-biased activity.
 */
function createUniformSlices(
  firstTs: number,
  nowTs: number,
  count: number,
): { gte: number; lt: number }[] {
  const span = nowTs - firstTs;
  if (span <= 0 || count <= 0) return [{ gte: firstTs, lt: nowTs }];
  const sliceSize = Math.ceil(span / count);
  const slices: { gte: number; lt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const gte = firstTs + i * sliceSize;
    const lt = Math.min(firstTs + (i + 1) * sliceSize, nowTs);
    if (gte < lt) slices.push({ gte, lt });
  }
  return slices;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runWorker(),
    ),
  );
  return results;
}

/** Fetch all txns within a time window, paginating until exhausted */
export async function fetchSlice(
  address: string,
  gte: number,
  lt: number,
  maxPages = 200,
): Promise<RpcTransaction[]> {
  const all: RpcTransaction[] = [];
  let token: string | undefined;
  const requestLt = lt - gte <= 1 ? lt + 1 : lt;
  const seenTokens = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    let page;
    try {
      page = await gtfaPage(address, {
        sortOrder: "asc",
        blockTimeGte: gte,
        blockTimeLt: requestLt,
        paginationToken: token,
        tokenAccountsMode: GTFA_TOKEN_ACCOUNTS_MODE,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch slice [${gte}, ${lt}) page ${i + 1}: ${message}`);
    }
    const { txs, nextToken } = page;
    all.push(...txs);
    if (!nextToken) {
      token = undefined;
      break;
    }
    if (seenTokens.has(nextToken)) {
      throw new Error(`GTFA full pagination repeated for slice [${gte}, ${lt})`);
    }
    seenTokens.add(nextToken);
    token = nextToken;
  }
  if (token) {
    throw new Error(`GTFA full slice [${gte}, ${lt}) exceeded ${maxPages} pages`);
  }
  return all;
}

async function _getTransactions(
  address: string,
): Promise<RpcTransaction[]> {
  // 1. Probe: signatures to get first blockTime + estimated tx count
  const probe = await probeTimeline(address);
  if (!probe) return [];

  const now = Math.floor(Date.now() / 1000) + 60;
  const totalSpan = now - probe.firstBlockTime;

  // 2. Dynamic slice count + uniform time distribution
  const sliceCount = optimalSliceCount(probe.estimatedTxCount, totalSpan);
  const slices = createUniformSlices(probe.firstBlockTime, now, sliceCount);

  // 3. Direct GTFA full-detail fetch (limit=1000/page) — parallel slices
  const results = await mapWithConcurrency(
    slices,
    MAX_SIGNATURE_SLICE_CONCURRENCY,
    (s) => fetchSlice(address, s.gte, s.lt),
  );

  // 4. Flatten and deduplicate
  return deduplicateTxs(results.flat());
}

export function getTransactions(address: string): Promise<RpcTransaction[]> {
  return cached("tx6", address, TTL_TX, () => _getTransactions(address));
}

/**
 * Fetch transactions with progressive callback — fires onSlice as each parallel
 * slice completes. Allows caller to start processing (parsing, enrichment)
 * while slower slices are still paginating.
 */
export async function getTransactionsWithProgress(
  address: string,
  onSlice: (completedSliceTxs: RpcTransaction[]) => void,
): Promise<RpcTransaction[]> {
  // Check cache first
  const cacheKey = `tx6:${address}`;
  const hit = cacheGet<RpcTransaction[]>(cacheKey, TTL_TX);
  if (hit) {
    onSlice(hit);
    return hit;
  }

  const probe = await probeTimeline(address);
  if (!probe) return [];

  const now = Math.floor(Date.now() / 1000) + 60;
  const totalSpan = now - probe.firstBlockTime;

  const sliceCount = optimalSliceCount(probe.estimatedTxCount, totalSpan);
  const slices = createUniformSlices(probe.firstBlockTime, now, sliceCount);

  const allTxs: RpcTransaction[] = [];

  // Direct GTFA full-detail fetch (limit=1000/page) with progressive callback
  await mapWithConcurrency(
    slices,
    MAX_SIGNATURE_SLICE_CONCURRENCY,
    async (s) => {
      const sliceTxs = await fetchSlice(address, s.gte, s.lt);
      allTxs.push(...sliceTxs);
      onSlice(sliceTxs);
      return undefined;
    },
  );

  const result = deduplicateTxs(allTxs);
  if (result.length > 0) {
    cacheSet(cacheKey, result);
  }
  return result;
}

function deduplicateTxs(txs: RpcTransaction[]): RpcTransaction[] {
  const seen = new Set<string>();
  const unique: RpcTransaction[] = [];
  for (const tx of txs) {
    const sig = tx.transaction.signatures[0];
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(tx);
    }
  }
  return unique;
}

// ---- Identity ----

export async function getSolDomains(address: string): Promise<string[]> {
  try {
    const owner = new PublicKey(address);
    const domains = await getDomainKeysWithReverses(connection, owner);
    return domains.filter((d) => d.domain).map((d) => `${d.domain}.sol`);
  } catch {
    return [];
  }
}

export async function resolveWalletInput(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter a wallet address or .sol domain");
  }

  if (BASE58_REGEX.test(trimmed)) {
    try {
      return new PublicKey(trimmed).toBase58();
    } catch {
      // fall through to domain handling or final validation error
    }
  }

  if (isSolDomainInput(trimmed)) {
    const normalized = trimmed.toLowerCase();
    return cached("snsResolve", normalized, TTL_SNS, async () => {
      try {
        const resolved = await resolve(connection, normalized);
        return resolved.toBase58();
      } catch {
        throw new Error("Unable to resolve .sol domain");
      }
    });
  }

  throw new Error("Invalid Solana address or .sol domain");
}

/**
 * Batch resolve SNS .sol domains for multiple addresses.
 * 1) Parallel getAllDomains for each address (1 getProgramAccounts each)
 * 2) Single reverseLookupBatch for all domain keys combined (1 getMultipleAccountsInfo)
 * Returns Map<address, primaryDomain>
 */
async function _getBatchSolDomains(
  addresses: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (addresses.length === 0) return result;

  // Step 1: parallel getAllDomains per address (each wrapped to not throw)
  const validAddrs: { addr: string; pk: PublicKey }[] = [];
  for (const a of addresses) {
    try {
      validAddrs.push({ addr: a, pk: new PublicKey(a) });
    } catch {
      // skip invalid pubkeys
    }
  }

  const domainResults = await mapWithConcurrency(
    validAddrs,
    MAX_METADATA_FETCH_CONCURRENCY,
    async ({ pk }) => {
      try {
        return await getAllDomains(connection, pk);
      } catch {
        return [];
      }
    },
  );

  // Collect all domain pubkeys with their owner
  const allDomainKeys: PublicKey[] = [];
  const ownerForDomainIndex: string[] = [];
  for (let i = 0; i < domainResults.length; i++) {
    const domains = domainResults[i];
    if (domains.length > 0) {
      for (const dk of domains) {
        allDomainKeys.push(dk);
        ownerForDomainIndex.push(validAddrs[i].addr);
      }
    }
  }

  if (allDomainKeys.length === 0) return result;

  // Step 2: batch reverse lookup in chunks of 100
  try {
    const CHUNK = 100;
    const allNames: (string | undefined)[] = [];
    for (let i = 0; i < allDomainKeys.length; i += CHUNK) {
      const chunk = allDomainKeys.slice(i, i + CHUNK);
      const names = await reverseLookupBatch(connection, chunk);
      allNames.push(...names);
    }

    for (let i = 0; i < allNames.length; i++) {
      const name = allNames[i];
      const owner = ownerForDomainIndex[i];
      if (name && !(owner in result)) {
        result[owner] = `${name}.sol`;
      }
    }
  } catch {
    // reverse lookup failed, return what we have
  }

  return result;
}

export async function getBatchSolDomains(
  addresses: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(addresses)].filter(Boolean);
  const result = new Map<string, string>();
  const missing: string[] = [];

  for (const address of unique) {
    const cachedDomain = readPerItemCachedObject<string>("batchSnsItem", address, TTL_SNS);
    if (cachedDomain === null) {
      missing.push(address);
      continue;
    }
    if (!isBatchCacheMiss(cachedDomain)) {
      result.set(address, cachedDomain);
    }
  }

  if (missing.length === 0) return result;

  const resolved = await _getBatchSolDomains(missing);
  for (const address of missing) {
    const domain = resolved[address];
    cacheSet(`batchSnsItem:${address}`, domain ?? BATCH_CACHE_MISS);
    if (domain) {
      result.set(address, domain);
    }
  }

  return result;
}

interface RawWalletIdentityResponse {
  address?: string;
  name?: string;
  category?: string;
  tags?: string[];
  domainNames?: string[];
}

function normalizeDomainList(domains: string[] | undefined): string[] {
  if (!domains?.length) return [];

  const deduped = new Set<string>();
  for (const domain of domains) {
    const normalized = normalizeSolDomain(domain);
    if (!isSolDomainInput(normalized)) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function buildWalletIdentity(
  address: string,
  data: RawWalletIdentityResponse | null,
  fallbackDomains: string[] = [],
): WalletIdentity | null {
  const domains = normalizeDomainList([
    ...(data?.domainNames ?? []),
    ...fallbackDomains,
  ]);
  // Pick shortest .sol domain as display name — short names (e.g. toly.sol) are more likely real
  // Collect from all sources: domainNames, data.name, and data.tags
  const allCandidates = [...domains];
  if (data?.name?.endsWith(".sol")) {
    const n = normalizeSolDomain(data.name);
    if (!allCandidates.includes(n)) allCandidates.push(n);
  }
  for (const tag of data?.tags ?? []) {
    const n = normalizeSolDomain(tag);
    if (isSolDomainInput(n) && !allCandidates.includes(n)) allCandidates.push(n);
  }
  const shortestDomain = allCandidates.length > 0
    ? allCandidates.reduce((shortest, d) => d.length < shortest.length ? d : shortest)
    : undefined;
  const label = shortestDomain ?? data?.name;
  const name = data?.name ?? shortestDomain;
  const tags = [
    ...domains,
    ...((data?.tags ?? []).filter((tag) => !domains.includes(normalizeSolDomain(tag)))),
  ];
  const category = data?.category ?? (domains.length > 0 ? "SNS Domain" : undefined);

  if (!label && !name) return null;

  return {
    address,
    name,
    label: label ?? name,
    category,
    tags,
  };
}

function shouldRecoverBatchIdentity(identity: WalletIdentity | undefined): boolean {
  if (!identity) return true;

  const normalizedLabel = normalizeSolDomain(identity.label ?? "");
  const normalizedName = normalizeSolDomain(identity.name ?? "");
  const hasSolLabel = isSolDomainInput(normalizedLabel);
  const hasSolName = isSolDomainInput(normalizedName);

  // Batch identity can return only the SNS/domain view for some protocol wallets.
  // Recover a small capped subset via the per-address endpoint so top holder labels
  // don't get stuck on low-signal domains.
  return hasSolLabel && (!identity.name || hasSolName);
}

async function _getIdentity(
  address: string,
): Promise<WalletIdentity | null> {
  const data = await fetchWithTimeout(withHeliusApiKey(`${WALLET_API}/${address}/identity`), {})
    .then((r) => (r.ok ? r.json() as Promise<RawWalletIdentityResponse> : null))
    .catch(() => null);

  let fallbackDomains: string[] = [];
  if (normalizeDomainList(data?.domainNames).length === 0) {
    fallbackDomains = await getSolDomains(address).catch(() => []);
  }

  return buildWalletIdentity(address, data, fallbackDomains);
}

export function getIdentity(address: string): Promise<WalletIdentity | null> {
  return cached("identity", address, TTL_IDENTITY, () => _getIdentity(address))
    .then((identity) => applyPreferredSolDomain(address, identity));
}

async function _getBatchIdentity(
  addresses: string[],
): Promise<Record<string, WalletIdentity>> {
  const map: Record<string, WalletIdentity> = {};
  if (addresses.length === 0) return map;
  const invalidAddresses = [...new Set(addresses)].filter((address) => Boolean(address) && !isValidSolanaAddress(address));
  const uniqueAddresses = [...new Set(addresses)].filter(isValidSolanaAddress);
  if (invalidAddresses.length > 0) {
    logBatchIdentityFailure({
      stage: "input-pruned",
      requestedCount: addresses.length,
      validCount: uniqueAddresses.length,
      invalidAddressSamples: invalidAddresses.slice(0, 5),
    });
  }

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueAddresses.length; i += 100) {
    chunks.push(uniqueAddresses.slice(i, i + 100));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_METADATA_FETCH_CONCURRENCY,
    async (chunk) => {
      try {
        const url = withHeliusApiKey(`${WALLET_API}/batch-identity`);
        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: chunk }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logBatchIdentityFailure({
            stage: "http-error",
            status: res.status,
            requestId: res.headers.get("x-request-id") ?? undefined,
            addressCount: chunk.length,
            addressSamples: chunk.slice(0, 5),
            bodySnippet: body.slice(0, 200),
          });
          return [] as RawWalletIdentityResponse[];
        }
        const data = await res.json();
        return Array.isArray(data) ? data as RawWalletIdentityResponse[] : [];
      } catch (error) {
        logBatchIdentityFailure({
          stage: "exception",
          addressCount: chunk.length,
          addressSamples: chunk.slice(0, 5),
          message: error instanceof Error ? error.message : String(error),
        });
        return [] as RawWalletIdentityResponse[];
      }
    },
  );

  for (const batch of results) {
    for (const item of batch) {
      if (!item.address) continue;
      const identity = buildWalletIdentity(item.address, item);
      if (identity) map[item.address] = identity;
    }
  }

  const domainMap = await getBatchSolDomains(uniqueAddresses).catch(() => new Map<string, string>());
  for (const address of uniqueAddresses) {
    const domain = domainMap.get(address);
    if (!domain) continue;

    const existing = map[address];
    const tags = [
      domain,
      ...((existing?.tags ?? []).filter((tag) => tag !== domain)),
    ];

    map[address] = {
      address,
      name: existing?.name ?? domain,
      label: domain,
      category: existing?.category ?? "SNS Domain",
      tags,
    };
  }

  return map;
}

export async function getBatchIdentity(
  addresses: string[],
  options: BatchIdentityOptions = {},
): Promise<Map<string, WalletIdentity>> {
  const uniqueAddresses = [...new Set(addresses)].filter(isValidSolanaAddress);
  const key = uniqueAddresses.slice().sort().join(",");
  let obj = await cached("batchId", key, TTL_IDENTITY, () => _getBatchIdentity(uniqueAddresses));
  const recoveryLimit = Number.isFinite(options.recoveryLimit)
    ? Math.max(0, Math.trunc(options.recoveryLimit ?? 0))
    : MAX_BATCH_IDENTITY_RECOVERY;

  const recoveryAddresses = uniqueAddresses
    .filter((address) => shouldRecoverBatchIdentity(obj[address]))
    .slice(0, recoveryLimit);

  if (recoveryAddresses.length > 0) {
    const recovered = await mapWithConcurrency(
      recoveryAddresses,
      MAX_METADATA_FETCH_CONCURRENCY,
      async (address) => [address, await getIdentity(address)] as const,
    );

    let changed = false;
    const next = { ...obj };
    for (const [address, identity] of recovered) {
      if (!identity) continue;
      next[address] = identity;
      changed = true;
    }
    if (changed) {
      obj = next;
      cacheSet(`batchId:${key}`, obj);
    }
  }

  const map = new Map<string, WalletIdentity>();
  for (const address of addresses) {
    const identity = applyPreferredSolDomain(address, obj[address] ?? null);
    if (identity) {
      map.set(address, identity);
    }
  }
  return map;
}

// ---- Token metadata via DAS getAssetBatch ----

export interface TokenMeta {
  name?: string;
  symbol?: string;
  logoUri?: string;
}

async function _getTokenMetadataBatch(
  mints: string[],
): Promise<Record<string, TokenMeta>> {
  const map: Record<string, TokenMeta> = {};
  if (mints.length === 0) return map;

  const CHUNK = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += CHUNK) {
    chunks.push(mints.slice(i, i + CHUNK));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_METADATA_FETCH_CONCURRENCY,
    async (chunk) => {
      try {
        const res = await fetchWithTimeout(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAssetBatch",
            params: { ids: chunk },
          }),
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json.result ?? [];
      } catch {
        return [];
      }
    },
  );

  for (const assets of results) {
    for (const asset of assets) {
      if (!asset?.id) continue;
      const content = asset.content?.metadata;
      const files = asset.content?.links;
      map[asset.id] = {
        name: content?.name,
        symbol: content?.symbol,
        logoUri: files?.image ?? asset.content?.json_uri,
      };
    }
  }

  return map;
}

export async function getTokenMetadataBatch(
  mints: string[],
): Promise<Map<string, TokenMeta>> {
  const key = mints.slice().sort().join(",");
  const obj = await cached("tokenMeta", key, TTL_TOKEN_META, () => _getTokenMetadataBatch(mints));
  return new Map(Object.entries(obj));
}

// ---- Account type classification ----

export type AccountType = "wallet" | "token" | "program" | "other" | "unknown";

export interface AccountTypeInfo {
  type: AccountType;
  mint?: string;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function _getAccountTypes(
  addresses: string[],
): Promise<Record<string, AccountTypeInfo>> {
  const map: Record<string, AccountTypeInfo> = {};
  if (addresses.length === 0) return map;

  const CHUNK = 100;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    try {
      const res = await fetchWithTimeout(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [chunk, { encoding: "jsonParsed", commitment: "confirmed" }],
        }),
      });
      if (!res.ok) {
        for (const addr of chunk) map[addr] = { type: "unknown" };
        continue;
      }
      const json = await res.json();
      const accounts = json.result?.value ?? [];
      for (let j = 0; j < chunk.length; j++) {
        const info = accounts[j];
        if (!info) {
          map[chunk[j]] = { type: "unknown" };
        } else if (info.executable) {
          map[chunk[j]] = { type: "program" };
        } else {
          const owner = info.owner;
          if (owner === SYSTEM_PROGRAM) {
            map[chunk[j]] = { type: "wallet" };
          } else if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
            const mint = info.data?.parsed?.info?.mint;
            map[chunk[j]] = { type: "token", ...(mint && { mint }) };
          } else {
            map[chunk[j]] = { type: "other" };
          }
        }
      }
    } catch {
      // Mark chunk as unknown on failure
      for (const addr of chunk) {
        if (!(addr in map)) map[addr] = { type: "unknown" };
      }
    }
  }

  return map;
}

export async function getAccountTypes(
  addresses: string[],
): Promise<Map<string, AccountTypeInfo>> {
  const key = addresses.slice().sort().join(",");
  const obj = await cached("acctType", key, TTL_ACCOUNT_TYPE, () => _getAccountTypes(addresses));
  return new Map(Object.entries(obj));
}

/** Parallel version — fires all chunks concurrently. Faster for trace mode. */
export async function getAccountTypesParallel(
  addresses: string[],
): Promise<Map<string, AccountTypeInfo>> {
  const uniqueAddresses = [...new Set(addresses)];
  if (uniqueAddresses.length === 0) return new Map();

  const cacheKey = uniqueAddresses.slice().sort().join(",");
  const cachedResult = cacheGet<Record<string, AccountTypeInfo>>(`acctTypeParallel:${cacheKey}`, TTL_ACCOUNT_TYPE);
  if (cachedResult) {
    return new Map(Object.entries(cachedResult));
  }

  const CHUNK = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueAddresses.length; i += CHUNK) {
    chunks.push(uniqueAddresses.slice(i, i + CHUNK));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_ACCOUNT_TYPE_CONCURRENCY,
    async (chunk) => {
      const res = await fetchWithTimeout(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [chunk, { encoding: "jsonParsed", commitment: "confirmed" }],
        }),
      });
      if (!res.ok) return chunk.map(() => ({ type: "unknown" as const }));
      const json = await res.json();
      const accounts = json.result?.value ?? [];
      return chunk.map((_addr: string, j: number) => {
        const info = accounts[j];
        if (!info) return { type: "unknown" as const };
        if (info.executable) return { type: "program" as const };
        const owner = info.owner;
        if (owner === SYSTEM_PROGRAM) return { type: "wallet" as const };
        if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
          const mint = info.data?.parsed?.info?.mint;
          return { type: "token" as const, ...(mint && { mint }) };
        }
        return { type: "other" as const };
      });
    },
  ).catch(() => chunks.map((chunk) => chunk.map(() => ({ type: "unknown" as const }))));

  const map = new Map<string, AccountTypeInfo>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = results[i] ?? chunk.map(() => ({ type: "unknown" as const }));
    for (let j = 0; j < chunk.length; j++) {
      map.set(chunk[j], result[j] ?? { type: "unknown" });
    }
  }

  cacheSet(`acctTypeParallel:${cacheKey}`, Object.fromEntries(map));
  return map;
}

// ---- Balances ----

async function _getBalances(
  address: string,
): Promise<WalletBalances | null> {
  const allTokens: TokenBalance[] = [];
  let page = 1;
  let totalUsdValue = 0;

  while (true) {
    const url = withHeliusApiKey(
      `${WALLET_API}/${address}/balances?page=${page}&limit=100`,
    );
    const res = await fetchWithTimeout(url, {});
    if (!res.ok) return null;
    const data = await res.json();

    if (page === 1) {
      totalUsdValue = data.totalUsdValue ?? 0;
    }

    for (const t of data.balances ?? []) {
      allTokens.push({
        mint: t.mint,
        balance: t.balance,
        decimals: t.decimals,
        name: t.name,
        symbol: t.symbol,
        logoUri: t.logoUri,
        pricePerToken: t.pricePerToken,
        usdValue: t.usdValue,
      });
    }

    if (!data.pagination?.hasMore) break;
    page++;
    if (page > 10) break;
  }

  return { totalUsdValue, tokens: allTokens };
}

export function getBalances(address: string): Promise<WalletBalances | null> {
  return cached("balances", address, TTL_BALANCES, () => _getBalances(address));
}

// ---- Funding ----

async function _getFunding(
  address: string,
): Promise<FundingSource | null> {
  try {
    const url = withHeliusApiKey(`${WALLET_API}/${address}/funded-by`);
    const res = await fetchWithTimeout(url, {});
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.funder) return null;
    return {
      address: data.funder,
      amount: data.amount ?? 0,
      label: data.funderName ?? undefined,
    };
  } catch {
    return null;
  }
}

export function getFunding(address: string): Promise<FundingSource | null> {
  return cached("funding", address, TTL_FUNDING, () => _getFunding(address));
}

export async function getBatchFunding(
  addresses: string[],
): Promise<Map<string, FundingSource>> {
  const map = new Map<string, FundingSource>();
  if (addresses.length === 0) return map;
  const results = await mapWithConcurrency(addresses, 8, async (addr) => {
    const result = await getFunding(addr);
    return { addr, result };
  });
  for (const { addr, result } of results) {
    if (result) map.set(addr, result);
  }
  return map;
}

async function fetchOwnerTokenAccountsForProgram(
  owner: string,
  mint: string,
  programId: string,
): Promise<string[]> {
  const res = await fetchWithTimeout(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  if (json.error) return [];

  const accounts: Array<{
    pubkey?: string;
    account?: {
      data?: {
        parsed?: {
          info?: {
            mint?: string;
          };
        };
      };
    };
  }> = json.result?.value ?? [];

  return accounts
    .filter((account) => account.account?.data?.parsed?.info?.mint === mint)
    .map((account) => account.pubkey ?? "")
    .filter(Boolean);
}

async function _getTokenAccountAddressesByOwner(
  owner: string,
  mint: string,
): Promise<string[]> {
  try {
    new PublicKey(owner);
    new PublicKey(mint);
  } catch {
    return [];
  }

  const results = await Promise.allSettled([
    fetchOwnerTokenAccountsForProgram(owner, mint, SPL_TOKEN_PROGRAM_ID),
    fetchOwnerTokenAccountsForProgram(owner, mint, TOKEN_2022_PROGRAM_ID),
  ]);

  const addresses = new Set<string>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const address of result.value) addresses.add(address);
  }
  return [...addresses];
}

export function getTokenAccountAddressesByOwner(
  owner: string,
  mint: string,
): Promise<string[]> {
  return cached(
    "ownerMintTokenAccounts",
    `${owner}:${mint}`,
    TTL_OWNER_MINT_TOKEN_ACCOUNTS,
    () => _getTokenAccountAddressesByOwner(owner, mint),
  );
}
