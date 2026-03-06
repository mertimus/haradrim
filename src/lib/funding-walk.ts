import { getFunding, getBatchIdentity, getBatchSolDomains } from "@/api";
import { INFRASTRUCTURE } from "@/lib/scan-holder-connections";
import type { TokenHolder } from "@/birdeye-api";

// ---- Types ----

export interface FundingNode {
  address: string;
  depth: number; // 0 = holder, 1+ = ancestor
  amount: number; // SOL from funded-by
  label?: string;
  fundedBy?: string; // parent funder address
  children: string[]; // addresses this wallet funded
  isHolder: boolean; // original top-50 holder?
  holderPct?: number; // holder percentage (depth-0 only)
  holdersFunded: number; // how many original holders trace up to this
  holdersPctFunded: number; // sum of % of original holders funded
}

export interface FundingEdge {
  source: string; // funder
  target: string; // funded
  amount: number;
}

export interface FundingWalkProgress {
  phase: "walking" | "enriching";
  visited: number;
  queued: number;
  depth: number;
  commonFunders: number;
}

export interface FundingWalkResult {
  nodes: Map<string, FundingNode>;
  edges: FundingEdge[];
  commonFunders: FundingNode[]; // holdersFunded >= 2, sorted desc
}

// ---- Known exchanges — walk stops here (false convergence) ----

const KNOWN_EXCHANGES = new Set([
  "5tzFkiKscjHK98Up2w5Np8NErQ47rXiKzcEYTj9LRHGA", // Binance Hot 1
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance Hot 2
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", // Binance Hot 3
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", // Coinbase 1
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE", // Coinbase 2
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm", // Coinbase 3
  "4STBFnYVRCbSEGrcr5raMPH99QkHswD6K9YWfkroJmj2", // Kraken
  "6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51S3", // Bybit 1
  "AC5RDfQFmDS1deWZos921JfqscXdByf6BKHs5ACWjtW2", // Bybit 2
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ", // OKX
  "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq", // KuCoin
]);

// ---- Concurrency helper ----

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

// ---- Core walk ----


