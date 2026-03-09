import {
  gtfaPage,
  getTokenAccountAddressesByOwner,
  type RpcTransaction,
} from "@/api";
import { cached } from "@/lib/cache";
import type { TokenHolder } from "@/birdeye-api";
import { extractOwnerMintTransfers } from "@/lib/token-forensics";

export interface HolderConnection {
  source: string;
  target: string;
  txCount: number;
  bidirectional: boolean;
  sourceToTargetTxCount: number;
  targetToSourceTxCount: number;
  firstSeen: number;
  lastSeen: number;
  evidenceScore: number;
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

const TTL_CONNS = 15 * 60 * 1000;
const MAX_PAGES_PER_SOURCE = 25;
const HOLDER_SCAN_CONCURRENCY = 6;
const SOURCE_SCAN_CONCURRENCY = 3;
const MIN_CLUSTER_EVIDENCE_SCORE = 2;

export const INFRASTRUCTURE = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP",
]);

interface RawEdge {
  signatures: Set<string>;
  forwardSignatures: Set<string>;
  reverseSignatures: Set<string>;
  firstSeen: number | null;
  lastSeen: number | null;
}

async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function fetchHistorySourceTxns(
  address: string,
  walletFallback: boolean,
): Promise<RpcTransaction[]> {
  const txMap = new Map<string, RpcTransaction>();
  let paginationToken: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const { txs, nextToken } = await gtfaPage(address, {
      sortOrder: "desc",
      paginationToken,
      tokenAccountsMode: walletFallback ? "balanceChanged" : "none",
    });

    for (const tx of txs) {
      if (tx.meta?.err != null) continue;
      const signature = tx.transaction.signatures[0];
      if (!signature || txMap.has(signature)) continue;
      txMap.set(signature, tx);
    }

    if (!nextToken) break;
    paginationToken = nextToken;
  }

  return [...txMap.values()];
}

async function fetchHolderTxns(
  holderAddr: string,
  mint: string,
): Promise<RpcTransaction[]> {
  const sources = await getTokenAccountAddressesByOwner(holderAddr, mint);
  const effectiveSources = [
    ...sources.map((address) => ({ address, walletFallback: false })),
    { address: holderAddr, walletFallback: true },
  ];

  const txMap = new Map<string, RpcTransaction>();
  await withConcurrency(effectiveSources, SOURCE_SCAN_CONCURRENCY, async (source) => {
    const txs = await fetchHistorySourceTxns(source.address, source.walletFallback);
    for (const tx of txs) {
      const signature = tx.transaction.signatures[0];
      if (!signature || txMap.has(signature)) continue;
      txMap.set(signature, tx);
    }
  });

  return [...txMap.values()];
}

function recordConnection(
  edgeMap: Map<string, RawEdge>,
  source: string,
  target: string,
  signature: string,
  timestamp: number,
): void {
  const [a, b] = source < target ? [source, target] : [target, source];
  const key = `${a}|${b}`;
  const existing =
    edgeMap.get(key)
    ?? {
      signatures: new Set<string>(),
      forwardSignatures: new Set<string>(),
      reverseSignatures: new Set<string>(),
      firstSeen: null,
      lastSeen: null,
    };

  existing.signatures.add(signature);
  if (source === a && target === b) existing.forwardSignatures.add(signature);
  else existing.reverseSignatures.add(signature);

  if (existing.firstSeen == null || timestamp < existing.firstSeen) {
    existing.firstSeen = timestamp;
  }
  if (existing.lastSeen == null || timestamp > existing.lastSeen) {
    existing.lastSeen = timestamp;
  }

  edgeMap.set(key, existing);
}

