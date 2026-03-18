import {
  MAX_BALANCE_HISTORY_CONCURRENCY,
  MAX_BALANCE_HISTORY_LEGACY_CONCURRENCY,
  MAX_GTFA_RPC_CONCURRENCY,
  MAX_ENHANCED_HISTORY_CONCURRENCY,
  MAX_PROVENANCE_ANALYSIS_CONCURRENCY,
  MAX_TOKEN_FORENSICS_CONCURRENCY,
  MAX_TOKEN_SNAPSHOT_CONCURRENCY,
  MAX_TRACE_ANALYSIS_CONCURRENCY,
  MAX_WALLET_ANALYSIS_CONCURRENCY,
  MAX_STABLECOIN_DASHBOARD_CONCURRENCY,
  ROUTE_CONCURRENCY_WAIT_MS,
} from "./config.mjs";

const GUARDS_ENABLED = process.env.NODE_ENV === "production";

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

export function getTraceAnalysisPolicy() {
  return HEAVY_ROUTE_POLICIES.traceAnalysis;
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

export function enforceHeavyRouteBudget() {
  // Rate limiting is handled at the edge via Cloudflare challenge.
  // The backend keeps only concurrency/backpressure protection.
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
      concurrency: {},
    };
  }

  return {
    enabled: true,
    concurrency: Object.fromEntries(concurrencyByRoute),
  };
}

export const guardInternals = {
  getTraceAnalysisPolicy,
};
