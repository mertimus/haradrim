const DEFAULT_RPC = "https://mainnet.helius-rpc.com/";
export const HELIUS_API_ORIGIN = "https://api.helius.xyz";

function trimEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") return "";
  return value.trim();
}

function buildHeliusRpcUrl() {
  const direct = trimEnv("HELIUS_RPC_URL");
  if (direct) return direct;

  const apiKey = trimEnv("HELIUS_API_KEY");
  if (!apiKey) return DEFAULT_RPC;

  const url = new URL(DEFAULT_RPC);
  url.searchParams.set("api-key", apiKey);
  return url.toString();
}

export const PORT = Number(process.env.PORT ?? 8080);
export const HOST = trimEnv("HOST") || "0.0.0.0";

export const HELIUS_API_KEY = trimEnv("HELIUS_API_KEY");
export const HELIUS_RPC_URL = buildHeliusRpcUrl();
export const HELIUS_ENHANCED_API_ORIGIN = trimEnv("HELIUS_ENHANCED_API_ORIGIN") || "https://api-mainnet.helius-rpc.com";
export const BIRDEYE_API_KEY = trimEnv("BIRDEYE_API_KEY");

export const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 10_000);
export const CACHE_MAX_METADATA_ENTRIES = Number(process.env.CACHE_MAX_METADATA_ENTRIES ?? 25_000);
export const CACHE_MAX_PROXY_ENTRIES = Number(process.env.CACHE_MAX_PROXY_ENTRIES ?? 2_000);
export const CACHE_MAX_BODY_BYTES = Number(process.env.CACHE_MAX_BODY_BYTES ?? 2_000_000);
export const REQUEST_BODY_LIMIT_BYTES = Number(process.env.REQUEST_BODY_LIMIT_BYTES ?? 32_000);
export const JSON_PROXY_BODY_LIMIT_BYTES = Number(process.env.JSON_PROXY_BODY_LIMIT_BYTES ?? 64_000);

export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 15_000);
export const ROUTE_CONCURRENCY_WAIT_MS = Number(process.env.ROUTE_CONCURRENCY_WAIT_MS ?? 20_000);
export const PROXY_TTL_MS = Number(process.env.PROXY_TTL_MS ?? 5 * 60 * 1000);
export const WALLET_ANALYSIS_TTL_MS = Number(process.env.WALLET_ANALYSIS_TTL_MS ?? 5 * 60 * 1000);
export const TRACE_ANALYSIS_TTL_MS = Number(process.env.TRACE_ANALYSIS_TTL_MS ?? 60 * 60 * 1000);
export const TRACE_ENRICH_WAIT_MS = Number(process.env.TRACE_ENRICH_WAIT_MS ?? 1000);
export const BALANCE_HISTORY_TTL_MS = Number(process.env.BALANCE_HISTORY_TTL_MS ?? 5 * 60 * 1000);
export const ENHANCED_HISTORY_TTL_MS = Number(process.env.ENHANCED_HISTORY_TTL_MS ?? 10 * 60 * 1000);
export const PROVENANCE_ANALYSIS_TTL_MS = Number(
  process.env.PROVENANCE_ANALYSIS_TTL_MS ?? 10 * 60 * 1000,
);
export const TOKEN_SNAPSHOT_TTL_MS = Number(
  process.env.TOKEN_SNAPSHOT_TTL_MS ?? 10 * 60 * 1000,
);
export const TOKEN_FORENSICS_TTL_MS = Number(
  process.env.TOKEN_FORENSICS_TTL_MS ?? 15 * 60 * 1000,
);

export const GTFA_TOKEN_ACCOUNTS_MODE = "balanceChanged";
export const GTFA_SIGNATURE_PAGE_LIMIT = 1000;
export const GTFA_FULL_PAGE_LIMIT = Number(process.env.GTFA_FULL_PAGE_LIMIT ?? 1000);
export const TARGET_GTFA_TXS_PER_SLICE = 700;
export const MAX_TRANSACTION_SLICES = 64;
export const MAX_SLICE_CONCURRENCY = Number(process.env.MAX_SLICE_CONCURRENCY ?? 16);
export const MAX_ACCOUNT_TYPE_CONCURRENCY = Number(process.env.MAX_ACCOUNT_TYPE_CONCURRENCY ?? 8);
export const MAX_METADATA_FETCH_CONCURRENCY = Number(process.env.MAX_METADATA_FETCH_CONCURRENCY ?? 8);
export const RATE_LIMIT_RETRIES = Number(process.env.RATE_LIMIT_RETRIES ?? 5);
export const MAX_UPSTREAM_FETCH_CONCURRENCY = Number(process.env.MAX_UPSTREAM_FETCH_CONCURRENCY ?? 24);
export const MAX_WALLET_ANALYSIS_CONCURRENCY = Number(process.env.MAX_WALLET_ANALYSIS_CONCURRENCY ?? 2);
export const MAX_TRACE_ANALYSIS_CONCURRENCY = Number(process.env.MAX_TRACE_ANALYSIS_CONCURRENCY ?? 6);
export const MAX_BALANCE_HISTORY_CONCURRENCY = Number(process.env.MAX_BALANCE_HISTORY_CONCURRENCY ?? 2);
export const MAX_BALANCE_HISTORY_LEGACY_CONCURRENCY = Number(
  process.env.MAX_BALANCE_HISTORY_LEGACY_CONCURRENCY ?? 1,
);
export const MAX_BALANCE_HISTORY_LEGACY_RPC_CONCURRENCY = Number(
  process.env.MAX_BALANCE_HISTORY_LEGACY_RPC_CONCURRENCY ?? 32,
);
export const MAX_GTFA_RPC_CONCURRENCY = Number(process.env.MAX_GTFA_RPC_CONCURRENCY ?? 2);
export const MAX_ENHANCED_HISTORY_CONCURRENCY = Number(process.env.MAX_ENHANCED_HISTORY_CONCURRENCY ?? 1);
export const MAX_PROVENANCE_ANALYSIS_CONCURRENCY = Number(
  process.env.MAX_PROVENANCE_ANALYSIS_CONCURRENCY ?? 1,
);
export const MAX_TOKEN_SNAPSHOT_CONCURRENCY = Number(
  process.env.MAX_TOKEN_SNAPSHOT_CONCURRENCY ?? 2,
);
export const MAX_TOKEN_FORENSICS_CONCURRENCY = Number(
  process.env.MAX_TOKEN_FORENSICS_CONCURRENCY ?? 1,
);
export const DIALECT_API_KEY = trimEnv("DIALECT_API_KEY");
export const DIALECT_API_BASE = trimEnv("DIALECT_API_BASE") || "https://markets.dial.to/api";

export const STABLECOIN_DASHBOARD_TTL_MS = Number(
  process.env.STABLECOIN_DASHBOARD_TTL_MS ?? 5 * 60 * 1000,
);
export const MAX_STABLECOIN_DASHBOARD_CONCURRENCY = Number(
  process.env.MAX_STABLECOIN_DASHBOARD_CONCURRENCY ?? 1,
);