function buildConnections(edgeMap: Map<string, RawEdge>): HolderConnection[] {
  const connections: HolderConnection[] = [];

  for (const [key, edge] of edgeMap) {
    const [a, b] = key.split("|");
    const forwardTxCount = edge.forwardSignatures.size;
    const reverseTxCount = edge.reverseSignatures.size;
    const txCount = edge.signatures.size;
    const bidirectional = forwardTxCount > 0 && reverseTxCount > 0;
    const preferForward = forwardTxCount >= reverseTxCount;

    connections.push({
      source: preferForward ? a : b,
      target: preferForward ? b : a,
      txCount,
      bidirectional,
      sourceToTargetTxCount: preferForward ? forwardTxCount : reverseTxCount,
      targetToSourceTxCount: preferForward ? reverseTxCount : forwardTxCount,
      firstSeen: edge.firstSeen ?? 0,
      lastSeen: edge.lastSeen ?? 0,
      evidenceScore: txCount + (bidirectional ? 1 : 0),
    });
  }

  connections.sort((a, b) => {
    if (b.evidenceScore !== a.evidenceScore) return b.evidenceScore - a.evidenceScore;
    if (b.txCount !== a.txCount) return b.txCount - a.txCount;
    return b.lastSeen - a.lastSeen;
  });

  return connections;
}

function detectClusters(
  connections: HolderConnection[],
  holders: TokenHolder[],
): HolderCluster[] {
  const strongConnections = connections.filter(
    (connection) => connection.evidenceScore >= MIN_CLUSTER_EVIDENCE_SCORE,
  );
  if (strongConnections.length === 0) return [];

  const adj = new Map<string, Set<string>>();
  for (const connection of strongConnections) {
    if (!adj.has(connection.source)) adj.set(connection.source, new Set());
    if (!adj.has(connection.target)) adj.set(connection.target, new Set());
    adj.get(connection.source)!.add(connection.target);
    adj.get(connection.target)!.add(connection.source);
  }

  const pctMap = new Map(holders.map((holder) => [holder.owner, holder.percentage]));
  const visited = new Set<string>();
  const clusters: HolderCluster[] = [];
  let clusterId = 0;

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;

    const members: string[] = [];
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    if (members.length < 2) continue;

    const memberSet = new Set(members);
    const totalPct = members.reduce((sum, member) => sum + (pctMap.get(member) ?? 0), 0);
    const connectionCount = strongConnections.filter(
      (connection) =>
        memberSet.has(connection.source) && memberSet.has(connection.target),
    ).length;

    clusters.push({
      id: clusterId++,
      members,
      totalPct,
      connectionCount,
    });
  }

  clusters.sort((a, b) => b.totalPct - a.totalPct);
  return clusters;
}

async function _scanHolderConnections(
  mint: string,
  holders: TokenHolder[],
  topN: number,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanProgress> {
  const topHolders = holders.slice(0, topN);
  const holderSet = new Set(topHolders.map((holder) => holder.owner));
  const edgeMap = new Map<string, RawEdge>();
  let scanned = 0;

  await withConcurrency(topHolders, HOLDER_SCAN_CONCURRENCY, async (holder) => {
    if (!INFRASTRUCTURE.has(holder.owner)) {
      try {
        const txs = await fetchHolderTxns(holder.owner, mint);
        const transfers = extractOwnerMintTransfers(
          txs,
          holder.owner,
          mint,
          holderSet,
        );

        for (const transfer of transfers) {
          if (
            INFRASTRUCTURE.has(transfer.source)
            || INFRASTRUCTURE.has(transfer.target)
          ) {
            continue;
          }
          recordConnection(
            edgeMap,
            transfer.source,
            transfer.target,
            transfer.signature,
            transfer.timestamp,
          );
        }
      } catch {
        // Skip failed holder scans and continue the forensic sweep.
      }
    }

    scanned += 1;
    const connections = buildConnections(edgeMap);
    const clusters = detectClusters(connections, holders);
    onProgress({
      scanned,
      total: topHolders.length,
      connections,
      clusters,
    });
  });

  const connections = buildConnections(edgeMap);
  const clusters = detectClusters(connections, holders);
  return { scanned: topHolders.length, total: topHolders.length, connections, clusters };
}

export async function scanHolderConnections(
  mint: string,
  holders: TokenHolder[],
  topN = 50,
  onProgress: (progress: ScanProgress) => void,
): Promise<ScanProgress> {
  const cacheKey = `${mint}:${topN}:${holders
    .slice(0, topN)
    .map((holder) => `${holder.owner}:${holder.percentage.toFixed(8)}`)
    .sort()
    .join(",")}`;

  return cached("hlConns7", cacheKey, TTL_CONNS, () =>
    _scanHolderConnections(mint, holders, topN, onProgress),
  );
}
