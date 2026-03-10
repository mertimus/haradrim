import { analyzeWallet } from "./analysis-core.mjs";
import { cachedValue } from "./cache.mjs";
import { WALLET_ANALYSIS_TTL_MS } from "./config.mjs";
import { buildWalletApiUrl, fetchWithTimeout } from "./providers.mjs";

const STRONG_TIMING_WINDOW_SECS = 30 * 60;     // 30 min
const MEDIUM_TIMING_WINDOW_SECS = 6 * 60 * 60;  // 6 hr

function extractControllers(tx, owner) {
  if (!tx?.transaction?.message?.accountKeys) {
    return { feePayer: null, signers: [] };
  }
  const accountKeys = tx.transaction.message.accountKeys;
  const feePayer = (typeof accountKeys[0] === "string" ? accountKeys[0] : accountKeys[0]?.pubkey) || null;
  const signerSet = accountKeys
    .filter((key) => typeof key === "object" && key?.signer)
    .map((key) => key.pubkey ?? "")
    .filter((addr) => addr && addr !== owner && addr !== feePayer);
  return { feePayer, signers: [...new Set(signerSet)] };
}

async function fetchFunding(address) {
  try {
    const url = buildWalletApiUrl(`/v1/wallet/${address}/funded-by`);
    const res = await fetchWithTimeout(url, {});
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.funder) return null;
    return { address: data.funder, label: data.funderName ?? undefined };
  } catch {
    return null;
  }
}

function dominantSignal(signals) {
  return [...signals]
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))[0]?.kind
    ?? "unknown";
}

/**
 * Analyze forensic signals between two wallets' shared counterparties.
 * Returns per-shared-counterparty signal evidence.
 */
