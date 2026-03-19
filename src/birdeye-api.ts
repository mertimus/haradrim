import { cached } from "@/lib/cache";
import { BIRDEYE_API_BASE, HELIUS_RPC_URL } from "@/lib/constants";

const BASE = BIRDEYE_API_BASE;
const RPC_URL = HELIUS_RPC_URL;

const TTL_TRENDING = 5 * 60 * 1000;   // 5 min
const TTL_OVERVIEW = 5 * 60 * 1000;   // 5 min
const TTL_HOLDERS = 10 * 60 * 1000;   // 10 min
const SPL_TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

const HEADERS: HeadersInit = {
  "x-chain": "solana",
};

// ---- Types ----

export interface TrendingToken {
  address: string;
  name: string;
  symbol: string;
  logoURI: string;
  volume24hUSD: number;
  liquidity: number;
  rank: number;
}

export interface TokenOverview {
  address: string;
  name: string;
  symbol: string;
  image: string;
  marketCap: number;
  holder: number;
  price: number;
  supply: number;
  decimals: number;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
  priceChange1h: number;
}

export interface TokenHolder {
  owner: string;
  uiAmount: number;
  percentage: number;
  label?: string;
  ownerAccountType?: "wallet" | "program" | "token" | "other" | "unknown";
  ownerProgram?: string;
  ownerProgramLabel?: string;
  identityCategory?: string;
}

interface RpcTokenAccountInfo {
  owner?: string;
  tokenAmount?: {
    uiAmount?: number | null;
    uiAmountString?: string;
  };
}

interface RpcTokenAccount {
  account?: {
    data?: {
      parsed?: {
        info?: RpcTokenAccountInfo;
      };
    };
  };
}

// ---- Solana RPC: get token supply ----

async function getBirdeyeSupply(mint: string): Promise<number> {
  try {
    const res = await fetch(`${BASE}/defi/token_overview?address=${mint}`, {
      headers: HEADERS,
    });
    if (!res.ok) return 0;
    const json = await res.json();
    return Number(json.data?.supply ?? 0);
  } catch {
    return 0;
  }
}

async function getTokenSupply(mint: string): Promise<number> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenSupply",
        params: [mint],
      }),
    });
    if (!res.ok) return getBirdeyeSupply(mint);
    const json = await res.json();
    const supply = json.result?.value?.uiAmount ?? 0;
    return supply > 0 ? supply : getBirdeyeSupply(mint);
  } catch {
    return getBirdeyeSupply(mint);
  }
}

