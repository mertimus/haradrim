import http from "node:http";
import { createHash } from "node:crypto";
import {
  BIRDEYE_API_KEY,
  CACHE_MAX_BODY_BYTES,
  HOST,
  HELIUS_RPC_URL,
  PORT,
  PROXY_TTL_MS,
  TRACE_ANALYSIS_TTL_MS,
  WALLET_ANALYSIS_TTL_MS,
} from "./config.mjs";
import { cachedValue, getCacheSize, getCachedValue, setCachedValue } from "./cache.mjs";
import { analyzeTrace, analyzeWallet } from "./analysis-core.mjs";
import { buildWalletApiUrl, fetchWithTimeout } from "./providers.mjs";

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
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

function proxyHeaders(reqHeaders, routeKind) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value == null) continue;
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host"
      || lowerKey === "connection"
      || lowerKey === "content-length"
      || lowerKey === "accept-encoding"
      || lowerKey === "x-api-key"
    ) {
      continue;
    }
    headers.set(lowerKey, Array.isArray(value) ? value.join(", ") : value);
  }

  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (routeKind === "birdeye-api" && BIRDEYE_API_KEY) {
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

async function handleWalletAnalysis(res, address, searchParams) {
  const range = parseRange(searchParams);
  const cacheKey = `wallet-analysis:${address}:${range.start ?? "all"}:${range.end ?? "all"}`;
  const result = await cachedValue(cacheKey, WALLET_ANALYSIS_TTL_MS, () => analyzeWallet(address, range));
  sendJson(res, 200, result);
}

async function handleTraceAnalysis(res, address, searchParams) {
  const range = parseRange(searchParams);
  const cacheKey = `trace-analysis:${address}:${range.start ?? "all"}:${range.end ?? "all"}`;
  const result = await cachedValue(cacheKey, TRACE_ANALYSIS_TTL_MS, () => analyzeTrace(address, range));
  sendJson(res, 200, result);
}

async function handleProxy(req, res, pathname, search) {
  const method = req.method ?? "GET";
  const upstream = upstreamFor(pathname, search);
  if (!upstream) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const bodyText = method === "GET" || method === "HEAD" ? "" : await readBody(req);
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

  const upstreamRes = await fetchWithTimeout(upstream.url, {
    method,
    headers: proxyHeaders(req.headers, upstream.kind),
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
      });
      return;
    }

    const walletMatch = matchWalletAnalysis(pathname);
    if (walletMatch) {
      await handleWalletAnalysis(res, walletMatch[1], requestUrl.searchParams);
      return;
    }

    const traceMatch = matchTraceAnalysis(pathname);
    if (traceMatch) {
      await handleTraceAnalysis(res, traceMatch[1], requestUrl.searchParams);
      return;
    }

    await handleProxy(req, res, requestUrl.pathname, requestUrl.search);
  } catch (error) {
    sendJson(res, 502, {
      error: "request_failed",
      message: error instanceof Error ? error.message : "unknown error",
    });
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
