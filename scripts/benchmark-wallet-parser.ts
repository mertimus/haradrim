/**
 * Compare the legacy wallet-page parser heuristic against the current
 * instruction-based parser on a live wallet fetch.
 *
 * Usage:
 *   npx tsx scripts/benchmark-wallet-parser.ts [walletAddress]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTransactions } from "../src/lib/parse-transactions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadApiKey(): string {
  const root = path.resolve(__dirname, "..");
  for (const f of [".env.local", ".env"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^VITE_HELIUS_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
  }
  throw new Error("VITE_HELIUS_API_KEY not found");
}

const API_KEY = loadApiKey();
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const ADDRESS = process.argv[2] || "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const GTFA_TOKEN_ACCOUNTS_MODE = "balanceChanged";
const GTFA_SIGNATURE_PAGE_LIMIT = 1000;
const TARGET_GTFA_TXS_PER_SLICE = 700;
const MAX_TRANSACTION_SLICES = 64;
const MAX_SIGNATURE_SLICE_CONCURRENCY = 32;

interface RpcParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
}

interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      instructions?: RpcParsedInstruction[];
      accountKeys: (
        | string
        | { pubkey: string; signer: boolean; writable: boolean }
      )[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: {
        uiAmount: number | null;
      };
    }[];
    postTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: {
        uiAmount: number | null;
      };
    }[];
  } | null;
}

function resolveKey(
  key: string | { pubkey: string; signer: boolean; writable: boolean },
): string {
  return typeof key === "string" ? key : key.pubkey;
}

function blockTimeBounds(
  records: Array<{ blockTime: number | null }>,
): { min: number; max: number } | null {
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

function optimalSliceCount(estimatedTxCount: number, totalSpanSecs: number): number {
  if (totalSpanSecs < 86400 * 7) return 1;
  if (estimatedTxCount <= GTFA_SIGNATURE_PAGE_LIMIT) return 1;
  return Math.max(
    2,
    Math.min(Math.ceil(estimatedTxCount / TARGET_GTFA_TXS_PER_SLICE), MAX_TRANSACTION_SLICES),
  );
}

function createUniformSlices(
  firstTs: number,
  nowTs: number,
  count: number,
): { gte: number; lt: number }[] {
  const span = nowTs - firstTs;
  if (span <= 0 || count <= 0) return [{ gte: firstTs, lt: nowTs }];
  const sliceSize = Math.ceil(span / count);
  const slices: { gte: number; lt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const gte = firstTs + i * sliceSize;
    const lt = Math.min(firstTs + (i + 1) * sliceSize, nowTs);
    if (gte < lt) slices.push({ gte, lt });
  }
  return slices;
}

async function fetchWithRetry(body: unknown): Promise<{ result: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok && !json.error) return json;
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    throw new Error(JSON.stringify(json.error ?? { status: res.status }));
  }
  throw new Error("retry budget exceeded");
}

async function probeTimeline(address: string): Promise<{ firstBlockTime: number; estimatedTxCount: number }> {
  const [oldestPage, recentPage] = await Promise.all([
    fetchWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder: "asc",
        limit: 1,
        commitment: "confirmed",
        filters: { tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
      }],
    }),
    fetchWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder: "desc",
        limit: GTFA_SIGNATURE_PAGE_LIMIT,
        commitment: "confirmed",
        filters: { tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
      }],
    }),
  ]);

  const firstBlockTime = (oldestPage.result.data as Array<{ blockTime?: number | null }>)[0]?.blockTime;
  if (firstBlockTime == null) throw new Error("wallet has no history");

  const recentTxs = (recentPage.result.data as Array<{ blockTime: number | null }>) ?? [];
  if (!(recentPage.result.paginationToken)) {
    return { firstBlockTime, estimatedTxCount: recentTxs.length };
  }

  const bounds = blockTimeBounds(recentTxs);
  if (!bounds) return { firstBlockTime, estimatedTxCount: recentTxs.length };

  const sampleCoveredSpan = Math.max(bounds.max - bounds.min, 1);
  const totalSpan = Math.max(bounds.max - firstBlockTime, 1);
  const estimate = Math.ceil(recentTxs.length * (totalSpan / sampleCoveredSpan));
  return { firstBlockTime, estimatedTxCount: Math.max(estimate, recentTxs.length) };
}

async function fetchSlice(address: string, gte: number, lt: number): Promise<RpcTransaction[]> {
  const all: RpcTransaction[] = [];
  let token: string | undefined;
  const requestLt = lt - gte <= 1 ? lt + 1 : lt;
  const seenTokens = new Set<string>();

  for (let i = 0; i < 200; i++) {
    const json = await fetchWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        sortOrder: "asc",
        limit: 1000,
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        filters: { blockTime: { gte, lt: requestLt }, tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

    const txs = (json.result.data as RpcTransaction[]) ?? [];
    all.push(...txs);
    const nextToken = json.result.paginationToken as string | undefined;
    if (!nextToken) break;
    if (seenTokens.has(nextToken)) throw new Error(`repeated pagination token for slice [${gte}, ${lt})`);
    seenTokens.add(nextToken);
    token = nextToken;
  }

  return all;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

function legacyParseTransactions(txs: RpcTransaction[], walletAddress: string) {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const counterpartyMap = new Map<string, {
    txCount: number;
    solSent: number;
    solReceived: number;
    firstSeen: number;
    lastSeen: number;
  }>();

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const timestamp = tx.blockTime ?? 0;
    const accountKeys = tx.transaction.message.accountKeys.map(resolveKey);
    const walletIndex = accountKeys.indexOf(walletAddress);

    let walletSolChange = 0;
    if (walletIndex >= 0) {
      const pre = tx.meta.preBalances[walletIndex] ?? 0;
      const post = tx.meta.postBalances[walletIndex] ?? 0;
      walletSolChange = (post - pre) / LAMPORTS_PER_SOL;
    }

    const txCounterparties: string[] = [];
    const txCpSet = new Set<string>();
    for (let i = 0; i < accountKeys.length; i++) {
      const addr = accountKeys[i];
      if (addr === walletAddress) continue;

      if (!txCpSet.has(addr)) {
        txCpSet.add(addr);
        txCounterparties.push(addr);
      }

      const entry = counterpartyMap.get(addr) ?? {
        txCount: 0,
        solSent: 0,
        solReceived: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
      };

      const pre = tx.meta.preBalances[i] ?? 0;
      const post = tx.meta.postBalances[i] ?? 0;
      const diff = post - pre;
      if (diff !== 0) {
        const solAmount = Math.abs(diff) / LAMPORTS_PER_SOL;
        if (walletSolChange < 0 && diff > 0) entry.solSent += solAmount;
        else if (walletSolChange > 0 && diff < 0) entry.solReceived += solAmount;
      }

      entry.firstSeen = Math.min(entry.firstSeen, timestamp);
      entry.lastSeen = Math.max(entry.lastSeen, timestamp);
      counterpartyMap.set(addr, entry);
    }

    const tokenOwners = new Set<string>();
    for (const tb of tx.meta.preTokenBalances ?? []) {
      if (tb.owner && tb.owner !== walletAddress) tokenOwners.add(tb.owner);
    }
    for (const tb of tx.meta.postTokenBalances ?? []) {
      if (tb.owner && tb.owner !== walletAddress) tokenOwners.add(tb.owner);
    }
    for (const owner of tokenOwners) {
      if (!txCpSet.has(owner)) {
        txCpSet.add(owner);
        txCounterparties.push(owner);
        if (!counterpartyMap.has(owner)) {
          counterpartyMap.set(owner, {
            txCount: 0,
            solSent: 0,
            solReceived: 0,
            firstSeen: timestamp,
            lastSeen: timestamp,
          });
        }
      }
    }

    for (const cp of txCounterparties) {
      const entry = counterpartyMap.get(cp);
      if (entry) entry.txCount += 1;
    }
  }

  return [...counterpartyMap.entries()]
    .map(([address, data]) => ({
      address,
      txCount: data.txCount,
      solSent: data.solSent,
      solReceived: data.solReceived,
      solNet: data.solReceived - data.solSent,
    }))
    .sort((a, b) => b.txCount - a.txCount);
}

function summarize(label: string, counterparties: Array<{
  address: string;
  txCount: number;
  solSent: number;
  solReceived: number;
  solNet: number;
}>) {
  const top = counterparties.slice(0, 10).map((cp) => ({
    address: cp.address,
    txCount: cp.txCount,
    volume: Number((cp.solSent + cp.solReceived).toFixed(4)),
    net: Number(cp.solNet.toFixed(4)),
  }));
  return {
    label,
    counterparties: counterparties.length,
    tokenOrProgramLooking: counterparties.filter((cp) => cp.address.length !== 44).length,
    zeroVolume: counterparties.filter((cp) => cp.solSent + cp.solReceived === 0).length,
    top,
  };
}

async function main() {
  console.log(`Address: ${ADDRESS}`);
  const probe = await probeTimeline(ADDRESS);
  const now = Math.floor(Date.now() / 1000) + 60;
  const totalSpan = now - probe.firstBlockTime;
  const sliceCount = optimalSliceCount(probe.estimatedTxCount, totalSpan);
  const slices = createUniformSlices(probe.firstBlockTime, now, sliceCount);
  console.log(`Probe: first=${probe.firstBlockTime} est=${probe.estimatedTxCount} slices=${sliceCount}`);

  const fetchStart = performance.now();
  const txs = (await mapWithConcurrency(
    slices,
    MAX_SIGNATURE_SLICE_CONCURRENCY,
    (slice) => fetchSlice(ADDRESS, slice.gte, slice.lt),
  )).flat();
  const fetchMs = performance.now() - fetchStart;
  console.log(`Fetched ${txs.length.toLocaleString()} tx rows in ${fetchMs.toFixed(0)} ms`);

  const legacyStart = performance.now();
  const legacy = legacyParseTransactions(txs, ADDRESS);
  const legacyMs = performance.now() - legacyStart;

  const currentStart = performance.now();
  const current = parseTransactions(txs, ADDRESS);
  const currentMs = performance.now() - currentStart;

  console.log(JSON.stringify({
    fetchMs: Math.round(fetchMs),
    legacyParseMs: Math.round(legacyMs),
    currentParseMs: Math.round(currentMs),
    legacy: summarize("legacy", legacy),
    current: summarize("current", current.counterparties),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