async function getProgramTokenAccounts(
  mint: string,
  programId: string,
): Promise<RpcTokenAccount[]> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        programId,
        {
          encoding: "jsonParsed",
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: mint } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Unable to fetch token accounts for program ${programId}.`);
  }

  const json = await res.json();
  return Array.isArray(json.result) ? json.result : [];
}

// ---- API Functions ----

async function _getTrendingTokens(): Promise<TrendingToken[]> {
  const res = await fetch(
    `${BASE}/defi/token_trending?sort_by=rank&limit=10`,
    { headers: HEADERS },
  );
  if (!res.ok) return [];
  const json = await res.json();
  const items = json.data?.tokens ?? json.data?.items ?? [];
  return items.map((t: Record<string, unknown>) => ({
    address: t.address ?? "",
    name: t.name ?? "",
    symbol: t.symbol ?? "",
    logoURI: t.logoURI ?? t.logo_uri ?? t.image ?? "",
    volume24hUSD: Number(t.volume24hUSD ?? t.v24hUSD ?? 0),
    liquidity: Number(t.liquidity ?? 0),
    rank: Number(t.rank ?? 0),
  }));
}

export function getTrendingTokens(): Promise<TrendingToken[]> {
  return cached("beTrending", "all", TTL_TRENDING, _getTrendingTokens);
}

export interface TokenSearchResult {
  address: string;
  name: string;
  symbol: string;
  logoURI: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume24h: number;
}

export async function searchTokens(query: string): Promise<TokenSearchResult[]> {
  if (!query || query.length < 2) return [];

  function parseResults(items: Record<string, unknown>[]): TokenSearchResult[] {
    return items.map((t) => ({
      address: String(t.address ?? ""),
      name: String(t.name ?? ""),
      symbol: String(t.symbol ?? ""),
      logoURI: String(t.logoURI ?? t.logo_uri ?? t.image ?? ""),
      price: Number(t.price ?? 0),
      marketCap: Number(t.market_cap ?? t.mc ?? t.fdv ?? 0),
      liquidity: Number(t.liquidity ?? 0),
      volume24h: Number(t.volume_24h_usd ?? t.v24hUSD ?? 0),
    })).filter((t) => t.address && t.symbol);
  }

  // v3/search
  try {
    const url = `${BASE}/defi/v3/search?chain=solana&keyword=${encodeURIComponent(query)}&target=token&sort_by=volume_24h_usd&sort_type=desc&limit=8`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const json = await res.json();
    // v3/search nests tokens: { data: { items: [ { type: "token", result: [...] } ] } }
    const groups: Record<string, unknown>[] = json.data?.items ?? [];
    const tokenGroup = groups.find((g) => g.type === "token");
    const tokens: Record<string, unknown>[] = (tokenGroup?.result as Record<string, unknown>[]) ?? [];
    return parseResults(tokens);
  } catch {
    return [];
  }
}

async function _getTokenOverview(
  address: string,
): Promise<TokenOverview | null> {
  // Fetch Birdeye overview + RPC supply in parallel
  const [birdeyeRes, rpcSupply] = await Promise.all([
    fetch(`${BASE}/defi/token_overview?address=${address}`, {
      headers: HEADERS,
    }),
    getTokenSupply(address),
  ]);

  if (!birdeyeRes.ok) return null;
  const json = await birdeyeRes.json();
  const d = json.data;
  if (!d) return null;

  // Use RPC supply (always decimal-adjusted), fall back to Birdeye if available
  const supply = rpcSupply > 0 ? rpcSupply : Number(d.supply ?? 0);
  const price = Number(d.price ?? 0);
  const marketCapRaw = d.mc ?? d.marketCap ?? d.marketcap;
  const marketCap = Number(marketCapRaw != null ? marketCapRaw : price * supply);

  return {
    address: d.address ?? address,
    name: d.name ?? "",
    symbol: d.symbol ?? "",
    image: d.logoURI ?? d.logo_uri ?? d.image ?? "",
    marketCap: Number.isFinite(marketCap) ? marketCap : 0,
    holder: Number(d.holder ?? 0),
    price,
    supply,
    liquidity: Number(d.liquidity ?? d.realMc ?? 0),
    volume24h: Number(d.v24hUSD ?? d.volume24h ?? 0),
    priceChange24h: Number(d.priceChange24hPercent ?? d.price24hChangePercent ?? 0),
    priceChange1h: Number(d.priceChange1hPercent ?? d.price1hChangePercent ?? 0),
    decimals: Number(d.decimals ?? 0),
  };
}

export function getTokenOverview(
  address: string,
): Promise<TokenOverview | null> {
  // Changed namespace to invalidate stale cache from previous broken versions
  return cached("beOv2", address, TTL_OVERVIEW, () =>
    _getTokenOverview(address),
  );
}

async function _getTokenHolders(
  address: string,
  limit?: number,
): Promise<TokenHolder[]> {
  const supply = await getTokenSupply(address);
  if (supply <= 0) {
    throw new Error("Unable to fetch token supply.");
  }

  const ownerTotals = new Map<string, number>();
  const tokenAccountsByProgram = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      getProgramTokenAccounts(address, programId),
    ),
  );

  let foundPositiveBalance = false;
  for (const tokenAccounts of tokenAccountsByProgram) {
    for (const tokenAccount of tokenAccounts) {
      const info = tokenAccount.account?.data?.parsed?.info;
      const owner = info?.owner ?? "";
      if (!owner) continue;

      const amountRaw =
        info?.tokenAmount?.uiAmount
        ?? Number(info?.tokenAmount?.uiAmountString ?? 0);
      const uiAmount = Number(amountRaw);
      if (!Number.isFinite(uiAmount) || uiAmount <= 0) continue;

      foundPositiveBalance = true;
      ownerTotals.set(owner, (ownerTotals.get(owner) ?? 0) + uiAmount);
    }
  }

  if (!foundPositiveBalance) {
    throw new Error("No holder data returned for token.");
  }

  const holders = Array.from(ownerTotals.entries())
    .map(([owner, uiAmount]) => ({
      owner,
      uiAmount,
      percentage: (uiAmount / supply) * 100,
    }))
    .sort((a, b) => b.uiAmount - a.uiAmount)
    .slice(0, limit ?? Number.POSITIVE_INFINITY);

  return holders;
}

export function getTokenHolders(
  address: string,
  limit?: number,
): Promise<TokenHolder[]> {
  return cached("rpcHoldersV1", `${address}:${limit ?? "all"}`, TTL_HOLDERS, () =>
    _getTokenHolders(address, limit),
  );
}
