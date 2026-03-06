import type { CounterpartyFlow } from "@/lib/parse-transactions";
import { parseTraceTransferEvents } from "@/lib/parse-transactions";
import type { WalletIdentity, AccountTypeInfo } from "@/api";
import {
  NATIVE_SOL_ASSET_ID,
  aggregateTraceCounterparties,
  collectTraceAssetOptions,
  compareTraceCounterparties,
  type TraceNodeFlows,
  type TraceTransferEvent,
} from "@/lib/trace-types";
import {
  getBatchIdentity,
  getBatchSolDomains,
  getTokenMetadataBatch,
  getAccountTypesParallel,
  getTransactions,
} from "@/api";

/** Shared enrichment pipeline: batch identity + SNS lookup, filter spam */
const COUNTERPARTY_IDENTITY_LIMIT = 50;
const COUNTERPARTY_SNS_FALLBACK_LIMIT = 25;
const COUNTERPARTY_TOKEN_META_LIMIT = 200;

export async function enrichCounterparties(
  cps: CounterpartyFlow[],
): Promise<CounterpartyFlow[]> {
  const topIdentityAddresses = cps
    .slice(0, COUNTERPARTY_IDENTITY_LIMIT)
    .map((c) => c.address);
  const allAddresses = [...new Set(cps.map((c) => c.address))];

  const [identityMapResult, accountTypeResult] = await Promise.allSettled([
    getBatchIdentity(topIdentityAddresses),
    getAccountTypesParallel(allAddresses),
  ]);
  const identityMap =
    identityMapResult.status === "fulfilled"
      ? identityMapResult.value
      : new Map<string, WalletIdentity>();
  const accountTypeMap =
    accountTypeResult.status === "fulfilled"
      ? accountTypeResult.value
      : new Map<string, AccountTypeInfo>();

  const snsFallbackAddresses = topIdentityAddresses
    .filter((address) => !identityMap.has(address))
    .slice(0, COUNTERPARTY_SNS_FALLBACK_LIMIT);
  const snsMap = snsFallbackAddresses.length > 0
    ? await getBatchSolDomains(snsFallbackAddresses).catch(() => new Map<string, string>())
    : new Map<string, string>();

  // Collect unique mints from token accounts for metadata lookup
  const mints = new Set<string>();
  for (const cp of cps.slice(0, COUNTERPARTY_TOKEN_META_LIMIT)) {
    const info = accountTypeMap.get(cp.address);
    if (info?.type === "token" && info.mint) mints.add(info.mint);
  }
  const tokenMetaMap = mints.size > 0
    ? await getTokenMetadataBatch([...mints])
    : new Map<string, { name?: string; symbol?: string; logoUri?: string }>();

  return cps
    .map((cp) => {
      const id = identityMap.get(cp.address);
      const snsDomain = snsMap.get(cp.address);
      const acctInfo = accountTypeMap.get(cp.address);
      const isToken = acctInfo?.type === "token";
      const mint = isToken ? acctInfo?.mint : undefined;
      const tokenMeta = mint ? tokenMetaMap.get(mint) : undefined;
      const tokenName = tokenMeta?.name;
      const tokenSymbol = tokenMeta?.symbol;
      const tokenLogoUri = tokenMeta?.logoUri;
      return {
        ...cp,
        label: id?.label ?? id?.name ?? snsDomain,
        category: id?.category ?? (snsDomain ? "SNS" : undefined),
        accountType: acctInfo?.type,
        mint,
        tokenName,
        tokenSymbol,
        tokenLogoUri,
      };
    })
    .filter((cp) => {
      const label = (cp.label ?? "").toLowerCase();
      if (label.includes("spam") || label.includes("dusting")) return false;
      const totalVol = cp.solSent + cp.solReceived;
      if (cp.txCount >= 3 && totalVol < 0.001) return false;
      return true;
    });
}

// Well-known program addresses — skip RPC for these
const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",     // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token
  "ComputeBudget111111111111111111111111111111",    // Compute Budget
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",  // Serum/OpenBook
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",  // Memo v2
  "Memo1UhkJBfCR6MNLc4u1mfLsJgGT2ciczyG5hXVfHi",  // Memo v1
  "Vote111111111111111111111111111111111111111",     // Vote
  "Stake11111111111111111111111111111111111111",     // Stake
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",  // Metaplex Metadata
  "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg",  // Metaplex Auth
  "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",  // SPL Name Service
]);

const TRACE_MINT_META_LIMIT = 400;
const TRACE_IDENTITY_LIMIT = 150;

function collectTraceMints(events: TraceTransferEvent[]): string[] {
  const mintScores = new Map<string, number>();
  for (const event of events) {
    if (!event.mint) continue;
    mintScores.set(event.mint, (mintScores.get(event.mint) ?? 0) + 1);
  }
  return [...mintScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRACE_MINT_META_LIMIT)
    .map(([mint]) => mint);
}

