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
} from "./config.mjs";

const concurrencyByRoute = new Map();
const waitersByRoute = new Map();

function guardsEnabled() {
  return process.env.NODE_ENV === "production" || process.env.VITEST_FORCE_GUARDS === "1";
}

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

async function acquireConcurrencySlot(label, maxConcurrency) {
  if ((concurrencyByRoute.get(label) ?? 0) < maxConcurrency) {
    concurrencyByRoute.set(label, (concurrencyByRoute.get(label) ?? 0) + 1);
    return;
  }

  await new Promise((resolve) => {
    const queue = waitersByRoute.get(label) ?? [];
    queue.push(resolve);
    waitersByRoute.set(label, queue);
  });
}

function releaseConcurrencySlot(label) {
  const queue = waitersByRoute.get(label);
  if (queue && queue.length > 0) {
    const next = queue.shift();
    if (queue.length === 0) waitersByRoute.delete(label);
    next?.();
    return;
  }

  const current = concurrencyByRoute.get(label) ?? 1;
  if (current <= 1) concurrencyByRoute.delete(label);
  else concurrencyByRoute.set(label, current - 1);
}

export async function withConcurrencyLimit(label, maxConcurrency, task) {
  if (!guardsEnabled()) {
    return task();
  }

  await acquireConcurrencySlot(label, maxConcurrency);
  try {
    return await task();
  } finally {
    releaseConcurrencySlot(label);
  }
}

export function getGuardStats() {
  if (!guardsEnabled()) {
    return {
      enabled: false,
      concurrency: {},
    };
  }

  return {
    enabled: true,
    concurrency: Object.fromEntries(concurrencyByRoute),
    queued: Object.fromEntries(
      Array.from(waitersByRoute.entries())
        .filter(([, queue]) => queue.length > 0)
        .map(([label, queue]) => [label, queue.length]),
    ),
  };
}

export const guardInternals = {
  getTraceAnalysisPolicy,
};
