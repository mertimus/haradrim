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
export const HOST = "0.0.0.0";

export const HELIUS_API_KEY = trimEnv("HELIUS_API_KEY");
export const HELIUS_RPC_URL = buildHeliusRpcUrl();
export const BIRDEYE_API_KEY = trimEnv("BIRDEYE_API_KEY");

export const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 1000);
export const CACHE_MAX_BODY_BYTES = Number(process.env.CACHE_MAX_BODY_BYTES ?? 2_000_000);

export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 15_000);
export const PROXY_TTL_MS = Number(process.env.PROXY_TTL_MS ?? 5 * 60 * 1000);
export const WALLET_ANALYSIS_TTL_MS = Number(process.env.WALLET_ANALYSIS_TTL_MS ?? 5 * 60 * 1000);
export const TRACE_ANALYSIS_TTL_MS = Number(process.env.TRACE_ANALYSIS_TTL_MS ?? 5 * 60 * 1000);

export const GTFA_TOKEN_ACCOUNTS_MODE = "balanceChanged";
export const GTFA_SIGNATURE_PAGE_LIMIT = 1000;
export const TARGET_GTFA_TXS_PER_SLICE = 700;
export const MAX_TRANSACTION_SLICES = 64;
export const MAX_SLICE_CONCURRENCY = Number(process.env.MAX_SLICE_CONCURRENCY ?? 16);
export const MAX_ACCOUNT_TYPE_CONCURRENCY = Number(process.env.MAX_ACCOUNT_TYPE_CONCURRENCY ?? 8);
export const MAX_METADATA_FETCH_CONCURRENCY = Number(process.env.MAX_METADATA_FETCH_CONCURRENCY ?? 4);
export const RATE_LIMIT_RETRIES = Number(process.env.RATE_LIMIT_RETRIES ?? 5);
