import {
  FETCH_TIMEOUT_MS,
  GTFA_SIGNATURE_PAGE_LIMIT,
  GTFA_FULL_PAGE_LIMIT,
  GTFA_TOKEN_ACCOUNTS_MODE,
  HELIUS_ENHANCED_API_ORIGIN,
  HELIUS_API_KEY,
  HELIUS_API_ORIGIN,
  HELIUS_RPC_URL,
  MAX_ACCOUNT_TYPE_CONCURRENCY,
  MAX_METADATA_FETCH_CONCURRENCY,
  MAX_SLICE_CONCURRENCY,
  MAX_TRANSACTION_SLICES,
  MAX_UPSTREAM_FETCH_CONCURRENCY,
  RATE_LIMIT_RETRIES,
  TARGET_GTFA_TXS_PER_SLICE,
} from "./config.mjs";
import { createHttpError } from "./guard.mjs";
import {
  cachedValue,
  getCachedValue,
  setCachedValue,
  withInflightValue,
} from "./cache.mjs";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OWNER_MINT_TOKEN_ACCOUNTS_TTL_MS = 15 * 60 * 1000;
const IDENTITY_TTL_MS = 30 * 60 * 1000;
const TOKEN_METADATA_TTL_MS = 60 * 60 * 1000;
const ACCOUNT_TYPE_TTL_MS = 60 * 60 * 1000;
const CACHE_MISS = Object.freeze({ __cacheMiss: true });
let upstreamFetchInFlight = 0;
const upstreamFetchWaiters = [];

function getPerItemCacheKey(namespace, key) {
  return `${namespace}:${key}`;
}

function isValidSolanaAddress(value) {
  return typeof value === "string" && SOLANA_ADDRESS_REGEX.test(value);
}

function readPerItemCache(keys, namespace) {
  const hits = new Map();
  const missing = [];

  for (const key of keys) {
    const cached = getCachedValue(getPerItemCacheKey(namespace, key), { bucket: "metadata" });
    if (cached === null) {
      missing.push(key);
      continue;
    }
    if (cached !== CACHE_MISS) {
      hits.set(key, cached);
    }
  }

  return { hits, missing };
}

function writePerItemCache(keys, namespace, values, ttlMs) {
  for (const key of keys) {
    setCachedValue(
      getPerItemCacheKey(namespace, key),
      values.get(key) ?? CACHE_MISS,
      ttlMs,
      { bucket: "metadata" },
    );
  }
}

export async function fetchWithTimeout(input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await acquireUpstreamFetchSlot();
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      releaseUpstreamFetchSlot();
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireUpstreamFetchSlot() {
  if (upstreamFetchInFlight < MAX_UPSTREAM_FETCH_CONCURRENCY) {
    upstreamFetchInFlight += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    upstreamFetchWaiters.push(resolve);
  });
}

function releaseUpstreamFetchSlot() {
  const next = upstreamFetchWaiters.shift();
  if (next) {
    next();
    return;
  }
  upstreamFetchInFlight = Math.max(0, upstreamFetchInFlight - 1);
}

async function retryingJsonRequest(makeRequest) {
  let lastError = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const response = await makeRequest();
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retryAfterSec = Number(response.headers.get("retry-after"));
        if (isRetryableStatus(response.status) && attempt < RATE_LIMIT_RETRIES) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (response.status === 429) {
          throw createHttpError(503, "upstream_rate_limited", "Upstream Solana data provider is saturated right now", {
            upstreamStatus: 429,
            ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {}),
          });
        }
        throw new Error(`upstream ${response.status}: ${body.slice(0, 200)}`);
      }
      const json = await response.json();
      if (json?.error) {
        const upstreamCode = Number(json.error.code);
        if ((upstreamCode === -32429 || isRetryableStatus(upstreamCode)) && attempt < RATE_LIMIT_RETRIES) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (upstreamCode === -32429 || upstreamCode === 429) {
          throw createHttpError(503, "upstream_rate_limited", "Upstream Solana data provider is saturated right now", {
            upstreamStatus: upstreamCode === -32429 ? 429 : upstreamCode,
          });
        }
        throw new Error(JSON.stringify(json.error));
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < RATE_LIMIT_RETRIES) {
        await sleep(400 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError ?? new Error("request exceeded retry budget");
}

export async function rpcJson(method, params, opts = {}) {
  return retryingJsonRequest(() =>
    fetchWithTimeout(HELIUS_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    }, opts.timeoutMs),
  );
}

