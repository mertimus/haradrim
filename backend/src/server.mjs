import http from "node:http";
import { createHash } from "node:crypto";
import {
  BIRDEYE_API_KEY,
  CACHE_MAX_BODY_BYTES,
  HOST,
  HELIUS_RPC_URL,
  JSON_PROXY_BODY_LIMIT_BYTES,
  MAX_GTFA_RPC_CONCURRENCY,
  PORT,
  PROXY_TTL_MS,
  REQUEST_BODY_LIMIT_BYTES,
  TRACE_ANALYSIS_TTL_MS,
  WALLET_ANALYSIS_TTL_MS,
} from "./config.mjs";
import { cachedValue, getCacheSize, getCachedValue, getInflightValue, setCachedValue } from "./cache.mjs";
import {
  createHttpError,
  enforceHeavyRouteBudget,
  getGuardStats,
  HEAVY_ROUTE_POLICIES,
  withConcurrencyLimit,
} from "./guard.mjs";
import { analyzeTrace, analyzeWallet } from "./analysis-core.mjs";
import { buildWalletApiUrl, fetchWithTimeout } from "./providers.mjs";

const ALLOWED_RPC_METHODS = new Map([
  ["getTransactionsForAddress", { heavy: true }],
  ["getAssetBatch", { heavy: false }],
  ["getMultipleAccounts", { heavy: false }],
  ["getProgramAccounts", { heavy: false }],
  ["getTokenSupply", { heavy: false }],
  ["getTokenLargestAccountsV2", { heavy: false }],
]);

const ALLOWED_HELIUS_API_ROUTES = [
  {
    pattern: /^\/helius-api\/v1\/wallet\/batch-identity$/,
    methods: new Set(["POST"]),
  },
  {
    pattern: /^\/helius-api\/v1\/wallet\/[A-Za-z0-9]+\/identity$/,
    methods: new Set(["GET"]),
  },
  {
    pattern: /^\/helius-api\/v1\/wallet\/[A-Za-z0-9]+\/balances$/,
    methods: new Set(["GET"]),
  },
  {
    pattern: /^\/helius-api\/v1\/wallet\/[A-Za-z0-9]+\/funded-by$/,
    methods: new Set(["GET"]),
  },
];

const ALLOWED_BIRDEYE_PATHS = new Map([
  ["/birdeye-api/defi/token_trending", new Set(["GET"])],
  ["/birdeye-api/defi/token_overview", new Set(["GET"])],
]);

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req, limitBytes = REQUEST_BODY_LIMIT_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limitBytes) {
      throw createHttpError(413, "body_too_large", `Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePathname(pathname) {
  return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

function parseRange(searchParams) {
  const startRaw = searchParams.get("start");
  const endRaw = searchParams.get("end");
  const start = startRaw ? Number(startRaw) : null;
  const end = endRaw ? Number(endRaw) : null;
  return {
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
  };
}

function matchWalletAnalysis(pathname) {
  return pathname.match(/^\/wallets\/([A-Za-z0-9]+)\/analysis$/);
}

function matchTraceAnalysis(pathname) {
  return pathname.match(/^\/traces\/([A-Za-z0-9]+)\/flows$/);
}

function assertAllowedMethod(method, allowedMethods, pathname) {
  if (!allowedMethods.has(method)) {
    throw createHttpError(405, "method_not_allowed", `Method ${method} not allowed for ${pathname}`);
  }
}

function ttlForHeliusRpc(bodyText) {
  try {
    const payload = JSON.parse(bodyText);
    const method = payload?.method;
    switch (method) {
      case "getTransactionsForAddress":
        return 10 * 60 * 1000;
      case "getAssetBatch":
      case "getMultipleAccounts":
      case "getTokenSupply":
        return 60 * 60 * 1000;
      case "getTokenLargestAccountsV2":
        return 10 * 60 * 1000;
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

function ttlForHeliusApi(pathname) {
  if (pathname.endsWith("/identity") || pathname.endsWith("/batch-identity")) return 30 * 60 * 1000;
  if (pathname.endsWith("/funded-by")) return 30 * 60 * 1000;
  if (pathname.includes("/balances")) return 5 * 60 * 1000;
  return 0;
}

function ttlForBirdeye(pathname) {
  if (pathname.includes("/token_trending") || pathname.includes("/token_overview")) return 5 * 60 * 1000;
  return 0;
}

function proxyTtl(routeKind, pathname, bodyText) {
  if (routeKind === "helius-rpc") return ttlForHeliusRpc(bodyText);
  if (routeKind === "helius-api") return ttlForHeliusApi(pathname);
  if (routeKind === "birdeye-api") return ttlForBirdeye(pathname);
  return PROXY_TTL_MS;
}

function validateHeliusApiPath(pathname, method) {
  const matched = ALLOWED_HELIUS_API_ROUTES.find((route) => route.pattern.test(pathname));
  if (!matched) {
    throw createHttpError(404, "not_found", "Helius API route not allowed");
  }
  assertAllowedMethod(method, matched.methods, pathname);
}

function validateBirdeyePath(pathname, method) {
  const allowedMethods = ALLOWED_BIRDEYE_PATHS.get(pathname);
  if (!allowedMethods) {
    throw createHttpError(404, "not_found", "Birdeye route not allowed");
  }
  assertAllowedMethod(method, allowedMethods, pathname);
}

function parseRpcRequest(bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw createHttpError(400, "invalid_json", "RPC body must be valid JSON");
  }

  const method = payload?.method;
  if (typeof method !== "string" || !method) {
    throw createHttpError(400, "invalid_rpc_method", "RPC body must include a method");
  }

  const rpcPolicy = ALLOWED_RPC_METHODS.get(method);
  if (!rpcPolicy) {
    throw createHttpError(403, "rpc_method_not_allowed", `RPC method ${method} is not allowed`);
  }

  return { method, policy: rpcPolicy };
}

function upstreamFor(pathname, search) {
  const normalizedPath = normalizePathname(pathname);

  if (normalizedPath === "/helius-rpc") {
    return { kind: "helius-rpc", url: HELIUS_RPC_URL };
  }

  if (normalizedPath.startsWith("/helius-api/")) {
    const relative = normalizedPath.replace(/^\/helius-api/, "");
    const upstream = new URL(buildWalletApiUrl(relative));
    const incoming = new URLSearchParams(search);
    for (const [key, value] of incoming.entries()) {
      upstream.searchParams.set(key, value);
    }
    return { kind: "helius-api", url: upstream.toString() };
  }

  if (normalizedPath.startsWith("/birdeye-api/")) {
    return {
      kind: "birdeye-api",
      url: `https://public-api.birdeye.so${normalizedPath.replace(/^\/birdeye-api/, "")}${search}`,
    };
  }

  return null;
}

