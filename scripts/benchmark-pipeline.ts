/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end pipeline benchmark: fetch → parse → enrich (trace mode).
 * Self-contained — doesn't import src/ modules (avoids Vite/ESM issues).
 *
 * Usage:  npx tsx scripts/benchmark-pipeline.ts [address]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadApiKey(): string {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(__dirname, "..", f);
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
const WALLET_API = `https://api.helius.xyz/v1/wallet`;

const ADDRESS = process.argv[2] || "8cRrU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y";
const TRACE_RESULT_LIMIT = 200;
const TRACE_CLASSIFY_BATCH = 200;
const TRACE_MAX_SCAN = 800;
const GTFA_TOKEN_ACCOUNTS_MODE = "balanceChanged";
const RATE_LIMIT_RETRIES = 5;
const MAX_SIGNATURE_SLICE_CONCURRENCY = 32;
const FETCH_TIMEOUT_MS = 15_000;
const GTFA_SIGNATURE_PAGE_LIMIT = 1000;
const TARGET_GTFA_TXS_PER_SLICE = 700;
const MAX_TRANSACTION_SLICES = 64;

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

let apiCalls = 0;

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    apiCalls++;
    let res: Response;
    try {
      const body =
        method === "batch"
          ? params
          : { jsonrpc: "2.0", id: 1, method, params };
      res = await fetchWithTimeout(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
      throw new Error(`${method} failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const batch = Array.isArray(json) ? json : [json];
    const retryable = batch.some((entry: { error?: { code?: number } }) => entry?.error?.code === -32429);
    if (retryable && attempt < RATE_LIMIT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    if (method !== "batch" && json.error) throw new Error(`${method} RPC error: ${JSON.stringify(json.error)}`);
    return json;
  }
  throw new Error(`${method} exceeded retry budget`);
}

interface RpcTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (string | { pubkey: string })[];
      instructions?: {
        program?: string;
        programId?: string;
        parsed?: { type?: string; info?: Record<string, unknown> };
      }[];
    };
  };
  meta: {
    err: unknown; fee: number;
    preBalances: number[]; postBalances: number[];
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null; decimals: number } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null; decimals: number } }[];
    innerInstructions?: {
      index: number;
      instructions: {
        program?: string;
        programId?: string;
        parsed?: { type?: string; info?: Record<string, unknown> };
      }[];
    }[];
  } | null;
}

// ---------------------------------------------------------------------------
// Fetch layer (production: GTFA signatures + tokenAccounts + batch hydration)
// ---------------------------------------------------------------------------

async function probeTimeline(addr: string) {
  // Fire both probe requests in parallel
  const [oldest, recent] = await Promise.all([
    rpc("getTransactionsForAddress", [addr, {
      transactionDetails: "signatures",
      sortOrder: "asc",
      limit: 1,
      commitment: "confirmed",
      filters: { tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
    }]),
    rpc("getTransactionsForAddress", [addr, {
      transactionDetails: "signatures",
      sortOrder: "desc",
      limit: GTFA_SIGNATURE_PAGE_LIMIT,
      commitment: "confirmed",
      filters: { tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
    }]),
  ]);

  const first = oldest.result?.data?.[0]?.blockTime;
  if (first == null) return null;

  const data = recent.result?.data ?? [];
  if (data.length === 0) return { firstBlockTime: first, estimatedTxCount: 1 };
  if (!recent.result?.paginationToken) {
    return { firstBlockTime: first, estimatedTxCount: data.length };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const entry of data as Array<{ blockTime?: number | null }>) {
    if (typeof entry.blockTime !== "number") continue;
    if (entry.blockTime < min) min = entry.blockTime;
    if (entry.blockTime > max) max = entry.blockTime;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { firstBlockTime: first, estimatedTxCount: data.length };
  }

  const est = Math.ceil(data.length * (Math.max(max - first, 1) / Math.max(max - min, 1)));
  return { firstBlockTime: first, estimatedTxCount: Math.max(est, data.length) };
}

function optimalSliceCount(est: number, span: number): number {
  if (span < 86400 * 7 || est <= GTFA_SIGNATURE_PAGE_LIMIT) return 1;
  return Math.max(2, Math.min(Math.ceil(est / TARGET_GTFA_TXS_PER_SLICE), MAX_TRANSACTION_SLICES));
}

function createUniformSlices(first: number, now: number, count: number) {
  const span = now - first;
  if (span <= 0 || count <= 0) return [{ gte: first, lt: now }];
  const size = Math.ceil(span / count);
  const slices: { gte: number; lt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const gte = first + i * size;
    const lt = Math.min(first + (i + 1) * size, now);
    if (gte < lt) slices.push({ gte, lt });
  }
  return slices;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

async function fetchSlice(addr: string, gte: number, lt: number): Promise<RpcTx[]> {
  const all: RpcTx[] = [];
  let token: string | undefined;
  const requestLt = lt - gte <= 1 ? lt + 1 : lt;
  const seenTokens = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const params: Record<string, unknown> = {
      transactionDetails: "full", sortOrder: "asc", limit: 1000,
      commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
      filters: { blockTime: { gte, lt: requestLt }, tokenAccounts: GTFA_TOKEN_ACCOUNTS_MODE },
    };
    if (token) params.paginationToken = token;
    const json = await rpc("getTransactionsForAddress", [addr, params]);
    const data = json.result?.data ?? [];
    all.push(...data);
    const next = json.result?.paginationToken;
    if (!next) break;
    if (seenTokens.has(next)) {
      throw new Error(`GTFA full pagination repeated for slice [${gte}, ${lt})`);
    }
    seenTokens.add(next);
    token = next;
  }
  if (token) {
    throw new Error(`GTFA full slice [${gte}, ${lt}) exceeded 200 pages`);
  }
  return all;
}

function dedup(txs: RpcTx[]): RpcTx[] {
  const seen = new Set<string>();
  return txs.filter((tx) => {
    const sig = tx.transaction.signatures[0];
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Parse (mirrors trace parsing — direct native/token transfer counterparties)
// ---------------------------------------------------------------------------

const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJBfCR6MNLc4u1mfLsJgGT2ciczyG5hXVfHi",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg",
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
]);

interface CounterpartyFlow {
  address: string;
  txCount: number;
  transferCount: number;
  inflowTxCount: number;
  outflowTxCount: number;
  assetCount: number;
}

function parseCounterparties(txs: RpcTx[], walletAddr: string): CounterpartyFlow[] {
  const map = new Map<
    string,
    {
      txCount: number;
      transferCount: number;
      inflowTxCount: number;
      outflowTxCount: number;
      assets: Set<string>;
    }
  >();

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => typeof k === "string" ? k : k.pubkey);
    const tokenInfo = new Map<string, { owner?: string; mint?: string }>();
    for (const tb of tx.meta.preTokenBalances ?? []) {
      tokenInfo.set(keys[tb.accountIndex], { owner: tb.owner, mint: tb.mint });
    }
    for (const tb of tx.meta.postTokenBalances ?? []) {
      const current = tokenInfo.get(keys[tb.accountIndex]) ?? {};
      tokenInfo.set(keys[tb.accountIndex], { owner: current.owner ?? tb.owner, mint: current.mint ?? tb.mint });
    }

    const seen = new Set<string>();
    const seenDir = { inflow: new Set<string>(), outflow: new Set<string>() };
    const instructions = [
      ...(tx.transaction.message.instructions ?? []),
      ...((tx.meta.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? [])),
    ];

    for (const instruction of instructions) {
      let cp: string | null = null;
      let assetId: string | null = null;
      let direction: "inflow" | "outflow" | null = null;

      if (
        (instruction.program === "system" || instruction.programId === "11111111111111111111111111111111")
        && (instruction.parsed?.type === "transfer" || instruction.parsed?.type === "transferWithSeed")
      ) {
        const source = instruction.parsed.info?.source;
        const destination = instruction.parsed.info?.destination;
        const lamports = instruction.parsed.info?.lamports;
        if (
          typeof source !== "string"
          || typeof destination !== "string"
          || (typeof lamports !== "number" && typeof lamports !== "string")
        ) {
          continue;
        }
        if (source === walletAddr && destination !== walletAddr) {
          cp = destination;
          direction = "outflow";
        } else if (destination === walletAddr && source !== walletAddr) {
          cp = source;
          direction = "inflow";
        } else {
          continue;
        }
        assetId = "native:sol";
      } else if (
        (instruction.program === "spl-token"
          || instruction.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          || instruction.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
        && (
          instruction.parsed?.type === "transfer"
          || instruction.parsed?.type === "transferChecked"
          || instruction.parsed?.type === "transferCheckedWithFee"
        )
      ) {
        const source = instruction.parsed.info?.source;
        const destination = instruction.parsed.info?.destination;
        if (typeof source !== "string" || typeof destination !== "string") continue;
        const sourceOwner = tokenInfo.get(source)?.owner;
        const destinationOwner = tokenInfo.get(destination)?.owner;
        const mint =
          (typeof instruction.parsed.info?.mint === "string" ? instruction.parsed.info.mint : undefined)
          ?? tokenInfo.get(source)?.mint
          ?? tokenInfo.get(destination)?.mint;
        if (!mint) continue;
        if (sourceOwner === walletAddr && destinationOwner && destinationOwner !== walletAddr) {
          cp = destinationOwner;
          direction = "outflow";
        } else if (destinationOwner === walletAddr && sourceOwner && sourceOwner !== walletAddr) {
          cp = sourceOwner;
          direction = "inflow";
        } else {
          continue;
        }
        assetId = mint;
      } else {
        continue;
      }

      if (!cp || !assetId || KNOWN_PROGRAMS.has(cp)) continue;

      const entry = map.get(cp) ?? {
        txCount: 0,
        transferCount: 0,
        inflowTxCount: 0,
        outflowTxCount: 0,
        assets: new Set<string>(),
      };
      entry.transferCount += 1;
      entry.assets.add(assetId);
      if (!seen.has(cp)) {
        seen.add(cp);
        entry.txCount += 1;
      }
      if (!seenDir[direction].has(cp)) {
        seenDir[direction].add(cp);
        if (direction === "outflow") entry.outflowTxCount += 1;
        else entry.inflowTxCount += 1;
      }
      map.set(cp, entry);
    }
  }

  return Array.from(map.entries())
    .map(([address, data]) => ({
      address,
      txCount: data.txCount,
      transferCount: data.transferCount,
      inflowTxCount: data.inflowTxCount,
      outflowTxCount: data.outflowTxCount,
      assetCount: data.assets.size,
    }))
    .filter((cp) => !KNOWN_PROGRAMS.has(cp.address))
    .sort((a, b) => b.txCount - a.txCount || b.transferCount - a.transferCount || b.assetCount - a.assetCount);
}

// ---------------------------------------------------------------------------
// Enrich (identity + account types)
// ---------------------------------------------------------------------------

async function getBatchIdentity(addrs: string[]): Promise<Map<string, any>> {
  if (addrs.length === 0) return new Map();
  apiCalls++;
  const res = await fetch(`${WALLET_API}/batch-identity?api-key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: addrs.slice(0, 100) }),
  });
  if (!res.ok) return new Map();
  const data = await res.json();
  const map = new Map<string, any>();
  if (Array.isArray(data)) {
    for (const entry of data) if (entry.address) map.set(entry.address, entry);
  }
  return map;
}

