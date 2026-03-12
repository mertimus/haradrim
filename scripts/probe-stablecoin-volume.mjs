/**
 * Probe stablecoin mint transaction volume to assess RPC feasibility.
 *
 * Usage: node --env-file=.env.local scripts/probe-stablecoin-volume.mjs
 */

import { rpcJson } from "../backend/src/providers.mjs";
import { stablecoinDashboardInternals } from "../backend/src/stablecoin-dashboard-core.mjs";

const { STABLECOINS } = stablecoinDashboardInternals;

// ── Lightweight inline probe ──────────────────────────────────────────

async function sigPage(address, sortOrder, limit) {
  const params = {
    transactionDetails: "signatures",
    sortOrder,
    limit,
    commitment: "confirmed",
  };
  const json = await rpcJson("getTransactionsForAddress", [address, params]);
  const result = json.result ?? {};
  return {
    txs: result.data ?? [],
    nextToken: result.paginationToken ?? null,
  };
}

async function probeMint(mint) {
  const t0 = performance.now();

  // oldest tx (asc, limit 1)
  const oldest = await sigPage(mint, "asc", 1);
  const oldestTs = oldest.txs[0]?.blockTime ?? null;

  // newest page (desc, limit 1000)
  const recent = await sigPage(mint, "desc", 1000);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (oldestTs == null || recent.txs.length === 0) {
    return { oldestTs: null, estimatedTotal: 0, recentRate: null, elapsed, hasMore: false };
  }

  const newestTs = recent.txs[0]?.blockTime ?? oldestTs;
  const hasMore = recent.nextToken != null;

  // Estimate total count via time-span extrapolation
  let estimatedTotal = recent.txs.length;
  if (hasMore && recent.txs.length >= 2) {
    const pageOldest = recent.txs[recent.txs.length - 1]?.blockTime ?? newestTs;
    const sampleSpan = Math.max(newestTs - pageOldest, 1);
    const totalSpan = Math.max(newestTs - oldestTs, 1);
    estimatedTotal = Math.ceil(recent.txs.length * (totalSpan / sampleSpan));
  }

  // Recent density: txs in the 1000-tx window / time span
  let recentRate = null;
  if (recent.txs.length >= 2) {
    const windowOldest = recent.txs[recent.txs.length - 1]?.blockTime;
    const windowNewest = recent.txs[0]?.blockTime;
    const windowSpanHrs = Math.max((windowNewest - windowOldest) / 3600, 0.001);
    recentRate = recent.txs.length / windowSpanHrs;
  }

  return { oldestTs, estimatedTotal, recentRate, elapsed, hasMore };
}

// ── Formatting helpers ────────────────────────────────────────────────

function fmtCount(n) {
  if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function fmtRate(ratePerHr) {
  if (ratePerHr == null) return "N/A";
  if (ratePerHr >= 1000) return `${(ratePerHr / 1000).toFixed(1)}K/hr`;
  return `${ratePerHr.toFixed(0)}/hr`;
}

function verdict(estimatedTotal, recentRate) {
  if (estimatedTotal > 10_000_000 || (recentRate && recentRate > 2000)) {
    return "Too busy for full history";
  }
  if (estimatedTotal > 1_000_000 || (recentRate && recentRate > 500)) {
    return "Recent window only";
  }
  return "Feasible (time-slice)";
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("Probing stablecoin mint transaction volume...\n");

  const results = [];

  for (const sc of STABLECOINS) {
    process.stdout.write(`  Probing ${sc.ticker} (${sc.mint.slice(0, 4)}...${sc.mint.slice(-4)})...`);
    try {
      const probe = await probeMint(sc.mint);
      results.push({ ...sc, ...probe });
      console.log(` done (${probe.elapsed}s)`);
    } catch (err) {
      results.push({
        ...sc,
        oldestTs: null,
        estimatedTotal: 0,
        recentRate: null,
        elapsed: "ERR",
        hasMore: false,
        error: err.message,
      });
      console.log(` ERROR: ${err.message}`);
    }
  }

  // Print table
  console.log("\n");
  const header = [
    "Ticker".padEnd(12),
    "Mint (short)".padEnd(14),
    "Est. Total TXs".padEnd(17),
    "Recent Rate".padEnd(14),
    "Probe Time".padEnd(12),
    "Verdict",
  ].join(" | ");

  const sep = header.replace(/[^|]/g, "-");

  console.log(header);
  console.log(sep);

  for (const r of results) {
    const mintShort = `${r.mint.slice(0, 4)}...${r.mint.slice(-4)}`;
    const row = [
      r.ticker.padEnd(12),
      mintShort.padEnd(14),
      (r.error ? "ERROR" : fmtCount(r.estimatedTotal)).padEnd(17),
      (r.error ? "N/A" : fmtRate(r.recentRate)).padEnd(14),
      `${r.elapsed}s`.padEnd(12),
      r.error ? `Error: ${r.error.slice(0, 40)}` : verdict(r.estimatedTotal, r.recentRate),
    ].join(" | ");
    console.log(row);
  }

  console.log("\n");

  // Summary
  const feasible = results.filter((r) => !r.error && verdict(r.estimatedTotal, r.recentRate) === "Feasible (time-slice)");
  const recentOnly = results.filter((r) => !r.error && verdict(r.estimatedTotal, r.recentRate) === "Recent window only");
  const tooBusy = results.filter((r) => !r.error && verdict(r.estimatedTotal, r.recentRate) === "Too busy for full history");
  const errors = results.filter((r) => r.error);

  console.log("Summary:");
  if (feasible.length) console.log(`  Feasible (full history): ${feasible.map((r) => r.ticker).join(", ")}`);
  if (recentOnly.length) console.log(`  Recent window only:     ${recentOnly.map((r) => r.ticker).join(", ")}`);
  if (tooBusy.length) console.log(`  Too busy:               ${tooBusy.map((r) => r.ticker).join(", ")}`);
  if (errors.length) console.log(`  Errors:                 ${errors.map((r) => r.ticker).join(", ")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