async function _walkFundingHistory(
  holders: TokenHolder[],
  maxDepth: number,
  concurrency: number,
  onProgress?: (p: FundingWalkProgress) => void,
): Promise<FundingWalkResult> {
  const nodes = new Map<string, FundingNode>();
  const edges: FundingEdge[] = [];
  const holderAddrs = new Set(holders.map((h) => h.owner));

  // Seed holders at depth 0
  for (const h of holders) {
    nodes.set(h.owner, {
      address: h.owner,
      depth: 0,
      amount: 0,
      label: h.label,
      children: [],
      isHolder: true,
      holderPct: h.percentage,
      holdersFunded: 0,
      holdersPctFunded: 0,
    });
  }

  // BFS by depth level
  let currentLevel = holders.map((h) => h.owner);

  for (let depth = 0; depth < maxDepth; depth++) {
    if (currentLevel.length === 0) break;

    const nextLevel: string[] = [];

    await withConcurrency(currentLevel, concurrency, async (addr) => {
      const funding = await getFunding(addr);
      if (!funding) return;

      const funderAddr = funding.address;

      // Skip infrastructure & exchanges
      if (INFRASTRUCTURE.has(funderAddr) || KNOWN_EXCHANGES.has(funderAddr)) return;

      // Add edge
      edges.push({
        source: funderAddr,
        target: addr,
        amount: funding.amount,
      });

      if (nodes.has(funderAddr)) {
        // Already visited — just record child link (convergence)
        const existing = nodes.get(funderAddr)!;
        if (!existing.children.includes(addr)) {
          existing.children.push(addr);
        }
      } else {
        // New node
        nodes.set(funderAddr, {
          address: funderAddr,
          depth: depth + 1,
          amount: funding.amount,
          label: funding.label,
          fundedBy: undefined, // will be set if we trace further
          children: [addr],
          isHolder: holderAddrs.has(funderAddr),
          holdersFunded: 0,
          holdersPctFunded: 0,
        });
        nextLevel.push(funderAddr);
      }

      // Record parent link on the child
      const childNode = nodes.get(addr)!;
      if (!childNode.fundedBy) {
        childNode.fundedBy = funderAddr;
      }
    });

    currentLevel = nextLevel;

    onProgress?.({
      phase: "walking",
      visited: nodes.size,
      queued: currentLevel.length,
      depth: depth + 1,
      commonFunders: 0,
    });
  }

  // Post-process: compute holdersFunded via reverse walk from each holder
  for (const holderAddr of holderAddrs) {
    const visited = new Set<string>();
    let current = holderAddr;
    while (current) {
      if (visited.has(current)) break;
      visited.add(current);
      const node = nodes.get(current);
      if (!node) break;
      if (current !== holderAddr) {
        node.holdersFunded++;
      }
      current = node.fundedBy!;
    }
  }

  // Also count via edges for convergence paths not captured by single fundedBy
  // Build adjacency: target → set of sources (funders)
  const funderOf = new Map<string, Set<string>>(); // funded → set of funders
  for (const e of edges) {
    if (!funderOf.has(e.target)) funderOf.set(e.target, new Set());
    funderOf.get(e.target)!.add(e.source);
  }

  // BFS from each holder upward through all funder paths
  const holderReach = new Map<string, Set<string>>(); // node → set of original holders it reaches
  for (const node of nodes.values()) {
    holderReach.set(node.address, new Set());
  }
  for (const holderAddr of holderAddrs) {
    const bfsQueue = [holderAddr];
    const bfsVisited = new Set<string>();
    while (bfsQueue.length > 0) {
      const addr = bfsQueue.shift()!;
      if (bfsVisited.has(addr)) continue;
      bfsVisited.add(addr);
      holderReach.get(addr)?.add(holderAddr);
      // Walk up: find all funders of this address
      const funders = funderOf.get(addr);
      if (funders) {
        for (const f of funders) {
          if (!bfsVisited.has(f)) bfsQueue.push(f);
        }
      }
    }
  }

  // Update holdersFunded + holdersPctFunded from holderReach
  for (const [addr, reachedHolders] of holderReach) {
    const node = nodes.get(addr);
    if (node && !node.isHolder) {
      node.holdersFunded = reachedHolders.size;
      node.holdersPctFunded = [...reachedHolders].reduce((sum, h) => {
        const hn = nodes.get(h);
        return sum + (hn?.holderPct ?? 0);
      }, 0);
    }
  }

  // Extract common funders
  const commonFunders = Array.from(nodes.values())
    .filter((n) => n.holdersFunded >= 2 && !n.isHolder)
    .sort((a, b) => b.holdersFunded - a.holdersFunded);

  onProgress?.({
    phase: "enriching",
    visited: nodes.size,
    queued: 0,
    depth: maxDepth,
    commonFunders: commonFunders.length,
  });

  // Enrich labels for common funders + their neighbors
  const toEnrich = new Set<string>();
  for (const cf of commonFunders) {
    toEnrich.add(cf.address);
    for (const child of cf.children) toEnrich.add(child);
    if (cf.fundedBy) toEnrich.add(cf.fundedBy);
  }
  // Remove already-labeled addresses
  for (const addr of toEnrich) {
    const n = nodes.get(addr);
    if (n?.label) toEnrich.delete(addr);
  }

  if (toEnrich.size > 0) {
    const enrichAddrs = Array.from(toEnrich);
    const [identityResult, snsResult] = await Promise.allSettled([
      getBatchIdentity(enrichAddrs),
      getBatchSolDomains(enrichAddrs),
    ]);

    const identityMap =
      identityResult.status === "fulfilled"
        ? identityResult.value
        : new Map<string, { name?: string }>();
    const snsMap =
      snsResult.status === "fulfilled"
        ? snsResult.value
        : new Map<string, string>();

    for (const addr of enrichAddrs) {
      const node = nodes.get(addr);
      if (!node || node.label) continue;
      const id = identityMap.get(addr);
      const sns = snsMap.get(addr);
      if (id?.name) node.label = id.name;
      else if (sns) node.label = sns;
    }
  }

  return { nodes, edges, commonFunders };
}

export function walkFundingHistory(
  holders: TokenHolder[],
  maxDepth = 10,
  concurrency = 8,
  onProgress?: (p: FundingWalkProgress) => void,
): Promise<FundingWalkResult> {
  return _walkFundingHistory(holders, maxDepth, concurrency, onProgress);
}
