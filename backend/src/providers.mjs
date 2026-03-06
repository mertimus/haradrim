import {
  FETCH_TIMEOUT_MS,
  GTFA_SIGNATURE_PAGE_LIMIT,
  GTFA_TOKEN_ACCOUNTS_MODE,
  HELIUS_API_KEY,
  HELIUS_API_ORIGIN,
  HELIUS_RPC_URL,
  MAX_ACCOUNT_TYPE_CONCURRENCY,
  MAX_METADATA_FETCH_CONCURRENCY,
  MAX_SLICE_CONCURRENCY,
  MAX_TRANSACTION_SLICES,
  RATE_LIMIT_RETRIES,
  TARGET_GTFA_TXS_PER_SLICE,
} from "./config.mjs";
import { cachedValue } from "./cache.mjs";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export async function fetchWithTimeout(input, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
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

async function retryingJsonRequest(makeRequest) {
  let lastError = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const response = await makeRequest();
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (isRetryableStatus(response.status) && attempt < RATE_LIMIT_RETRIES) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new Error(`upstream ${response.status}: ${body.slice(0, 200)}`);
      }
      const json = await response.json();
      if (json?.error) {
        if ((json.error.code === -32429 || isRetryableStatus(Number(json.error.code))) && attempt < RATE_LIMIT_RETRIES) {
          await sleep(400 * (attempt + 1));
          continue;
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

async function rpcJson(method, params) {
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
    }),
  );
}

export function buildWalletApiUrl(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const url = new URL(normalizedPath, HELIUS_API_ORIGIN);
  if (HELIUS_API_KEY) {
    url.searchParams.set("api-key", HELIUS_API_KEY);
  }
  return url.toString();
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
    limit: 1000,
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

async function mapWithConcurrency(items, limit, worker) {
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

export async function getBatchIdentity(addresses) {
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const cacheKey = `identity:${unique.slice().sort().join(",")}`;
  return cachedValue(cacheKey, 30 * 60 * 1000, async () => {
    const chunks = [];
    for (let i = 0; i < unique.length; i += 100) {
      chunks.push(unique.slice(i, i + 100));
    }

    const results = await mapWithConcurrency(
      chunks,
      MAX_METADATA_FETCH_CONCURRENCY,
      async (chunk) => {
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
      },
    );

    const map = new Map();
    for (const batch of results) {
      for (const item of batch) {
        if (!item?.address) continue;
        map.set(item.address, {
          address: item.address,
          name: item.name,
          label: item.name,
          category: item.category,
          tags: item.tags ?? [],
        });
      }
    }
    return map;
  });
}

export async function getTokenMetadataBatch(mints) {
  const unique = [...new Set(mints)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const cacheKey = `tokenMeta:${unique.slice().sort().join(",")}`;
  return cachedValue(cacheKey, 60 * 60 * 1000, async () => {
    const chunks = [];
    for (let i = 0; i < unique.length; i += 100) {
      chunks.push(unique.slice(i, i + 100));
    }

    const results = await mapWithConcurrency(
      chunks,
      MAX_METADATA_FETCH_CONCURRENCY,
      async (chunk) => {
        try {
          const json = await rpcJson("getAssetBatch", { ids: chunk });
          return Array.isArray(json.result) ? json.result : [];
        } catch {
          return [];
        }
      },
    );

    const map = new Map();
    for (const assets of results) {
      for (const asset of assets) {
        if (!asset?.id) continue;
        const content = asset.content?.metadata;
        const links = asset.content?.links;
        map.set(asset.id, {
          name: content?.name,
          symbol: content?.symbol,
          logoUri: links?.image ?? asset.content?.json_uri,
        });
      }
    }
    return map;
  });
}

export async function getAccountTypesParallel(addresses) {
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const cacheKey = `acctType:${unique.slice().sort().join(",")}`;
  return cachedValue(cacheKey, 60 * 60 * 1000, async () => {
    const chunks = [];
    for (let i = 0; i < unique.length; i += 100) {
      chunks.push(unique.slice(i, i + 100));
    }

    const results = await mapWithConcurrency(
      chunks,
      MAX_ACCOUNT_TYPE_CONCURRENCY,
      async (chunk) => {
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
      },
    );

    const map = new Map();
    for (const chunk of results) {
      for (const [address, info] of chunk) {
        map.set(address, info);
      }
    }
    return map;
  });
}