function heliusApiKey() {
  if (HELIUS_API_KEY) return HELIUS_API_KEY;
  try {
    return new URL(HELIUS_RPC_URL).searchParams.get("api-key") ?? "";
  } catch {
    return "";
  }
}

function buildEnhancedTransactionsUrl() {
  const url = new URL("/v0/transactions", HELIUS_ENHANCED_API_ORIGIN);
  const apiKey = heliusApiKey();
  if (apiKey) {
    url.searchParams.set("api-key", apiKey);
  }
  return url.toString();
}

export function buildWalletApiUrl(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = new URL(normalizedPath, HELIUS_API_ORIGIN);
  const apiKey = heliusApiKey();
  if (apiKey) {
    url.searchParams.set("api-key", apiKey);
  }
  return url.toString();
}

export async function parseEnhancedTransactions(signatures) {
  const unique = [...new Set(signatures)].filter(Boolean);
  if (unique.length === 0) return [];

  const results = [];
  const url = buildEnhancedTransactionsUrl();

  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const json = await retryingJsonRequest(() =>
      fetchWithTimeout(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          transactions: chunk,
        }),
      }),
    );
    if (Array.isArray(json)) {
      results.push(...json);
    } else if (Array.isArray(json?.result)) {
      results.push(...json.result);
    }
  }

  return results;
}

async function walletApiJson(pathname, init = {}) {
  const url = buildWalletApiUrl(pathname);
  return retryingJsonRequest(() =>
    fetchWithTimeout(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    }),
  );
}

function blockTimeBounds(records) {
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

async function gtfaSignaturePage(address, opts = {}) {
  const params = {
    transactionDetails: "signatures",
    sortOrder: opts.sortOrder ?? "asc",
    limit: opts.limit ?? GTFA_SIGNATURE_PAGE_LIMIT,
    commitment: "confirmed",
  };
  const filters = {};
  if ((opts.tokenAccountsMode ?? GTFA_TOKEN_ACCOUNTS_MODE) !== "none") {
    filters.tokenAccounts = opts.tokenAccountsMode ?? GTFA_TOKEN_ACCOUNTS_MODE;
  }
  if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
    const blockTime = {};
    if (opts.blockTimeGte != null) blockTime.gte = opts.blockTimeGte;
    if (opts.blockTimeLt != null) blockTime.lt = opts.blockTimeLt;
    filters.blockTime = blockTime;
  }
  if (Object.keys(filters).length > 0) {
    params.filters = filters;
  }
  if (opts.paginationToken) {
    params.paginationToken = opts.paginationToken;
  }

  const json = await rpcJson("getTransactionsForAddress", [address, params]);
  const result = json.result ?? {};
  return {
    txs: result.data ?? [],
    nextToken: result.paginationToken ?? null,
  };
}

async function gtfaPage(address, opts = {}) {
  const params = {
    transactionDetails: "full",
    sortOrder: opts.sortOrder ?? "asc",
    limit: opts.limit ?? GTFA_FULL_PAGE_LIMIT,
    commitment: "confirmed",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
  };
  const filters = {};
  if ((opts.tokenAccountsMode ?? GTFA_TOKEN_ACCOUNTS_MODE) !== "none") {
    filters.tokenAccounts = opts.tokenAccountsMode ?? GTFA_TOKEN_ACCOUNTS_MODE;
  }
  if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
    const blockTime = {};
    if (opts.blockTimeGte != null) blockTime.gte = opts.blockTimeGte;
    if (opts.blockTimeLt != null) blockTime.lt = opts.blockTimeLt;
    filters.blockTime = blockTime;
  }
  if (Object.keys(filters).length > 0) {
    params.filters = filters;
  }
  if (opts.paginationToken) {
    params.paginationToken = opts.paginationToken;
  }

  const json = await rpcJson("getTransactionsForAddress", [address, params]);
  const result = json.result ?? {};
  return {
    txs: result.data ?? [],
    nextToken: result.paginationToken ?? null,
  };
}

