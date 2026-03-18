import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MAX_BALANCE_HISTORY_CONCURRENCY,
  MAX_BALANCE_HISTORY_LEGACY_CONCURRENCY,
  HOST,
  IP_BUDGET_UNITS,
  IP_WINDOW_MS,
  MAX_GTFA_RPC_CONCURRENCY,
  MAX_ENHANCED_HISTORY_CONCURRENCY,
  MAX_PROVENANCE_ANALYSIS_CONCURRENCY,
  MAX_TOKEN_FORENSICS_CONCURRENCY,
  MAX_TOKEN_SNAPSHOT_CONCURRENCY,
  MAX_TRACE_ANALYSIS_CONCURRENCY,
  MAX_WALLET_ANALYSIS_CONCURRENCY,
  MAX_STABLECOIN_DASHBOARD_CONCURRENCY,
  ROUTE_CONCURRENCY_WAIT_MS,
  SESSION_BUDGET_UNITS,
  SESSION_COOKIE_NAME,
  SESSION_SECRET,
  SESSION_WINDOW_MS,
} from "./config.mjs";

const GUARDS_ENABLED = process.env.NODE_ENV === "production";

const usageBySession = new Map();
const usageByIp = new Map();
const concurrencyByRoute = new Map();

export const HEAVY_ROUTE_POLICIES = {
  walletAnalysis: {
    routeKey: "wallet-analysis",
    cost: 5,
    concurrencyLabel: "wallet-analysis",
    maxConcurrency: MAX_WALLET_ANALYSIS_CONCURRENCY,
  },
  traceAnalysis: {
    routeKey: "trace-analysis",
    cost: 8,
    concurrencyLabel: "trace-analysis",
    maxConcurrency: MAX_TRACE_ANALYSIS_CONCURRENCY,
  },
  balanceHistory: {
    routeKey: "balance-history",
    cost: 6,
    concurrencyLabel: "balance-history",
    maxConcurrency: MAX_BALANCE_HISTORY_CONCURRENCY,
  },
  balanceHistoryLegacy: {
    routeKey: "balance-history-legacy",
    cost: 12,
    concurrencyLabel: "balance-history-legacy",
    maxConcurrency: MAX_BALANCE_HISTORY_LEGACY_CONCURRENCY,
  },
  gtfaRpc: {
    routeKey: "gtfa-rpc",
    cost: 10,
    concurrencyLabel: "gtfa-rpc",
    maxConcurrency: MAX_GTFA_RPC_CONCURRENCY,
  },
  enhancedHistory: {
    routeKey: "enhanced-history",
    cost: 6,
    concurrencyLabel: "enhanced-history",
    maxConcurrency: MAX_ENHANCED_HISTORY_CONCURRENCY,
  },
  provenanceAnalysis: {
    routeKey: "provenance-analysis",
    cost: 12,
    concurrencyLabel: "provenance-analysis",
    maxConcurrency: MAX_PROVENANCE_ANALYSIS_CONCURRENCY,
  },
  tokenSnapshot: {
    routeKey: "token-snapshot",
    cost: 6,
    concurrencyLabel: "token-snapshot",
    maxConcurrency: MAX_TOKEN_SNAPSHOT_CONCURRENCY,
  },
  tokenForensics: {
    routeKey: "token-forensics",
    cost: 14,
    concurrencyLabel: "token-forensics",
    maxConcurrency: MAX_TOKEN_FORENSICS_CONCURRENCY,
  },
  stablecoinDashboard: {
    routeKey: "stablecoin-dashboard",
    cost: 6,
    concurrencyLabel: "stablecoin-dashboard",
    maxConcurrency: MAX_STABLECOIN_DASHBOARD_CONCURRENCY,
  },
};

export function getTraceAnalysisPolicy(limitRaw) {
  const limit = Number(limitRaw);
  if (Number.isFinite(limit) && limit > 0 && limit <= 2_000) {
    return {
      ...HEAVY_ROUTE_POLICIES.traceAnalysis,
      cost: 3,
    };
  }
  return HEAVY_ROUTE_POLICIES.traceAnalysis;
}