export async function analyzeWalletPairSignals(addrA, addrB) {
  // Reuse the same cache keys as handleWalletAnalysis so we share cached results
  const getCachedAnalysis = (addr) =>
    cachedValue(`wallet-analysis:${addr}:all:all`, WALLET_ANALYSIS_TTL_MS, () => analyzeWallet(addr));

  // Fetch analyses and funding in parallel
  const [analysisA, analysisB, fundingA, fundingB] = await Promise.all([
    getCachedAnalysis(addrA),
    getCachedAnalysis(addrB),
    fetchFunding(addrA),
    fetchFunding(addrB),
  ]);

  const cpMapA = new Map(analysisA.counterparties.map((cp) => [cp.address, cp]));
  const cpMapB = new Map(analysisB.counterparties.map((cp) => [cp.address, cp]));

  // Find shared counterparties
  const sharedAddresses = [];
  for (const addr of cpMapA.keys()) {
    if (cpMapB.has(addr) && addr !== addrA && addr !== addrB) {
      sharedAddresses.push(addr);
    }
  }

  // Build per-wallet tx data for each shared counterparty
  const txMapA = buildCounterpartyTxMap(analysisA.transactions, sharedAddresses, addrA);
  const txMapB = buildCounterpartyTxMap(analysisB.transactions, sharedAddresses, addrB);

  // Check shared funding
  const sharedFunder = fundingA && fundingB && fundingA.address === fundingB.address
    ? { address: fundingA.address, label: fundingA.label ?? fundingB.label }
    : null;

  const signals = [];

  for (const cpAddr of sharedAddresses) {
    const cpA = cpMapA.get(cpAddr);
    const cpB = cpMapB.get(cpAddr);
    if (!cpA || !cpB) continue;

    const cpSignals = [];

    // Signal 1: Shared fee payers
    const feePayersA = txMapA.get(cpAddr)?.feePayers ?? new Set();
    const feePayersB = txMapB.get(cpAddr)?.feePayers ?? new Set();
    const sharedFeePayers = [...feePayersA].filter((fp) =>
      feePayersB.has(fp) && fp !== addrA && fp !== addrB && fp !== cpAddr,
    );
    if (sharedFeePayers.length > 0) {
      cpSignals.push({
        kind: "shared_fee_payer",
        score: Math.min(5, 4.4 * sharedFeePayers.length),
        summary: `Shared fee payer: ${sharedFeePayers[0].slice(0, 8)}...`,
        detail: sharedFeePayers,
      });
    }

    // Signal 2: Shared signers
    const signersA = txMapA.get(cpAddr)?.signers ?? new Set();
    const signersB = txMapB.get(cpAddr)?.signers ?? new Set();
    const sharedSigners = [...signersA].filter((s) =>
      signersB.has(s) && s !== addrA && s !== addrB && s !== cpAddr,
    );
    if (sharedSigners.length > 0) {
      cpSignals.push({
        kind: "shared_signer",
        score: Math.min(5, 3.3 + (sharedSigners.length - 1) * 0.6),
        summary: `Shared signer: ${sharedSigners[0].slice(0, 8)}...`,
        detail: sharedSigners,
      });
    }

    // Signal 3: Synchronized timing (two-pointer scan on sorted arrays)
    const timesA = (txMapA.get(cpAddr)?.timestamps ?? []).slice().sort((a, b) => a - b);
    const timesB = (txMapB.get(cpAddr)?.timestamps ?? []).slice().sort((a, b) => a - b);
    if (timesA.length > 0 && timesB.length > 0) {
      let minGap = Number.POSITIVE_INFINITY;
      let ia = 0;
      let ib = 0;
      while (ia < timesA.length && ib < timesB.length) {
        const gap = Math.abs(timesA[ia] - timesB[ib]);
        if (gap < minGap) minGap = gap;
        if (minGap === 0) break;
        if (timesA[ia] < timesB[ib]) ia++;
        else ib++;
      }

      if (minGap <= STRONG_TIMING_WINDOW_SECS) {
        cpSignals.push({
          kind: "synchronized_timing",
          score: 2.5,
          summary: `Activity within ${Math.round(minGap / 60)}min of each other`,
        });
      } else if (minGap <= MEDIUM_TIMING_WINDOW_SECS) {
        cpSignals.push({
          kind: "synchronized_timing",
          score: 1.2,
          summary: `Activity within ${Math.round(minGap / 3600)}hr of each other`,
        });
      }
    }

    if (cpSignals.length === 0) continue;

    const totalScore = cpSignals.reduce((sum, s) => sum + s.score, 0);

    signals.push({
      counterparty: cpAddr,
      label: cpA.label ?? cpB.label,
      totalScore,
      dominantSignal: dominantSignal(cpSignals),
      signals: cpSignals,
    });
  }

  // Sort by total score descending
  signals.sort((a, b) => b.totalScore - a.totalScore);

  return {
    walletA: addrA,
    walletB: addrB,
    sharedCounterpartyCount: sharedAddresses.length,
    signalCount: signals.length,
    sharedFunder,
    signals,
  };
}

function buildCounterpartyTxMap(transactions, sharedAddresses, walletOwner) {
  const sharedSet = new Set(sharedAddresses);
  const map = new Map();

  for (const cpAddr of sharedAddresses) {
    map.set(cpAddr, {
      feePayers: new Set(),
      signers: new Set(),
      timestamps: [],
    });
  }

  for (const tx of transactions) {
    const involvedCps = tx.counterparties.filter((addr) => sharedSet.has(addr));
    if (involvedCps.length === 0) continue;

    const controllers = extractControllers(tx, walletOwner);

    for (const cpAddr of involvedCps) {
      const entry = map.get(cpAddr);
      if (!entry) continue;

      if (controllers.feePayer && controllers.feePayer !== walletOwner) {
        entry.feePayers.add(controllers.feePayer);
      }
      for (const signer of controllers.signers) {
        entry.signers.add(signer);
      }
      if (tx.timestamp) {
        entry.timestamps.push(tx.timestamp);
      }
    }
  }

  return map;
}