async function probeTimeline(address, start, end) {
  const [oldestPage, recentPage] = await Promise.all([
    gtfaSignaturePage(address, {
      sortOrder: "asc",
      limit: 1,
      blockTimeGte: start,
      blockTimeLt: end,
    }),
    gtfaSignaturePage(address, {
      sortOrder: "desc",
      limit: GTFA_SIGNATURE_PAGE_LIMIT,
      blockTimeGte: start,
      blockTimeLt: end,
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
    return { firstBlockTime, estimatedTxCount: recentPage.txs.length };
  }

  const sampleCoveredSpan = Math.max(bounds.max - bounds.min, 1);
  const totalSpan = Math.max(bounds.max - firstBlockTime, 1);
  const estimate = Math.ceil(recentPage.txs.length * (totalSpan / sampleCoveredSpan));

  return {
    firstBlockTime,
    estimatedTxCount: Math.max(estimate, recentPage.txs.length),
  };
}

function optimalSliceCount(estimatedTxCount, totalSpanSecs) {
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

function createUniformSlices(firstTs, nowTs, count) {
  const span = nowTs - firstTs;
  if (span <= 0 || count <= 0) return [{ gte: firstTs, lt: nowTs }];
  const sliceSize = Math.ceil(span / count);
  const slices = [];
  for (let i = 0; i < count; i += 1) {
    const gte = firstTs + i * sliceSize;
    const lt = Math.min(firstTs + (i + 1) * sliceSize, nowTs);
    if (gte < lt) slices.push({ gte, lt });
  }
  return slices;
}

export async function mapWithConcurrency(items, limit, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );

  return results;
}

async function fetchSlice(address, gte, lt, maxPages = 200) {
  const all = [];
  let token;
  const requestLt = lt - gte <= 1 ? lt + 1 : lt;
  const seenTokens = new Set();

  for (let i = 0; i < maxPages; i += 1) {
    const page = await gtfaPage(address, {
      sortOrder: "asc",
      blockTimeGte: gte,
      blockTimeLt: requestLt,
      paginationToken: token,
    });

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

function deduplicateTransactions(txs) {
  const seen = new Set();
  const unique = [];
  for (const tx of txs) {
    const signature = tx?.transaction?.signatures?.[0];
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(tx);
  }
  return unique;
}

export async function fetchTransactions(address, range = {}) {
  const start = range.start ?? undefined;
  const end = range.end ?? undefined;
  const cacheKey = `tx:${address}:${start ?? "all"}:${end ?? "all"}`;

  return cachedValue(cacheKey, 10 * 60 * 1000, async () => {
    const probe = await probeTimeline(address, start, end);
    if (!probe) return [];

    const windowStart = start ?? probe.firstBlockTime;
    const windowEnd = end ?? Math.floor(Date.now() / 1000) + 60;
    const totalSpan = Math.max(windowEnd - windowStart, 1);
    const sliceCount = optimalSliceCount(probe.estimatedTxCount, totalSpan);
    const slices = createUniformSlices(windowStart, windowEnd, sliceCount);

    const results = await mapWithConcurrency(
      slices,
      MAX_SLICE_CONCURRENCY,
      (slice) => fetchSlice(address, slice.gte, slice.lt),
    );

    return deduplicateTransactions(results.flat());
  });
}

export async function fetchRecentTransactions(address, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 1200), 5000));
  const cacheKey = `txRecent:${address}:${limit}`;

  return cachedValue(cacheKey, 10 * 60 * 1000, async () => {
    const all = [];
    let token;
    const seenTokens = new Set();

    while (all.length < limit) {
      const page = await gtfaPage(address, {
        sortOrder: "desc",
        limit: Math.min(GTFA_FULL_PAGE_LIMIT, limit - all.length),
        paginationToken: token,
      });

      const { txs, nextToken } = page;
      all.push(...txs);

      if (!nextToken) {
        token = undefined;
        break;
      }

      if (seenTokens.has(nextToken)) {
        throw new Error(`GTFA recent pagination repeated for ${address}`);
      }

      seenTokens.add(nextToken);
      token = nextToken;
    }

    return deduplicateTransactions(all);
  });
}

export async function getBatchIdentity(addresses) {
  const unique = [...new Set(addresses)].filter(isValidSolanaAddress);
  if (unique.length === 0) return new Map();

  const { hits, missing } = readPerItemCache(unique, "identity:item");
  if (missing.length === 0) return hits;

  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) {
    chunks.push(missing.slice(i, i + 100));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_METADATA_FETCH_CONCURRENCY,
    async (chunk) => withInflightValue(`identity:chunk:${chunk.join(",")}`, async () => {
      try {
        const json = await walletApiJson("/v1/wallet/batch-identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: chunk }),
        });
        return Array.isArray(json) ? json : [];
      } catch {
        return [];
      }
    }),
  );

  const fetched = new Map();
  for (const batch of results) {
    for (const item of batch) {
      if (!item?.address) continue;
      fetched.set(item.address, {
        address: item.address,
        name: item.name,
        label: item.name,
        category: item.category,
        tags: item.tags ?? [],
      });
    }
  }

  writePerItemCache(missing, "identity:item", fetched, IDENTITY_TTL_MS);
  for (const [address, identity] of fetched) {
    hits.set(address, identity);
  }

  return hits;
}

