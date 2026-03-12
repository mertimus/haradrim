/**
 * Profile every RPC/API call in buildStablecoinDashboard to identify bottlenecks.
 *
 * Usage: node --env-file=.env.local scripts/profile-stablecoin-dashboard.mjs
 */

import { rpcJson, fetchWithTimeout, getBatchIdentity } from "../backend/src/providers.mjs";
import { stablecoinDashboardInternals } from "../backend/src/stablecoin-dashboard-core.mjs";
import { DIALECT_API_KEY, DIALECT_API_BASE } from "../backend/src/config.mjs";

const { STABLECOINS } = stablecoinDashboardInternals;

const timings = [];

async function timeCall(label, fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - t0;
    timings.push({ label, ms });
    console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${label}`);
    return result;
  } catch (err) {
    const ms = performance.now() - t0;
    timings.push({ label: `${label} [ERROR]`, ms });
    console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${label} [ERROR: ${err.message}]`);
    return null;
  }
}

async function main() {
  console.log("=== SEQUENTIAL PROFILING (isolated, no contention) ===\n");

  // ── getTokenSupply × 11 ──
  console.log("getTokenSupply × 11:");
  const supplies = [];
  for (const sc of STABLECOINS) {
    const r = await timeCall(sc.ticker, () => rpcJson("getTokenSupply", [sc.mint]));
    supplies.push(r);
  }

  // ── getTokenLargestAccountsV2 × 11 ──
  console.log("\ngetTokenLargestAccountsV2 (limit=200) × 11:");
  const accounts = [];
  for (const sc of STABLECOINS) {
    const r = await timeCall(sc.ticker, () =>
      rpcJson("getTokenLargestAccountsV2", [sc.mint, { commitment: "confirmed", limit: 200 }])
    );
    accounts.push(r);
  }

  // ── Dialect yield markets × 11 ──
  console.log("\nDialect yield markets × 11:");
  for (const sc of STABLECOINS) {
    const url = `${DIALECT_API_BASE}/v0/markets?type=yield,lending&asset=${sc.mint}&limit=200`;
    await timeCall(sc.ticker, async () => {
      const res = await fetchWithTimeout(url, {
        headers: { "x-dialect-api-key": DIALECT_API_KEY },
      });
      if (res.ok) await res.json();
      return res;
    });
  }

  // ── getBatchIdentity ──
  const allOwners = new Set();
  for (const r of accounts) {
    for (const a of (r?.result?.value?.accounts ?? [])) {
      if (a?.owner) allOwners.add(a.owner);
    }
  }
  const ownerList = [...allOwners];

  console.log(`\ngetBatchIdentity (${ownerList.length} unique owners, chunks of 100):`);
  const chunks = [];
  for (let i = 0; i < ownerList.length; i += 100) {
    chunks.push(ownerList.slice(i, i + 100));
  }
  // Can't easily call getBatchIdentity per-chunk without hitting cache,
  // so call the raw wallet API directly
  const { buildWalletApiUrl } = await import("../backend/src/providers.mjs");
  for (let i = 0; i < chunks.length; i++) {
    await timeCall(`chunk ${i + 1}/${chunks.length} (${chunks[i].length} addrs)`, async () => {
      const url = buildWalletApiUrl("/v1/wallet/batch-identity");
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ addresses: chunks[i] }),
      });
      if (res.ok) return res.json();
      return [];
    });
  }

  // ── Summary ──
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY BY CALL TYPE");
  console.log("=".repeat(80));

  const grouped = new Map();
  // Re-group by phase
  let phase = "";
  for (const t of timings) {
    // Detect phase boundaries
    if (!grouped.has(phase)) grouped.set(phase, []);
    grouped.get(phase).push(t);
  }

  // Better: group by known phases
  const phases = [
    { name: "getTokenSupply", count: 11 },
    { name: "getTokenLargestAccountsV2", count: 11 },
    { name: "Dialect yield", count: 11 },
    { name: "batchIdentity", count: chunks.length },
  ];

  let offset = 0;
  for (const p of phases) {
    const items = timings.slice(offset, offset + p.count);
    offset += p.count;
    const total = items.reduce((s, t) => s + t.ms, 0);
    const avg = total / items.length;
    const max = Math.max(...items.map((t) => t.ms));
    const min = Math.min(...items.map((t) => t.ms));

    console.log(`\n${p.name} (${items.length} calls):`);
    console.log(`  Sequential total: ${(total / 1000).toFixed(2)}s`);
    console.log(`  Average:          ${avg.toFixed(0)}ms`);
    console.log(`  Min:              ${min.toFixed(0)}ms`);
    console.log(`  Max:              ${max.toFixed(0)}ms`);
    console.log(`  Parallel cost:    ~${(max / 1000).toFixed(2)}s (bounded by slowest)`);
  }

  const grandTotal = timings.reduce((s, t) => s + t.ms, 0);
  console.log(`\nGrand sequential total: ${(grandTotal / 1000).toFixed(2)}s`);
  console.log(`\nCurrent code parallelism:`);
  console.log(`  Phase 1: Promise.all([supply×11, accounts×11, dialect×11]) = 33 concurrent calls`);
  console.log(`  Phase 2: getBatchIdentity (sequential AFTER phase 1)`);

  const supplyMax = Math.max(...timings.slice(0, 11).map((t) => t.ms));
  const accountsMax = Math.max(...timings.slice(11, 22).map((t) => t.ms));
  const dialectMax = Math.max(...timings.slice(22, 33).map((t) => t.ms));
  const identityTotal = timings.slice(33).reduce((s, t) => s + t.ms, 0);
  const identityMax = Math.max(...timings.slice(33).map((t) => t.ms));

  console.log(`\n  Phase 1 theoretical best (no rate limits): ~${(Math.max(supplyMax, accountsMax, dialectMax) / 1000).toFixed(2)}s`);
  console.log(`  Phase 2 identity sequential total:          ${(identityTotal / 1000).toFixed(2)}s`);
  console.log(`  Phase 2 identity parallel best:             ~${(identityMax / 1000).toFixed(2)}s`);
  console.log(`  Theoretical minimum wall-clock:             ~${((Math.max(supplyMax, accountsMax, dialectMax) + identityMax) / 1000).toFixed(2)}s`);
  console.log(`  Likely actual (rate limits add ~2-5×):      ~${((Math.max(supplyMax, accountsMax, dialectMax) * 3 + identityTotal) / 1000).toFixed(2)}s`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
