import { gtfaPage, type RpcTransaction } from "@/api";
import { cached } from "@/lib/cache";
import type { TokenHolder } from "@/birdeye-api";

// ---- Types ----

export interface HolderConnection {
  source: string;
  target: string;
  txCount: number;
  bidirectional: boolean;
}

export interface HolderCluster {
  id: number;
  members: string[];
  totalPct: number;
  connectionCount: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  connections: HolderConnection[];
  clusters: HolderCluster[];
}

// ---- Constants ----

const TTL_CONNS = 15 * 60 * 1000; // 15 min
const MAX_PAGES_PER_HOLDER = 5;

// Known Solana infrastructure — never meaningful connections
export const INFRASTRUCTURE = new Set([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA Program
  "ComputeBudget111111111111111111111111111111", // Compute Budget
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium V4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter V6
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // PumpFun
  "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP", // PumpSwap
]);

// ---- Helpers ----

/**
 * Compute per-owner token balance deltas from pre/post token balances.
 * Returns Map<owner, Map<mint, delta>> where delta = post - pre (in raw amount).
 */
function computeTokenDeltas(
  tx: RpcTransaction,
): Map<string, Map<string, bigint>> {
  const deltas = new Map<string, Map<string, bigint>>();
  if (!tx.meta) return deltas;

  const aggregateBalances = (
    balances:
      | {
          mint: string;
          owner?: string;
          uiTokenAmount: { amount: string };
        }[]
      | undefined,
  ): Map<string, Map<string, bigint>> => {
    const byOwner = new Map<string, Map<string, bigint>>();
    for (const tb of balances ?? []) {
      if (!tb.owner) continue;
      const owner = tb.owner;
      const mint = tb.mint;
      const amount = BigInt(tb.uiTokenAmount.amount);
      if (!byOwner.has(owner)) byOwner.set(owner, new Map());
      const mintMap = byOwner.get(owner)!;
      mintMap.set(mint, (mintMap.get(mint) ?? 0n) + amount);
    }
    return byOwner;
  };

  const preByOwner = aggregateBalances(tx.meta.preTokenBalances);
  const postByOwner = aggregateBalances(tx.meta.postTokenBalances);
  const allOwners = new Set<string>([
    ...preByOwner.keys(),
    ...postByOwner.keys(),
  ]);

  for (const owner of allOwners) {
    const preMints = preByOwner.get(owner) ?? new Map<string, bigint>();
    const postMints = postByOwner.get(owner) ?? new Map<string, bigint>();
    const allMints = new Set<string>([...preMints.keys(), ...postMints.keys()]);

    for (const mint of allMints) {
      const pre = preMints.get(mint) ?? 0n;
      const post = postMints.get(mint) ?? 0n;
      const delta = post - pre;
      if (delta === 0n) continue;
      if (!deltas.has(owner)) deltas.set(owner, new Map());
      deltas.get(owner)!.set(mint, delta);
    }
  }

  return deltas;
}

/**
 * Extract counterparties for the selected token mint only.
 */
function extractCounterparties(
  tx: RpcTransaction,
  holderAddr: string,
  holderSet: Set<string>,
  mint: string,
): Set<string> {
  const result = new Set<string>();
  if (!tx.meta) return result;

  const deltas = computeTokenDeltas(tx);
  const holderDelta = deltas.get(holderAddr)?.get(mint);
  if (holderDelta == null || holderDelta === 0n) return result;

  for (const [owner, ownerDeltas] of deltas) {
    if (owner === holderAddr) continue;
    if (!holderSet.has(owner) || INFRASTRUCTURE.has(owner)) continue;
    const otherDelta = ownerDeltas.get(mint);
    if (otherDelta == null || otherDelta === 0n) continue;
    if (
      (holderDelta < 0n && otherDelta > 0n) ||
      (holderDelta > 0n && otherDelta < 0n)
    ) {
      result.add(owner);
    }
  }

  return result;
}

// ---- Connection recording ----

interface RawEdge {
  txCount: number;
}

function recordConnection(
  edgeMap: Map<string, RawEdge>,
  from: string,
  to: string,
) {
  const [a, b] = from < to ? [from, to] : [to, from];
  const key = `${a}|${b}`;
  const existing = edgeMap.get(key);

  if (existing) {
    existing.txCount++;
  } else {
    edgeMap.set(key, { txCount: 1 });
  }
}

// ---- Hub detection ----

/**
 * Remove edges involving "hub" addresses — addresses connected to >25%
 * of all scanned holders. These are infrastructure (DEX pools, pool
 * authorities, program PDAs) that happen to be in the holder set, not
 * actual coordinated wallets.
 */