function proxyHeaders(routeKind, method) {
  const headers = new Headers();
  headers.set("accept", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    headers.set("content-type", "application/json");
  }
  if (routeKind === "birdeye-api" && BIRDEYE_API_KEY) {
    headers.set("x-chain", "solana");
    headers.set("x-api-key", BIRDEYE_API_KEY);
  }

  return headers;
}

function responseHeaders(upstreamHeaders, bodyLength) {
  return {
    "content-length": String(bodyLength),
    "cache-control": upstreamHeaders.get("cache-control") ?? "no-store",
    "content-type": upstreamHeaders.get("content-type") ?? "application/json; charset=utf-8",
  };
}

async function handleWalletAnalysis(req, res, address, searchParams) {
  const range = parseRange(searchParams);
  const cacheKey = `wallet-analysis:${address}:${range.start ?? "all"}:${range.end ?? "all"}`;
  const cached = getCachedValue(cacheKey);
  if (cached) {
    sendJson(res, 200, cached);
    return;
  }

  const pending = getInflightValue(cacheKey);
  if (pending) {
    sendJson(res, 200, await pending);
    return;
  }

  enforceHeavyRouteBudget(req, res, HEAVY_ROUTE_POLICIES.walletAnalysis);
  const result = await withConcurrencyLimit(
    HEAVY_ROUTE_POLICIES.walletAnalysis.concurrencyLabel,
    HEAVY_ROUTE_POLICIES.walletAnalysis.maxConcurrency,
    () => cachedValue(cacheKey, WALLET_ANALYSIS_TTL_MS, () => analyzeWallet(address, range)),
  );
  sendJson(res, 200, result);
}

async function handleTraceAnalysis(req, res, address, searchParams) {
  const range = parseRange(searchParams);
  const cacheKey = `trace-analysis:${address}:${range.start ?? "all"}:${range.end ?? "all"}`;
  const cached = getCachedValue(cacheKey);
  if (cached) {
    sendJson(res, 200, cached);
    return;
  }

  const pending = getInflightValue(cacheKey);
  if (pending) {
    sendJson(res, 200, await pending);
    return;
  }

  enforceHeavyRouteBudget(req, res, HEAVY_ROUTE_POLICIES.traceAnalysis);
  const result = await withConcurrencyLimit(
    HEAVY_ROUTE_POLICIES.traceAnalysis.concurrencyLabel,
    HEAVY_ROUTE_POLICIES.traceAnalysis.maxConcurrency,
    () => cachedValue(cacheKey, TRACE_ANALYSIS_TTL_MS, () => analyzeTrace(address, range)),
  );
  sendJson(res, 200, result);
}

