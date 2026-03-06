import { PublicKey } from "@solana/web3.js";
import { gtfaPage } from "@/api";
import type { TokenHolder } from "@/birdeye-api";

// ---- ATA derivation ----

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function deriveAta(wallet: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [wallet.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata;
}

// ---- Types ----

export interface BundleScanProgress {
  scanned: number;
  total: number;
  bundleCount: number;
}

export interface BundleGroup {
  slot: number;
  members: string[];   // holder addresses
  totalPct: number;    // combined % of bundle members
}

export interface BundleScanResult {
  firstBuySlots: Map<string, number>;  // address → slot
  bundles: BundleGroup[];              // groups with 2+ members
}

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

// ---- Core logic ----

/**
 * Find the first transaction slot where `wallet` interacted with `mint`.
 * Strategy: scan the ATA's transactions ascending — the first tx IS the first buy.
 * Falls back to wallet scan if ATA has no results (non-ATA token accounts).
 */
export async function findFirstBuySlot(
  wallet: string,
  mint: string,
): Promise<number | null> {
  const walletPk = new PublicKey(wallet);
  const mintPk = new PublicKey(mint);

  // Try both token programs (SPL Token and Token-2022)
  for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const ata = deriveAta(walletPk, mintPk, tokenProgram);
    const { txs } = await gtfaPage(ata.toBase58(), { sortOrder: "asc" });
    if (txs.length > 0) {
      return txs[0].slot;
    }
  }

  // Fallback: scan wallet transactions (for non-ATA token accounts)
  const { txs } = await gtfaPage(wallet, { sortOrder: "asc" });
  for (const tx of txs) {
    const balances = tx.meta?.postTokenBalances;
    if (!balances) continue;
    for (const bal of balances) {
      if (bal.mint === mint) {
        return tx.slot;
      }
    }
  }

  return null;
}

/**
 * Scan top-N holders for their first buy slot and group bundles.
 */
export async function scanBundles(
  mint: string,
  holders: TokenHolder[],
  topN = 100,
  onProgress?: (p: BundleScanProgress) => void,
): Promise<BundleScanResult> {
  const targets = holders.slice(0, topN);
  const firstBuySlots = new Map<string, number>();
  let scanned = 0;

  await withConcurrency(targets, 10, async (holder) => {
    try {
      const slot = await findFirstBuySlot(holder.owner, mint);
      if (slot != null) {
        firstBuySlots.set(holder.owner, slot);
      }
    } catch {
      // skip on error
    }
    scanned++;
    onProgress?.({
      scanned,
      total: targets.length,
      bundleCount: countBundles(firstBuySlots),
    });
  });

  const bundles = buildBundleGroups(firstBuySlots, holders);
  return { firstBuySlots, bundles };
}

// ---- Helpers ----

const SLOT_WINDOW = 4;

/**
 * Group holders whose first-buy slots are within SLOT_WINDOW of each other.
 * Sweep sorted entries — start a new group when gap > SLOT_WINDOW.
 */
function groupBySlotWindow(
  slots: Map<string, number>,
): { slot: number; members: string[] }[] {
  const entries = [...slots.entries()].sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) return [];

  const groups: { slot: number; members: string[] }[] = [];
  let currentGroup = { slot: entries[0][1], members: [entries[0][0]] };

  for (let i = 1; i < entries.length; i++) {
    const [addr, slot] = entries[i];
    if (slot - currentGroup.slot <= SLOT_WINDOW) {
      currentGroup.members.push(addr);
    } else {
      groups.push(currentGroup);
      currentGroup = { slot, members: [addr] };
    }
  }
  groups.push(currentGroup);
  return groups;
}

function countBundles(slots: Map<string, number>): number {
  return groupBySlotWindow(slots).filter((g) => g.members.length >= 2).length;
}

function buildBundleGroups(
  slots: Map<string, number>,
  holders: TokenHolder[],
): BundleGroup[] {
  const raw = groupBySlotWindow(slots);

  // Build percentage lookup
  const pctMap = new Map<string, number>();
  for (const h of holders) {
    pctMap.set(h.owner, h.percentage);
  }

  // Filter to groups with 2+ members, sort by member count desc
  const groups: BundleGroup[] = [];
  for (const { slot, members } of raw) {
    if (members.length < 2) continue;
    const totalPct = members.reduce((s, a) => s + (pctMap.get(a) ?? 0), 0);
    groups.push({ slot, members, totalPct });
  }

  groups.sort((a, b) => b.members.length - a.members.length);
  return groups;
}