function filterHubs(
  edgeMap: Map<string, RawEdge>,
  directionSeen: Map<string, Set<string>>,
  totalHolders: number,
): void {
  const connectionCounts = new Map<string, number>();
  for (const key of edgeMap.keys()) {
    const [a, b] = key.split("|");
    connectionCounts.set(a, (connectionCounts.get(a) ?? 0) + 1);
    connectionCounts.set(b, (connectionCounts.get(b) ?? 0) + 1);
  }

  const hubThreshold = Math.max(5, Math.floor(totalHolders * 0.25));
  const hubs = new Set<string>();
  for (const [addr, count] of connectionCounts) {
    if (count > hubThreshold) hubs.add(addr);
  }

  if (hubs.size === 0) return;

  for (const key of [...edgeMap.keys()]) {
    const [a, b] = key.split("|");
    if (hubs.has(a) || hubs.has(b)) {
      edgeMap.delete(key);
      directionSeen.delete(key);
    }
  }
}

// ---- Cluster detection (connected components via BFS) ----

function detectClusters(
  connections: HolderConnection[],
  holders: TokenHolder[],
): HolderCluster[] {
  if (connections.length === 0) return [];

  const adj = new Map<string, Set<string>>();
  for (const c of connections) {
    if (!adj.has(c.source)) adj.set(c.source, new Set());
    if (!adj.has(c.target)) adj.set(c.target, new Set());
    adj.get(c.source)!.add(c.target);
    adj.get(c.target)!.add(c.source);
  }

  const visited = new Set<string>();
  const clusters: HolderCluster[] = [];
  let clusterId = 0;
  const pctMap = new Map(holders.map((h) => [h.owner, h.percentage]));

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;

    const members: string[] = [];
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (members.length >= 2) {
      const totalPct = members.reduce(
        (sum, m) => sum + (pctMap.get(m) ?? 0),
        0,
      );
      const memberSet = new Set(members);
      let connectionCount = 0;
      for (const c of connections) {
        if (memberSet.has(c.source) && memberSet.has(c.target)) {
          connectionCount++;
        }
      }

      clusters.push({
        id: clusterId++,
        members,
        totalPct,
        connectionCount,
      });
    }
  }

  clusters.sort((a, b) => b.totalPct - a.totalPct);
  return clusters;
}

// ---- Lightweight holder scanning ----

async function fetchHolderTxns(address: string): Promise<RpcTransaction[]> {
  const all: RpcTransaction[] = [];
  let paginationToken: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_HOLDER; page++) {
    const { txs, nextToken } = await gtfaPage(address, {
      sortOrder: "desc",
      paginationToken,
    });
    for (const tx of txs) {
      if (tx.meta?.err == null) all.push(tx);
    }
    if (!nextToken) break;
    paginationToken = nextToken;
  }

  return all;
}

// ---- Main scan function ----

async function _scanHolderConnections(
  mint: string,
  holders: TokenHolder[],
  topN: number,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanProgress> {
  const topHolders = holders.slice(0, topN);
  const holderSet = new Set(topHolders.map((h) => h.owner));
  const edgeMap = new Map<string, RawEdge>();
  const directionSeen = new Map<string, Set<string>>();

  const total = topHolders.length;

  for (let i = 0; i < topHolders.length; i++) {
    const holderAddr = topHolders[i].owner;

    try {
      const txns = await fetchHolderTxns(holderAddr);

      for (const tx of txns) {
        const counterparties = extractCounterparties(
          tx,
          holderAddr,
          holderSet,
          mint,
        );
        for (const party of counterparties) {
          recordConnection(edgeMap, holderAddr, party);
          const dirKey =
            holderAddr < party
              ? `${holderAddr}|${party}`
              : `${party}|${holderAddr}`;
          if (!directionSeen.has(dirKey))
            directionSeen.set(dirKey, new Set());
          directionSeen.get(dirKey)!.add(holderAddr);
        }
      }
    } catch {
      // Skip failed wallet scans
    }

    // Progress update (skip hub filter during progress for speed)
    const connections = buildConnections(edgeMap, directionSeen);
    const clusters = detectClusters(connections, holders);

    onProgress({
      scanned: i + 1,
      total,
      connections,
      clusters,
    });
  }

  // Final pass: remove hub nodes (infrastructure that connects to everyone)
  filterHubs(edgeMap, directionSeen, topHolders.length);

  const connections = buildConnections(edgeMap, directionSeen);
  const clusters = detectClusters(connections, holders);

  return { scanned: total, total, connections, clusters };
}

function buildConnections(
  edgeMap: Map<string, RawEdge>,
  directionSeen: Map<string, Set<string>>,
): HolderConnection[] {
  const connections: HolderConnection[] = [];

  for (const [key, edge] of edgeMap) {
    const [source, target] = key.split("|");
    const dirs = directionSeen.get(key);
    const bidirectional = (dirs?.size ?? 0) >= 2;

    connections.push({
      source,
      target,
      txCount: edge.txCount,
      bidirectional,
    });
  }

  return connections;
}

// ---- Public API ----

export async function scanHolderConnections(
  mint: string,
  holders: TokenHolder[],
  topN = 50,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanProgress> {
  const cacheKey = `${mint}:${holders
    .slice(0, topN)
    .map((h) => h.owner)
    .sort()
    .join(",")}`;

  return cached("hlConns5", cacheKey, TTL_CONNS, () =>
    _scanHolderConnections(mint, holders, topN, onProgress),
  );
}
