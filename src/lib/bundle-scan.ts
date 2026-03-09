import { gtfaPage, getTokenAccountAddressesByOwner } from "@/api";
import type { TokenHolder } from "@/birdeye-api";
import {
  computeOwnerMintDelta,
  findFirstOwnerMintAcquisition,
} from "@/lib/token-forensics";

export interface BundleScanProgress {
  scanned: number;
  total: number;
  bundleCount: number;
}

export interface BundleGroup {
  slot: number;
  members: string[];
  totalPct: number;
}

export interface BundleScanResult {
  firstAcquisitionSlots: Map<string, number>;
  bundles: BundleGroup[];
}

const MAX_PAGES_PER_SOURCE = 25;
const HOLDER_SCAN_CONCURRENCY = 10;
const SOURCE_SCAN_CONCURRENCY = 3;
const SLOT_WINDOW = 4;

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

async function findFirstAcquisitionInSource(
  address: string,
  owner: string,
  mint: string,
  walletFallback: boolean,
): Promise<number | null> {
  let paginationToken: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const { txs, nextToken } = await gtfaPage(address, {
      sortOrder: "asc",
      paginationToken,
      tokenAccountsMode: walletFallback ? "balanceChanged" : "none",
    });

    for (const tx of txs) {
      if (!tx.meta || tx.meta.err) continue;
      if (computeOwnerMintDelta(tx, owner, mint) <= 0n) continue;
      return tx.slot;
    }

    if (!nextToken) break;
    paginationToken = nextToken;
  }

  return null;
}

export async function findFirstAcquisitionSlot(
  wallet: string,
  mint: string,
): Promise<number | null> {
  const currentTokenAccounts = await getTokenAccountAddressesByOwner(wallet, mint).catch(
    () => [],
  );
  const candidateSlots: number[] = [];

  await withConcurrency(currentTokenAccounts, SOURCE_SCAN_CONCURRENCY, async (address) => {
    const slot = await findFirstAcquisitionInSource(address, wallet, mint, false);
    if (slot != null) candidateSlots.push(slot);
  });

  let paginationToken: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const { txs, nextToken } = await gtfaPage(wallet, {
      sortOrder: "asc",
      paginationToken,
      tokenAccountsMode: "balanceChanged",
    });
    const firstAcquisition = findFirstOwnerMintAcquisition(txs, wallet, mint);
    if (firstAcquisition) {
      candidateSlots.push(firstAcquisition.slot);
      break;
    }
    if (!nextToken) break;
    paginationToken = nextToken;
  }

  return candidateSlots.length > 0 ? Math.min(...candidateSlots) : null;
}

export async function scanBundles(
  mint: string,
  holders: TokenHolder[],
  topN = 100,
  onProgress?: (progress: BundleScanProgress) => void,
): Promise<BundleScanResult> {
  const targets = holders.slice(0, topN);
  const firstAcquisitionSlots = new Map<string, number>();
  let scanned = 0;

  await withConcurrency(targets, HOLDER_SCAN_CONCURRENCY, async (holder) => {
    try {
      const slot = await findFirstAcquisitionSlot(holder.owner, mint);
      if (slot != null) firstAcquisitionSlots.set(holder.owner, slot);
    } catch {
      // Skip acquisition lookup failures and continue.
    }

    scanned += 1;
    onProgress?.({
      scanned,
      total: targets.length,
      bundleCount: countBundles(firstAcquisitionSlots),
    });
  });

  const bundles = buildBundleGroups(firstAcquisitionSlots, holders);
  return { firstAcquisitionSlots, bundles };
}

function groupBySlotWindow(
  slots: Map<string, number>,
): { slot: number; members: string[] }[] {
  const entries = [...slots.entries()].sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) return [];

  const groups: { slot: number; members: string[] }[] = [];
  let currentGroup = { slot: entries[0][1], members: [entries[0][0]] };

  for (let i = 1; i < entries.length; i++) {
    const [address, slot] = entries[i];
    if (slot - currentGroup.slot <= SLOT_WINDOW) {
      currentGroup.members.push(address);
    } else {
      groups.push(currentGroup);
      currentGroup = { slot, members: [address] };
    }
  }

  groups.push(currentGroup);
  return groups;
}

function countBundles(slots: Map<string, number>): number {
  return groupBySlotWindow(slots).filter((group) => group.members.length >= 2).length;
}

function buildBundleGroups(
  slots: Map<string, number>,
  holders: TokenHolder[],
): BundleGroup[] {
  const pctMap = new Map(holders.map((holder) => [holder.owner, holder.percentage]));

  return groupBySlotWindow(slots)
    .filter((group) => group.members.length >= 2)
    .map((group) => ({
      slot: group.slot,
      members: group.members,
      totalPct: group.members.reduce(
        (sum, address) => sum + (pctMap.get(address) ?? 0),
        0,
      ),
    }))
    .sort((a, b) => b.members.length - a.members.length);
}