function enrichTraceEvent(
  event: TraceTransferEvent,
  identityMap: Map<string, WalletIdentity>,
  tokenMetaMap: Map<string, { name?: string; symbol?: string; logoUri?: string }>,
): TraceTransferEvent {
  const identity = identityMap.get(event.counterparty);
  const meta = event.assetId === NATIVE_SOL_ASSET_ID
    ? { symbol: "SOL", name: "Native SOL" }
    : (event.mint ? tokenMetaMap.get(event.mint) : undefined);
  return {
    ...event,
    counterpartyLabel: identity?.label ?? identity?.name,
    counterpartyCategory: identity?.category,
    symbol: meta?.symbol ?? event.symbol,
    name: meta?.name ?? event.name,
    logoUri: meta?.logoUri ?? event.logoUri,
  };
}

function buildTraceNodeFlows(address: string, events: TraceTransferEvent[], metadataPending: boolean): TraceNodeFlows {
  const timestamps = events.map((event) => event.timestamp).filter((value) => value > 0);
  return {
    address,
    events,
    assets: collectTraceAssetOptions(events),
    firstSeen: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    lastSeen: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    metadataPending,
  };
}

function finalizeBaseTraceEvent(
  event: TraceTransferEvent,
  accountTypeMap: Map<string, AccountTypeInfo>,
): TraceTransferEvent {
  const acctInfo = accountTypeMap.get(event.counterparty);
  const nativeMeta = event.assetId === NATIVE_SOL_ASSET_ID
    ? { symbol: "SOL", name: "Native SOL" }
    : undefined;
  return {
    ...event,
    counterpartyAccountType: acctInfo?.type,
    symbol: nativeMeta?.symbol ?? event.symbol,
    name: nativeMeta?.name ?? event.name,
  };
}

function buildImmediateTraceFlows(address: string, allTxs: Awaited<ReturnType<typeof getTransactions>>): TraceNodeFlows {
  const rawEvents = parseTraceTransferEvents(allTxs, address)
    .filter((event) => !KNOWN_PROGRAMS.has(event.counterparty));

  if (rawEvents.length === 0) {
    return {
      address,
      events: [],
      assets: [],
      firstSeen: 0,
      lastSeen: 0,
      metadataPending: false,
    };
  }

  return buildTraceNodeFlows(address, rawEvents, true);
}

async function filterWalletTraceFlows(base: TraceNodeFlows): Promise<TraceNodeFlows> {
  if (base.events.length === 0) return { ...base, metadataPending: false };

  const uniqueCounterparties = [...new Set(base.events.map((event) => event.counterparty))];
  const accountTypeMap = await getAccountTypesParallel(uniqueCounterparties)
    .catch(() => new Map<string, AccountTypeInfo>());

  const walletEvents = base.events.filter((event) => {
    const acctInfo = accountTypeMap.get(event.counterparty);
    return !acctInfo || acctInfo.type === "wallet" || acctInfo.type === "unknown";
  });

  return buildTraceNodeFlows(
    base.address,
    walletEvents.map((event) => finalizeBaseTraceEvent(event, accountTypeMap)),
    true,
  );
}

async function enrichTraceFlowsMetadata(base: TraceNodeFlows): Promise<TraceNodeFlows> {
  if (base.events.length === 0) return { ...base, metadataPending: false };

  const rankedCounterparties = aggregateTraceCounterparties(base.events)
    .sort(compareTraceCounterparties);
  const [identityMap, tokenMetaMap] = await Promise.all([
    getBatchIdentity(
      rankedCounterparties.slice(0, TRACE_IDENTITY_LIMIT).map((cp) => cp.address),
    ).catch(() => new Map<string, WalletIdentity>()),
    getTokenMetadataBatch(collectTraceMints(base.events))
      .catch(() => new Map<string, { name?: string; symbol?: string; logoUri?: string }>()),
  ]);

  const enrichedEvents = base.events
    .map((event) => enrichTraceEvent(event, identityMap, tokenMetaMap))
    .filter((event) => {
      const label = (event.counterpartyLabel ?? "").toLowerCase();
      return !label.includes("spam") && !label.includes("dusting");
    });

  return buildTraceNodeFlows(base.address, enrichedEvents, false);
}

export async function fetchTraceFlows(
  address: string,
  onEnriched?: (data: TraceNodeFlows) => void,
): Promise<TraceNodeFlows> {
  const allTxs = await getTransactions(address);
  if (allTxs.length === 0) {
    return {
      address,
      events: [],
      assets: [],
      firstSeen: 0,
      lastSeen: 0,
      metadataPending: false,
    };
  }

  const base = buildImmediateTraceFlows(address, allTxs);

  if (base.events.length === 0 || !onEnriched) {
    return base.events.length === 0 ? { ...base, metadataPending: false } : base;
  }

  void filterWalletTraceFlows(base)
    .then((walletBase) => enrichTraceFlowsMetadata(walletBase))
    .then((data) => onEnriched(data))
    .catch((err) => {
      console.error("Trace metadata enrichment failed:", err);
      onEnriched({ ...base, metadataPending: false });
    });

  return base;
}
