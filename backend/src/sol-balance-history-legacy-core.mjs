import { MAX_BALANCE_HISTORY_LEGACY_RPC_CONCURRENCY } from "./config.mjs";
import { mapWithConcurrency, rpcJson } from "./providers.mjs";
import { solBalanceHistoryInternals } from "./sol-balance-history-core.mjs";

const GSFA_PAGE_LIMIT = 1000;

async function fetchSignaturePage(address, before) {
  const json = await rpcJson("getSignaturesForAddress", [
    address,
    {
      limit: GSFA_PAGE_LIMIT,
      commitment: "confirmed",
      ...(before ? { before } : {}),
    },
  ]);
  return Array.isArray(json.result) ? json.result : [];
}

const MAX_LEGACY_SIGNATURES = 50_000;

async function fetchAllSignatures(address) {
  const all = [];
  let before;

  while (true) {
    const page = await fetchSignaturePage(address, before);
    if (page.length === 0) break;
    all.push(...page);
    if (all.length >= MAX_LEGACY_SIGNATURES) break;
    if (page.length < GSFA_PAGE_LIMIT) break;
    before = page[page.length - 1]?.signature;
  }

  return all;
}

async function fetchTransaction(signature) {
  const json = await rpcJson("getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  return json.result ?? null;
}

export async function analyzeWalletSolBalanceHistoryLegacy(address) {
  const signatures = await fetchAllSignatures(address);
  if (signatures.length === 0) {
    return solBalanceHistoryInternals.buildSolBalanceHistoryResult(address, [], {
      estimatedTxCount: 0,
      strategy: "legacy-gsfa-get-transaction",
    });
  }

  const hydrated = await mapWithConcurrency(
    signatures,
    MAX_BALANCE_HISTORY_LEGACY_RPC_CONCURRENCY,
    (item) => fetchTransaction(item.signature),
  );

  return solBalanceHistoryInternals.buildSolBalanceHistoryResult(
    address,
    hydrated.filter(Boolean),
    {
      estimatedTxCount: signatures.length,
      strategy: "legacy-gsfa-get-transaction",
    },
  );
}