export async function getTokenMetadataBatch(mints) {
  const unique = [...new Set(mints)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const { hits, missing } = readPerItemCache(unique, "tokenMeta:item");
  if (missing.length === 0) return hits;

  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) {
    chunks.push(missing.slice(i, i + 100));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_METADATA_FETCH_CONCURRENCY,
    async (chunk) => withInflightValue(`tokenMeta:chunk:${chunk.join(",")}`, async () => {
      try {
        const json = await rpcJson("getAssetBatch", { ids: chunk });
        return Array.isArray(json.result) ? json.result : [];
      } catch {
        return [];
      }
    }),
  );

  const fetched = new Map();
  for (const assets of results) {
    for (const asset of assets) {
      if (!asset?.id) continue;
      const content = asset.content?.metadata;
      const links = asset.content?.links;
      const tokenInfo = asset.token_info;
      fetched.set(asset.id, {
        name: content?.name ?? undefined,
        symbol: content?.symbol ?? tokenInfo?.symbol ?? undefined,
        logoUri: links?.image ?? asset.content?.json_uri ?? undefined,
      });
    }
  }

  writePerItemCache(missing, "tokenMeta:item", fetched, TOKEN_METADATA_TTL_MS);
  for (const [mint, meta] of fetched) {
    hits.set(mint, meta);
  }

  return hits;
}

