/**
 * Benchmark: Transaction Fetching Strategies — Scaling Test
 *
 * Tests multiple slicing strategies across wallets of different sizes.
 * Reports latencies, API call counts, and per-slice page distributions.
 *
 * Usage:  npx tsx scripts/benchmark-fetch.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WALLETS = [
  { address: "8cRrU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y", label: "Medium (~5k txns)" },
  { address: "HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY", label: "Heavy (~90k txns)" },
];

const PAUSE_BETWEEN_MS = 3_000;

// For the heavy wallet, only fetch first N pages per slice to avoid
// burning thousands of credits. Set to 0 for unlimited.
const MAX_PAGES_PER_SLICE = 200;

// Load API key
function loadApiKey(): string {
  const root = path.resolve(__dirname, "..");
  for (const f of [".env.local", ".env"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^VITE_HELIUS_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
  }
  throw new Error("VITE_HELIUS_API_KEY not found");
}

const API_KEY = loadApiKey();
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (string | { pubkey: string })[] };
  };
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[] } | null;
}

interface SliceStats {
  gte: number;
  lt: number;
  pages: number;
  txCount: number;
}

interface BenchmarkResult {
  name: string;
  totalMs: number;
  probeMs: number;
  fetchMs: number;
  apiCalls: number;
  txCount: number;
  sliceCount: number;
  sliceStats: SliceStats[];
  estimatedTxCount?: number;
}

// ---------------------------------------------------------------------------
// Instrumented RPC
// ---------------------------------------------------------------------------

let apiCallCount = 0;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  apiCallCount++;
  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err: any) {
    console.error(`  [rpcCall] fetch threw: ${err.message} | cause: ${err.cause?.message ?? err.cause ?? "none"} | code: ${err.cause?.code ?? "none"}`);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`  [rpcCall] HTTP ${res.status} ${res.statusText} | body: ${body.slice(0, 300)}`);
    throw new Error(`RPC HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Core fetchers
// ---------------------------------------------------------------------------

async function gtfaPageFull(
  address: string,
  opts: { sortOrder?: string; paginationToken?: string; blockTimeGte?: number; blockTimeLt?: number } = {},
): Promise<{ txs: RpcTransaction[]; nextToken: string | null }> {
  const params: Record<string, unknown> = {
    transactionDetails: "full", sortOrder: opts.sortOrder ?? "asc",
    limit: 100, commitment: "confirmed", encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
  };
  const filters: Record<string, unknown> = {};
  if (opts.blockTimeGte != null || opts.blockTimeLt != null) {
    const bt: Record<string, number> = {};
    if (opts.blockTimeGte != null) bt.gte = opts.blockTimeGte;
    if (opts.blockTimeLt != null) bt.lt = opts.blockTimeLt;
    filters.blockTime = bt;
  }
  if (Object.keys(filters).length > 0) params.filters = filters;
  if (opts.paginationToken) params.paginationToken = opts.paginationToken;

  const json = await rpcCall("getTransactionsForAddress", [address, params]);
  if (json.error) return { txs: [], nextToken: null };
  const result = json.result ?? {};
  return { txs: result.data ?? [], nextToken: result.paginationToken ?? null };
}

async function fetchSlice(
  address: string, gte: number, lt: number, maxPages = MAX_PAGES_PER_SLICE,
): Promise<{ txs: RpcTransaction[]; pages: number }> {
  const all: RpcTransaction[] = [];
  let token: string | undefined;
  let pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const { txs, nextToken } = await gtfaPageFull(address, {
      sortOrder: "asc", blockTimeGte: gte, blockTimeLt: lt, paginationToken: token,
    });
    pages++;
    all.push(...txs);
    if (!nextToken) break;
    token = nextToken;
  }
  return { txs: all, pages };
}

function deduplicateTxs(txs: RpcTransaction[]): RpcTransaction[] {
  const seen = new Set<string>();
  const unique: RpcTransaction[] = [];
  for (const tx of txs) {
    const sig = tx.transaction.signatures[0];
    if (!seen.has(sig)) { seen.add(sig); unique.push(tx); }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Slicing strategies
// ---------------------------------------------------------------------------

function createUniformSlices(firstTs: number, nowTs: number, count: number): { gte: number; lt: number }[] {
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

function createPowerLawSlices(
  firstTs: number, nowTs: number, count: number, alpha = 1.5,
): { gte: number; lt: number }[] {
  const span = nowTs - firstTs;
  if (span <= 0) return [{ gte: firstTs, lt: nowTs }];
  const boundaries: number[] = [];
  for (let i = 0; i <= count; i++) {
    const t = 1 - Math.pow((count - i) / count, alpha);
    boundaries.push(Math.floor(firstTs + span * t));
  }
  const slices: { gte: number; lt: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i] < boundaries[i + 1]) slices.push({ gte: boundaries[i], lt: boundaries[i + 1] });
  }
  return slices;
}

function optimalSliceCount(estimatedTxCount: number, totalSpanSecs: number): number {
  if (totalSpanSecs < 86400 * 7) return 1;
  if (estimatedTxCount <= 200) return 1;
  return Math.max(2, Math.min(Math.ceil(estimatedTxCount / 400), 24));
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeOldStyle(address: string): Promise<{ firstBlockTime: number; probeMs: number }> {
  const t0 = performance.now();
  const json = await rpcCall("getTransactionsForAddress", [address, {
    transactionDetails: "full", sortOrder: "asc", limit: 100,
    commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
  }]);
  const probeMs = performance.now() - t0;
  const data = json.result?.data;
  if (!data || data.length === 0) throw new Error("Probe returned no data");
  return { firstBlockTime: data[0].blockTime, probeMs };
}

async function probeDynamic(address: string): Promise<{
  firstBlockTime: number; estimatedTxCount: number; probeMs: number;
}> {
  const t0 = performance.now();
  const json = await rpcCall("getTransactionsForAddress", [address, {
    transactionDetails: "signatures", sortOrder: "asc", limit: 1000, commitment: "confirmed",
  }]);
  const probeMs = performance.now() - t0;
  const data = json.result?.data;
  if (!data || data.length === 0) throw new Error("Probe returned no data");

  const firstBlockTime = data[0].blockTime;
  const hasMore = !!json.result?.paginationToken;
  if (!hasMore) return { firstBlockTime, estimatedTxCount: data.length, probeMs };

  const now = Math.floor(Date.now() / 1000);
  const lastInProbe = data[data.length - 1].blockTime ?? now;
  const probeCoveredSpan = Math.max(lastInProbe - firstBlockTime, 1);
  const totalSpan = Math.max(now - firstBlockTime, 1);
  const estimate = Math.ceil(1000 * (totalSpan / probeCoveredSpan));
  return { firstBlockTime, estimatedTxCount: estimate, probeMs };
}

// ---------------------------------------------------------------------------
// Generic approach runner
// ---------------------------------------------------------------------------

async function runApproach(
  address: string,
  name: string,
  config: {
    probeType: "old" | "dynamic";
    slicingFn: (firstTs: number, nowTs: number, estCount: number) => { gte: number; lt: number }[];
  },
): Promise<BenchmarkResult> {
  apiCallCount = 0;
  const t0 = performance.now();

  let firstBlockTime: number;
  let probeMs: number;
  let estimatedTxCount: number | undefined;

  if (config.probeType === "old") {
    const p = await probeOldStyle(address);
    firstBlockTime = p.firstBlockTime;
    probeMs = p.probeMs;
  } else {
    const p = await probeDynamic(address);
    firstBlockTime = p.firstBlockTime;
    probeMs = p.probeMs;
    estimatedTxCount = p.estimatedTxCount;
  }

  const now = Math.floor(Date.now() / 1000) + 60;
  const slices = config.slicingFn(firstBlockTime, now, estimatedTxCount ?? 0);

  const fetchT0 = performance.now();
  const sliceResults = await Promise.all(
    slices.map((s) => fetchSlice(address, s.gte, s.lt)),
  );
  const fetchMs = performance.now() - fetchT0;

  const allTxs = deduplicateTxs(sliceResults.flatMap((r) => r.txs));
  const totalMs = performance.now() - t0;

  const sliceStats: SliceStats[] = sliceResults.map((r, i) => ({
    gte: slices[i].gte, lt: slices[i].lt, pages: r.pages, txCount: r.txs.length,
  }));

  return { name, totalMs, probeMs, fetchMs, apiCalls: apiCallCount,
    txCount: allTxs.length, sliceCount: slices.length, sliceStats, estimatedTxCount };
}

// ---------------------------------------------------------------------------
// Approach definitions
// ---------------------------------------------------------------------------

const APPROACHES = [
  {
    name: "A: Uniform 8 + old probe",
    probeType: "old" as const,
    slicingFn: (firstTs: number, nowTs: number) =>
      createUniformSlices(firstTs, nowTs, 8),
  },
  {
    name: "B: Power-law 8 + dynamic probe",
    probeType: "dynamic" as const,
    slicingFn: (firstTs: number, nowTs: number) =>
      createPowerLawSlices(firstTs, nowTs, 8),
  },
  {
    name: "C: Dynamic count + power-law (cap 24)",
    probeType: "dynamic" as const,
    slicingFn: (firstTs: number, nowTs: number, estCount: number) => {
      const n = optimalSliceCount(estCount, nowTs - firstTs);
      return n === 1 ? [{ gte: firstTs, lt: nowTs }] : createPowerLawSlices(firstTs, nowTs, n);
    },
  },
  {
    name: "D: Dynamic count + power-law (cap 48)",
    probeType: "dynamic" as const,
    slicingFn: (firstTs: number, nowTs: number, estCount: number) => {
      const totalSpan = nowTs - firstTs;
      if (totalSpan < 86400 * 7 || estCount <= 200) return [{ gte: firstTs, lt: nowTs }];
      const n = Math.max(2, Math.min(Math.ceil(estCount / 400), 48));
      return createPowerLawSlices(firstTs, nowTs, n);
    },
  },
  {
    name: "E: Dynamic count + uniform (cap 24)",
    probeType: "dynamic" as const,
    slicingFn: (firstTs: number, nowTs: number, estCount: number) => {
      const n = optimalSliceCount(estCount, nowTs - firstTs);
      return createUniformSlices(firstTs, nowTs, n);
    },
  },
];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function printResults(walletLabel: string, results: BenchmarkResult[]) {
  console.log("\n" + "=".repeat(100));
  console.log(`  ${walletLabel}`);
  console.log("=".repeat(100));

  const hdr = [
    "Approach".padEnd(44),
    "Total".padStart(9),
    "Probe".padStart(8),
    "Fetch".padStart(9),
    "Calls".padStart(6),
    "TXs".padStart(7),
    "Slices".padStart(6),
    "MaxPg".padStart(6),
  ].join(" | ");

  console.log();
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const maxPages = Math.max(...r.sliceStats.map((x) => x.pages));
    console.log([
      r.name.padEnd(44),
      formatMs(r.totalMs).padStart(9),
      formatMs(r.probeMs).padStart(8),
      formatMs(r.fetchMs).padStart(9),
      String(r.apiCalls).padStart(6),
      String(r.txCount).padStart(7),
      String(r.sliceCount).padStart(6),
      String(maxPages).padStart(6),
    ].join(" | "));
  }

  // Per-slice breakdown for each approach
  for (const r of results) {
    console.log();
    console.log(`  --- ${r.name} ---`);
    if (r.estimatedTxCount != null) {
      console.log(`  Estimated tx count: ${r.estimatedTxCount}`);
    }
    const totalPages = r.sliceStats.reduce((s, x) => s + x.pages, 0);
    const maxPages = Math.max(...r.sliceStats.map((x) => x.pages));
    const maxTxSlice = Math.max(...r.sliceStats.map((x) => x.txCount));

    // Compact: show distribution summary instead of every slice
    if (r.sliceStats.length > 12) {
      const pageCounts = r.sliceStats.map((s) => s.pages);
      const txCounts = r.sliceStats.map((s) => s.txCount);
      console.log(`  Slices: ${r.sliceCount} | Pages: [${pageCounts.join(", ")}]`);
      console.log(`  TXs:   [${txCounts.join(", ")}]`);
    } else {
      for (let i = 0; i < r.sliceStats.length; i++) {
        const s = r.sliceStats[i];
        const spanDays = ((s.lt - s.gte) / 86400).toFixed(1);
        console.log(`  Slice ${String(i).padStart(2)}: ${String(s.pages).padStart(3)} pages, ${String(s.txCount).padStart(5)} txs, ${spanDays.padStart(7)}d span`);
      }
    }
    console.log(`  Total pages: ${totalPages} | Max pages/slice: ${maxPages} | Max txs/slice: ${maxTxSlice}`);
  }

  // Speedup comparison
  console.log();
  const baseline = results[0];
  for (const r of results.slice(1)) {
    const speedup = baseline.totalMs / r.totalMs;
    const callDelta = r.apiCalls - baseline.apiCalls;
    console.log(
      `  ${r.name}: ${speedup.toFixed(2)}x speedup, ${callDelta > 0 ? "+" : ""}${callDelta} API calls vs baseline`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`RPC: ${RPC_URL.replace(API_KEY, "***")}`);
  console.log();

  const QUICK_MODE = process.argv.includes("--quick");
  const CURRENT_ONLY = process.argv.includes("--current");

  const walletsToTest = QUICK_MODE
    ? [WALLETS[1]]  // heavy wallet only
    : CURRENT_ONLY
      ? [WALLETS[0]]  // medium wallet only
      : WALLETS;
  const approachesToTest = QUICK_MODE
    ? [APPROACHES[2]]  // C only
    : CURRENT_ONLY
      ? [APPROACHES[0], APPROACHES[4]]  // A (baseline) and E (current production)
      : APPROACHES;

  for (const wallet of walletsToTest) {
    console.log(`\n${"#".repeat(100)}`);
    console.log(`# WALLET: ${wallet.label} — ${wallet.address}`);
    console.log(`${"#".repeat(100)}\n`);

    const results: BenchmarkResult[] = [];

    for (let i = 0; i < approachesToTest.length; i++) {
      const approach = approachesToTest[i];
      console.log(`  Running: ${approach.name}...`);

      try {
        const result = await runApproach(wallet.address, approach.name, {
          probeType: approach.probeType,
          slicingFn: approach.slicingFn,
        });
        results.push(result);
        const maxPg = Math.max(...result.sliceStats.map((x) => x.pages));
        console.log(
          `    => ${formatMs(result.totalMs)} | ${result.apiCalls} calls | ${result.txCount} txs | ${result.sliceCount} slices | max ${maxPg} pages/slice`,
        );
      } catch (err) {
        console.log(`    => FAILED: ${err}`);
      }

      if (i < approachesToTest.length - 1) {
        console.log(`    Pausing ${PAUSE_BETWEEN_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
      }
    }

    if (results.length > 0) printResults(`${wallet.label} — ${wallet.address}`, results);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
