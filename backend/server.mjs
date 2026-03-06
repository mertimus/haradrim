import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY?.trim() ?? "";
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY?.trim() ?? "";
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 1000);
const CACHE_MAX_BODY_BYTES = Number(process.env.CACHE_MAX_BODY_BYTES ?? 2_000_000);

const cache = new Map();

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function cacheKey(method, pathname, search, bodyText) {
  return `${method}:${pathname}${search}:${sha1(bodyText)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCached(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  pruneCache();
  cache.set(key, {
    ...value,
    expiresAt: Date.now() + ttlMs,
  });
}

function ttlForHeliusRpc(bodyText) {
  try {
    const payload = JSON.parse(bodyText);
    const method = payload?.method;
    switch (method) {
      case "getTransactionsForAddress":
        return 10 * 60 * 1000;
      case "getAssetBatch":
        return 60 * 60 * 1000;
      case "getMultipleAccounts":
        return 60 * 60 * 1000;
      case "getTokenLargestAccountsV2":
        return 10 * 60 * 1000;
      case "getTokenSupply":
        return 60 * 60 * 1000;
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

function ttlForHeliusApi(pathname) {
  if (pathname.endsWith("/identity") || pathname.endsWith("/batch-identity")) {
    return 30 * 60 * 1000;
  }
  if (pathname.endsWith("/funded-by")) {
    return 30 * 60 * 1000;
  }
  if (pathname.includes("/balances")) {
    return 5 * 60 * 1000;
  }
  return 0;
}

function ttlForBirdeye(pathname) {
  if (pathname.includes("/token_trending") || pathname.includes("/token_overview")) {
    return 5 * 60 * 1000;
  }
  return 0;
}

function ttlForRequest(routeKind, pathname, bodyText) {
  if (routeKind === "helius-rpc") return ttlForHeliusRpc(bodyText);
  if (routeKind === "helius-api") return ttlForHeliusApi(pathname);
  if (routeKind === "birdeye-api") return ttlForBirdeye(pathname);
  return 0;
}

function upstreamFor(pathname, search) {
  const normalizedPath = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;

  if (normalizedPath === "/helius-rpc") {
    const upstream = new URL("https://mainnet.helius-rpc.com/");
    if (HELIUS_API_KEY) upstream.searchParams.set("api-key", HELIUS_API_KEY);
    return { kind: "helius-rpc", url: upstream.toString() };
  }

  if (normalizedPath.startsWith("/helius-api/")) {
    const upstream = new URL(`https://api.helius.xyz${normalizedPath.replace(/^\/helius-api/, "")}${search}`);
    if (HELIUS_API_KEY) upstream.searchParams.set("api-key", HELIUS_API_KEY);
    return { kind: "helius-api", url: upstream.toString() };
  }

  if (normalizedPath.startsWith("/birdeye-api/")) {
    const upstream = new URL(`https://public-api.birdeye.so${normalizedPath.replace(/^\/birdeye-api/, "")}${search}`);
    return { kind: "birdeye-api", url: upstream.toString() };
  }

  return null;
}

function proxyHeaders(reqHeaders, routeKind) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value == null) continue;
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "connection" ||
      lowerKey === "content-length" ||
      lowerKey === "accept-encoding" ||
      lowerKey === "x-api-key"
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
  const headers = {
    "content-length": String(bodyLength),
    "cache-control": upstreamHeaders.get("cache-control") ?? "no-store",
    "content-type": upstreamHeaders.get("content-type") ?? "application/json; charset=utf-8",
  };
  return headers;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", "http://localhost");

  if (requestUrl.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      cacheEntries: cache.size,
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  const upstream = upstreamFor(requestUrl.pathname, requestUrl.search);
  if (!upstream) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const bodyText = method === "GET" || method === "HEAD" ? "" : await readBody(req);
  const ttlMs = ttlForRequest(upstream.kind, requestUrl.pathname, bodyText);
  const key = cacheKey(method, requestUrl.pathname, requestUrl.search, bodyText);

  if (ttlMs > 0) {
    const hit = getCached(key);
    if (hit) {
      res.writeHead(hit.status, hit.headers);
      res.end(hit.body);
      return;
    }
  }

  try {
    const upstreamRes = await fetch(upstream.url, {
      method,
      headers: proxyHeaders(req.headers, upstream.kind),
      body: method === "GET" || method === "HEAD" ? undefined : bodyText,
    });

    const bodyBuffer = Buffer.from(await upstreamRes.arrayBuffer());
    const headers = responseHeaders(upstreamRes.headers, bodyBuffer.length);

    res.writeHead(upstreamRes.status, headers);
    res.end(bodyBuffer);

    if (
      ttlMs > 0 &&
      upstreamRes.ok &&
      bodyBuffer.length <= CACHE_MAX_BODY_BYTES &&
      method !== "HEAD"
    ) {
      setCached(key, {
        status: upstreamRes.status,
        headers,
        body: bodyBuffer,
      }, ttlMs);
    }
  } catch (error) {
    sendJson(res, 502, {
      error: "upstream_failure",
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`haradrim-backend listening on http://${HOST}:${PORT}`);
});