async function getAccountTypesParallel(addrs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (addrs.length === 0) return map;
  const chunks: string[][] = [];
  for (let i = 0; i < addrs.length; i += 100) chunks.push(addrs.slice(i, i + 100));
  const results = await Promise.allSettled(
    chunks.map((chunk) => rpc("getMultipleAccounts", [chunk, { encoding: "jsonParsed" }])),
  );
  for (let c = 0; c < chunks.length; c++) {
    const r = results[c];
    if (r.status !== "fulfilled") continue;
    const values = r.value?.result?.value ?? [];
    for (let i = 0; i < chunks[c].length; i++) {
      const acct = values[i];
      if (!acct) { map.set(chunks[c][i], "wallet"); continue; }
      const owner = acct.owner;
      if (owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
          owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
        map.set(chunks[c][i], "token");
      } else if (owner === "11111111111111111111111111111111") {
        map.set(chunks[c][i], "wallet");
      } else if (acct.executable) {
        map.set(chunks[c][i], "program");
      } else {
        map.set(chunks[c][i], "unknown");
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Full pipeline (mirrors new fetchTraceCounterparties)
// ---------------------------------------------------------------------------

async function runPipeline(addr: string) {
  // 1. Probe
  const probeT0 = performance.now();
  const probe = await probeTimeline(addr);
  const probeMs = performance.now() - probeT0;
  if (!probe) throw new Error("Probe failed");

  // 2. Fetch
  const now = Math.floor(Date.now() / 1000) + 60;
  const sliceCount = optimalSliceCount(probe.estimatedTxCount, now - probe.firstBlockTime);
  const slices = createUniformSlices(probe.firstBlockTime, now, sliceCount);

  const fetchT0 = performance.now();
  const results = await mapWithConcurrency(
    slices,
    MAX_SIGNATURE_SLICE_CONCURRENCY,
    (s) => fetchSlice(addr, s.gte, s.lt),
  );
  const allTxs = dedup(results.flat());
  const fetchMs = performance.now() - fetchT0;

  // 3. Parse
  const parseT0 = performance.now();
  const cps = parseCounterparties(allTxs, addr);
  const parseMs = performance.now() - parseT0;

  // 4. Enrich (keep top 200 wallets, but scan deeper when non-wallets crowd the top activity ranks)
  const enrichT0 = performance.now();
  const candidates = cps.slice(0, TRACE_MAX_SCAN);
  const wallets: CounterpartyFlow[] = [];
  let classified = 0;
  let classifyChunks = 0;

  for (let i = 0; i < candidates.length && wallets.length < TRACE_RESULT_LIMIT; i += TRACE_CLASSIFY_BATCH) {
    const batch = candidates.slice(i, i + TRACE_CLASSIFY_BATCH);
    classified += batch.length;
    const accountTypeMap = await getAccountTypesParallel(batch.map((c) => c.address))
      .catch(() => new Map<string, string>());
    classifyChunks += Math.ceil(batch.length / 100);
    for (const cp of batch) {
      const t = accountTypeMap.get(cp.address);
      if (!t || t === "wallet" || t === "unknown") {
        wallets.push(cp);
        if (wallets.length >= TRACE_RESULT_LIMIT) break;
      }
    }
  }
  const identityMap = await getBatchIdentity(wallets.slice(0, 50).map((c) => c.address)).catch(() => new Map());
  const enrichMs = performance.now() - enrichT0;

  const totalMs = performance.now() - probeT0;

  return {
    probeMs, fetchMs, parseMs, enrichMs, totalMs,
    txCount: allTxs.length,
    totalCounterparties: cps.length,
    classified,
    classifyChunks,
    walletCount: wallets.length,
    identityCount: identityMap.size,
    sliceCount,
    estimatedTxCount: probe.estimatedTxCount,
    apiCalls,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printResult(label: string, r: Awaited<ReturnType<typeof runPipeline>>) {
  console.log(`  [${label}]`);
  console.log(`    Probe:     ${r.probeMs.toFixed(0)}ms (est ${r.estimatedTxCount} txns)`);
  console.log(`    Fetch:     ${(r.fetchMs / 1000).toFixed(2)}s (${r.txCount} txns, ${r.sliceCount} slices)`);
  console.log(`    Parse:     ${r.parseMs.toFixed(0)}ms → ${r.totalCounterparties} counterparties`);
  console.log(`    Enrich:    ${r.enrichMs.toFixed(0)}ms (top ${r.classified} by activity, ${r.classifyChunks} getMultipleAccounts chunks)`);
  console.log(`    TOTAL:     ${(r.totalMs / 1000).toFixed(2)}s`);
  console.log(`    Result:    ${r.walletCount} wallets, ${r.identityCount} identities`);
  console.log(`    API calls: ${r.apiCalls}`);
}

async function main() {
  console.log(`Address: ${ADDRESS}`);
  console.log(`RPC: ${RPC_URL.replace(API_KEY, "***")}\n`);

  const modes: Array<"direct" | "sig-first"> = ["direct", "sig-first"];
  const allResults: Record<string, Awaited<ReturnType<typeof runPipeline>>[]> = {
    direct: [],
    "sig-first": [],
  };

  for (let run = 1; run <= 2; run++) {
    console.log(`\n========== Run ${run} ==========`);
    for (const mode of modes) {
      apiCalls = 0;
      console.log(`\n  Running ${mode}...`);
      const r = await runPipeline(ADDRESS, mode);
      allResults[mode].push(r);
      printResult(mode, r);
      // pause between runs to avoid rate limit interference
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Summary comparison
  console.log(`\n\n====== COMPARISON ======`);
  for (const mode of modes) {
    const runs = allResults[mode];
    const avgFetch = runs.reduce((s, r) => s + r.fetchMs, 0) / runs.length;
    const avgTotal = runs.reduce((s, r) => s + r.totalMs, 0) / runs.length;
    const avgCalls = runs.reduce((s, r) => s + r.apiCalls, 0) / runs.length;
    console.log(`  ${mode.padEnd(12)} | avg fetch: ${(avgFetch / 1000).toFixed(2)}s | avg total: ${(avgTotal / 1000).toFixed(2)}s | avg API calls: ${avgCalls.toFixed(0)}`);
  }
}

main().catch((err) => { console.error("Failed:", err); process.exit(1); });