export async function getAccountTypesParallel(addresses) {
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const { hits, missing } = readPerItemCache(unique, "acctType:item");
  if (missing.length === 0) return hits;

  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) {
    chunks.push(missing.slice(i, i + 100));
  }

  const results = await mapWithConcurrency(
    chunks,
    MAX_ACCOUNT_TYPE_CONCURRENCY,
    async (chunk) => withInflightValue(`acctType:chunk:${chunk.join(",")}`, async () => {
      try {
        const json = await rpcJson("getMultipleAccounts", [
          chunk,
          { encoding: "jsonParsed", commitment: "confirmed" },
        ]);
        const accounts = json.result?.value ?? [];
        return chunk.map((address, index) => {
          const info = accounts[index];
          if (!info) return [address, { type: "unknown" }];
          if (info.executable) return [address, { type: "program" }];
          const owner = info.owner;
          if (owner === SYSTEM_PROGRAM) return [address, { type: "wallet" }];
          if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
            const mint = info.data?.parsed?.info?.mint;
            return [address, { type: "token", ...(mint ? { mint } : {}) }];
          }
          return [address, { type: "other" }];
        });
      } catch {
        return chunk.map((address) => [address, { type: "unknown" }]);
      }
    }),
  );

  const fetched = new Map();
  for (const chunk of results) {
    for (const [address, info] of chunk) {
      fetched.set(address, info);
    }
  }

  writePerItemCache(missing, "acctType:item", fetched, ACCOUNT_TYPE_TTL_MS);
  for (const [address, info] of fetched) {
    hits.set(address, info);
  }

  return hits;
}

async function fetchOwnerTokenAccountsForProgram(owner, mint, programId) {
  const json = await rpcJson("getTokenAccountsByOwner", [
    owner,
    { programId },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);

  const accounts = json.result?.value ?? [];
  return accounts
    .filter((account) => account?.account?.data?.parsed?.info?.mint === mint)
    .map((account) => account?.pubkey ?? "")
    .filter(Boolean);
}

async function fetchOwnerTokenBalancesForProgram(owner, programId) {
  const json = await rpcJson("getTokenAccountsByOwner", [
    owner,
    { programId },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);

  const accounts = Array.isArray(json?.result?.value) ? json.result.value : [];
  const balances = new Map();

  for (const account of accounts) {
    const info = account?.account?.data?.parsed?.info;
    const mint = typeof info?.mint === "string" ? info.mint : "";
    const tokenAmount = info?.tokenAmount;
    const amount = typeof tokenAmount?.amount === "string" ? tokenAmount.amount : "";
    const decimals = Number(tokenAmount?.decimals ?? 0);
    if (!mint || !amount || !Number.isFinite(decimals)) continue;

    let rawAmount;
    try {
      rawAmount = BigInt(amount);
    } catch {
      continue;
    }

    if (rawAmount === 0n) continue;

    const existing = balances.get(mint) ?? {
      rawAmount: 0n,
      decimals,
    };

    existing.rawAmount += rawAmount;
    if (!Number.isFinite(existing.decimals) || existing.decimals === 0) {
      existing.decimals = decimals;
    }
    balances.set(mint, existing);
  }

  return balances;
}

export async function getCurrentTokenBalancesByOwner(owner) {
  const cacheKey = `ownerTokenBalances:${owner}`;
  return cachedValue(cacheKey, OWNER_MINT_TOKEN_ACCOUNTS_TTL_MS, async () => {
    const results = await Promise.allSettled([
      fetchOwnerTokenBalancesForProgram(owner, TOKEN_PROGRAM),
      fetchOwnerTokenBalancesForProgram(owner, TOKEN_2022_PROGRAM),
    ]);

    const balances = new Map();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const [mint, next] of result.value.entries()) {
        const current = balances.get(mint) ?? {
          rawAmount: 0n,
          decimals: next.decimals,
        };
        current.rawAmount += next.rawAmount;
        if (!Number.isFinite(current.decimals) || current.decimals === 0) {
          current.decimals = next.decimals;
        }
        balances.set(mint, current);
      }
    }

    return balances;
  });
}

export async function getTokenAccountAddressesByOwner(owner, mint) {
  const cacheKey = `ownerMintTokenAccounts:${owner}:${mint}`;
  return cachedValue(cacheKey, OWNER_MINT_TOKEN_ACCOUNTS_TTL_MS, async () => {
    const results = await Promise.allSettled([
      fetchOwnerTokenAccountsForProgram(owner, mint, TOKEN_PROGRAM),
      fetchOwnerTokenAccountsForProgram(owner, mint, TOKEN_2022_PROGRAM),
    ]);

    const addresses = new Set();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const address of result.value) {
        addresses.add(address);
      }
    }
    return [...addresses];
  });
}