function pruneUsageStore(store, now = Date.now()) {
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function signSessionId(sessionId) {
  return createHmac("sha256", SESSION_SECRET).update(sessionId).digest("hex");
}

function encodeSessionToken(sessionId) {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function decodeSessionToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [sessionId, signature] = parts;
  const expected = signSessionId(sessionId);
  const signatureBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (signatureBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(signatureBytes, expectedBytes)) return null;
  return sessionId;
}

function parseCookies(headerValue) {
  const result = new Map();
  if (!headerValue) return result;
  for (const pair of headerValue.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result.set(key, value);
  }
  return result;
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, cookieValue]);
    return;
  }
  res.setHeader("set-cookie", [existing, cookieValue]);
}

function sessionCookieValue(sessionId) {
  const token = encodeSessionToken(sessionId);
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureFlag}`;
}

export function ensureAnonymousSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const existing = decodeSessionToken(cookies.get(SESSION_COOKIE_NAME) ?? "");
  if (existing) return existing;

  const sessionId = randomUUID();
  appendSetCookie(res, sessionCookieValue(sessionId));
  return sessionId;
}

export function identifyClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();

  return req.socket.remoteAddress ?? HOST;
}

function consumeUsage(store, key, cost, limit, windowMs, now = Date.now()) {
  pruneUsageStore(store, now);
  const existing = store.get(key);
  const entry = existing && existing.resetAt > now
    ? existing
    : { used: 0, resetAt: now + windowMs };

  if (entry.used + cost > limit) {
    return {
      allowed: false,
      remaining: Math.max(0, limit - entry.used),
      resetAt: entry.resetAt,
    };
  }

  entry.used += cost;
  store.set(key, entry);
  return {
    allowed: true,
    remaining: Math.max(0, limit - entry.used),
    resetAt: entry.resetAt,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpError(statusCode, error, message, details = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.error = error;
  err.details = details;
  return err;
}

export function enforceHeavyRouteBudget(req, res, policy) {
  if (!GUARDS_ENABLED) return;

  const now = Date.now();
  const sessionId = ensureAnonymousSession(req, res);
  const ip = identifyClientIp(req);

  const sessionResult = consumeUsage(
    usageBySession,
    `${policy.routeKey}:${sessionId}`,
    policy.cost,
    SESSION_BUDGET_UNITS,
    SESSION_WINDOW_MS,
    now,
  );
  if (!sessionResult.allowed) {
    throw createHttpError(429, "session_budget_exceeded", "Session heavy-request budget exceeded", {
      retryAfterSec: Math.max(1, Math.ceil((sessionResult.resetAt - now) / 1000)),
      routeKey: policy.routeKey,
    });
  }

  const ipResult = consumeUsage(
    usageByIp,
    `${policy.routeKey}:${ip}`,
    policy.cost,
    IP_BUDGET_UNITS,
    IP_WINDOW_MS,
    now,
  );
  if (!ipResult.allowed) {
    throw createHttpError(429, "ip_budget_exceeded", "IP heavy-request budget exceeded", {
      retryAfterSec: Math.max(1, Math.ceil((ipResult.resetAt - now) / 1000)),
      routeKey: policy.routeKey,
    });
  }
}

export async function withConcurrencyLimit(label, maxConcurrency, task) {
  if (!GUARDS_ENABLED) {
    return task();
  }

  const startedAt = Date.now();
  while ((concurrencyByRoute.get(label) ?? 0) >= maxConcurrency) {
    if (Date.now() - startedAt >= ROUTE_CONCURRENCY_WAIT_MS) {
      throw createHttpError(429, "route_busy", `Too many concurrent ${label} requests`, {
        routeKey: label,
        retryAfterSec: 2,
      });
    }
    await sleep(50);
  }

  concurrencyByRoute.set(label, (concurrencyByRoute.get(label) ?? 0) + 1);
  try {
    return await task();
  } finally {
    const current = concurrencyByRoute.get(label) ?? 1;
    if (current <= 1) concurrencyByRoute.delete(label);
    else concurrencyByRoute.set(label, current - 1);
  }
}

export function getGuardStats() {
  if (!GUARDS_ENABLED) {
    return {
      enabled: false,
      sessionWindows: 0,
      ipWindows: 0,
      concurrency: {},
    };
  }

  pruneUsageStore(usageBySession);
  pruneUsageStore(usageByIp);
  return {
    enabled: true,
    sessionWindows: usageBySession.size,
    ipWindows: usageByIp.size,
    concurrency: Object.fromEntries(concurrencyByRoute),
  };
}

export const guardInternals = {
  consumeUsage,
  decodeSessionToken,
  encodeSessionToken,
  getTraceAnalysisPolicy,
  parseCookies,
};