async function handleProxy(req, res, pathname, search) {
  const method = req.method ?? "GET";
  const normalizedPath = normalizePathname(pathname);
  let bodyText = "";
  let heavyPolicy = null;

  if (normalizedPath === "/helius-rpc") {
    assertAllowedMethod(method, new Set(["POST"]), normalizedPath);
    bodyText = await readBody(req, JSON_PROXY_BODY_LIMIT_BYTES);
    const rpcRequest = parseRpcRequest(bodyText);
    if (rpcRequest.policy.heavy) {
      heavyPolicy = HEAVY_ROUTE_POLICIES.gtfaRpc;
    }
  } else if (normalizedPath.startsWith("/helius-api/")) {
    validateHeliusApiPath(normalizedPath, method);
    if (method !== "GET" && method !== "HEAD") {
      bodyText = await readBody(req, JSON_PROXY_BODY_LIMIT_BYTES);
    }
  } else if (normalizedPath.startsWith("/birdeye-api/")) {
    validateBirdeyePath(normalizedPath, method);
  } else {
    throw createHttpError(404, "not_found", "Route not found");
  }

  const upstream = upstreamFor(pathname, search);
  if (!upstream) {
    throw createHttpError(404, "not_found", "Route not found");
  }

  const ttlMs = proxyTtl(upstream.kind, pathname, bodyText);
  const cacheKey = `proxy:${method}:${pathname}${search}:${sha1(bodyText)}`;

  if (ttlMs > 0) {
    const hit = getCachedValue(cacheKey);
    if (hit) {
      res.writeHead(hit.status, hit.headers);
      res.end(hit.body);
      return;
    }
  }

  const fetchUpstream = async () => {
    const upstreamRes = await fetchWithTimeout(upstream.url, {
      method,
      headers: proxyHeaders(upstream.kind, method),
      body: method === "GET" || method === "HEAD" ? undefined : bodyText,
    });

    const bodyBuffer = Buffer.from(await upstreamRes.arrayBuffer());
    const headers = responseHeaders(upstreamRes.headers, bodyBuffer.length);
    res.writeHead(upstreamRes.status, headers);
    res.end(bodyBuffer);

    if (
      ttlMs > 0
      && upstreamRes.ok
      && bodyBuffer.length <= CACHE_MAX_BODY_BYTES
      && method !== "HEAD"
    ) {
      setCachedValue(cacheKey, {
        status: upstreamRes.status,
        headers,
        body: bodyBuffer,
      }, ttlMs);
    }
  };

  if (!heavyPolicy) {
    await fetchUpstream();
    return;
  }

  enforceHeavyRouteBudget(req, res, heavyPolicy);
  await withConcurrencyLimit(
    heavyPolicy.concurrencyLabel,
    heavyPolicy.maxConcurrency,
    fetchUpstream,
  );
}

async function requestHandler(req, res) {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = normalizePathname(requestUrl.pathname);

    if (pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        cacheEntries: getCacheSize(),
        uptimeSec: Math.round(process.uptime()),
        guards: getGuardStats(),
      });
      return;
    }

    const walletMatch = matchWalletAnalysis(pathname);
    if (walletMatch) {
      assertAllowedMethod(req.method ?? "GET", new Set(["GET"]), pathname);
      await handleWalletAnalysis(req, res, walletMatch[1], requestUrl.searchParams);
      return;
    }

    const traceMatch = matchTraceAnalysis(pathname);
    if (traceMatch) {
      assertAllowedMethod(req.method ?? "GET", new Set(["GET"]), pathname);
      await handleTraceAnalysis(req, res, traceMatch[1], requestUrl.searchParams);
      return;
    }

    await handleProxy(req, res, requestUrl.pathname, requestUrl.search);
  } catch (error) {
    const statusCode = Number(error?.statusCode ?? 502);
    const errorCode = error?.error ?? "request_failed";
    const details = error?.details ?? undefined;
    const extraHeaders = details?.retryAfterSec
      ? { "retry-after": String(details.retryAfterSec) }
      : {};

    sendJson(res, statusCode, {
      error: errorCode,
      message: error instanceof Error ? error.message : "unknown error",
      ...(details ? { details } : {}),
    }, extraHeaders);
  }
}

export function startServer() {
  const server = http.createServer((req, res) => {
    void requestHandler(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`haradrim-backend listening on http://${HOST}:${PORT}`);
  });

  return server;
}
