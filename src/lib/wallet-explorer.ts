import type { WalletIdentity } from "@/api";
import type { CounterpartyFlow, OverlayWallet } from "@/lib/parse-transactions";

export interface WalletFilter {
  minVolume: number;
  minTxCount: number;
  netThreshold: number;
}

export interface GraphTypeFilter {
  wallet: boolean;
  token: boolean;
  program: boolean;
}

export const DEFAULT_GRAPH_TYPE_FILTER: GraphTypeFilter = {
  wallet: true,
  token: true,
  program: true,
};

export type GraphPreset =
  | "overview"
  | "outflows"
  | "inflows"
  | "mutuals"
  | "active30d"
  | "new30d";

export type GraphScopeFilter = "all" | "mutuals" | "active30d" | "new30d";

export interface WalletStats {
  maxVolume: number;
  maxTxCount: number;
  minNet: number;
  maxNet: number;
  totalCount: number;
  filteredCount: number;
}

export interface PerSourceStats {
  txCount: number;
  solSent: number;
  solReceived: number;
}

export interface CounterpartyDisplay extends CounterpartyFlow {
  walletColors?: string[];
  connectionScore?: number;
  sourceStats?: Map<string, PerSourceStats>;
}

export interface ComparisonWallet {
  address: string;
  label: string;
  color: string;
  role: "Primary" | "Overlay";
  counterparties: CounterpartyFlow[];
}

export interface SharedFunder {
  overlayAddress: string;
  funderAddress: string;
  funderLabel?: string;
}

export interface WalletInsight {
  id: string;
  title: string;
  value: string;
  description: string;
  accentColor: string;
  address?: string;
  preset?: GraphPreset;
}

export const THIRTY_DAY_WINDOW_SECONDS = 30 * 86400;

export function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export function describeCounterparty(cp: CounterpartyFlow): string {
  return cp.label ?? cp.tokenSymbol ?? cp.tokenName ?? truncAddr(cp.address);
}

export function describeWallet(address: string, identity: WalletIdentity | null | undefined): string {
  return identity?.label ?? identity?.name ?? truncAddr(address);
}

function isAddressFallbackLabel(label: string, address: string): boolean {
  return label === address
    || label === `${address.slice(0, 3)}...${address.slice(-3)}`
    || label === `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function shouldUseIdentityLabel(
  currentLabel: string | undefined,
  identityLabel: string | undefined,
  address: string,
): boolean {
  if (!identityLabel) return false;
  if (!currentLabel) return true;
  if (currentLabel === identityLabel) return false;
  if (isAddressFallbackLabel(currentLabel, address)) return true;
  if (!currentLabel.toLowerCase().endsWith(".sol") && identityLabel.toLowerCase().endsWith(".sol")) {
    return true;
  }
  return false;
}

export function applyCounterpartyIdentityOverrides<T extends CounterpartyFlow>(
  counterparties: T[],
  identityByAddress: Map<string, WalletIdentity | null>,
): T[] {
  if (identityByAddress.size === 0) return counterparties;

  let changed = false;
  const next = counterparties.map((cp) => {
    const identity = identityByAddress.get(cp.address);
    if (!identity) return cp;

    const identityLabel = identity.label ?? identity.name;
    const label = shouldUseIdentityLabel(cp.label, identityLabel, cp.address)
      ? identityLabel
      : cp.label;
    const category = cp.category ?? identity.category;
    if (label === cp.label && category === cp.category) return cp;

    changed = true;
    return {
      ...cp,
      label,
      category,
    };
  });

  return changed ? next : counterparties;
}

export function applyWalletFilter(
  counterparties: CounterpartyFlow[],
  filter: WalletFilter | undefined,
): CounterpartyFlow[] {
  if (!filter) return counterparties;
  return counterparties.filter((cp) =>
    (filter.minVolume <= 0 || cp.solSent + cp.solReceived >= filter.minVolume)
    && (filter.minTxCount <= 0 || cp.txCount >= filter.minTxCount)
    && (
      filter.netThreshold === 0
      || (filter.netThreshold > 0 ? cp.solNet >= filter.netThreshold : cp.solNet <= filter.netThreshold)
    ),
  );
}

export function computeWalletStats(
  counterparties: CounterpartyFlow[],
  filter: WalletFilter | undefined,
): WalletStats {
  let maxVolume = 0;
  let maxTxCount = 0;
  let minNet = 0;
  let maxNet = 0;
  let filteredCount = 0;

  const hasFilter = filter && (filter.minVolume > 0 || filter.minTxCount > 0 || filter.netThreshold !== 0);

  for (const cp of counterparties) {
    maxVolume = Math.max(maxVolume, cp.solSent + cp.solReceived);
    maxTxCount = Math.max(maxTxCount, cp.txCount);
    minNet = Math.min(minNet, cp.solNet);
    maxNet = Math.max(maxNet, cp.solNet);
    if (!hasFilter
      || ((filter.minVolume <= 0 || cp.solSent + cp.solReceived >= filter.minVolume)
        && (filter.minTxCount <= 0 || cp.txCount >= filter.minTxCount)
        && (filter.netThreshold === 0
          || (filter.netThreshold > 0 ? cp.solNet >= filter.netThreshold : cp.solNet <= filter.netThreshold)))) {
      filteredCount++;
    }
  }

  return {
    maxVolume,
    maxTxCount,
    minNet,
    maxNet,
    totalCount: counterparties.length,
    filteredCount,
  };
}

export function formatSolCompact(sol: number): string {
  if (Math.abs(sol) < 0.001) return "<0.001 SOL";
  if (Math.abs(sol) >= 1000) {
    return `${sol.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOL`;
  }
  return `${sol.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} SOL`;
}

export function formatDateCompact(ts: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function filterCounterpartiesByGraphScope(
  counterparties: CounterpartyFlow[],
  scope: GraphScopeFilter,
  sharedAddresses: Set<string>,
  nowTs: number,
): CounterpartyFlow[] {
  if (scope === "all") return counterparties;
  if (scope === "mutuals") {
    return counterparties.filter((cp) => sharedAddresses.has(cp.address));
  }
  if (scope === "active30d") {
    const cutoff = nowTs - THIRTY_DAY_WINDOW_SECONDS;
    return counterparties.filter((cp) => cp.lastSeen >= cutoff);
  }
  const cutoff = nowTs - THIRTY_DAY_WINDOW_SECONDS;
  return counterparties.filter((cp) => cp.firstSeen >= cutoff);
}

export function sortCounterpartiesByTableOrder<T extends CounterpartyFlow>(
  counterparties: T[],
  rankByAddress: Map<string, number>,
): T[] {
  return [...counterparties].sort((a, b) => {
    const rankA = rankByAddress.get(a.address) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rankByAddress.get(b.address) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

function computeConnectionScore(
  walletCount: number,
  totalVolume: number,
  totalTxCount: number,
  multiWalletRecent: boolean,
): number {
  return (
    walletCount * 2.0
    + Math.log(1 + totalVolume) * 0.3
    + Math.log(1 + totalTxCount) * 0.2
    + (multiWalletRecent ? 0.5 : 0)
  );
}

export function mergeDisplayCounterparties(
  filteredCounterparties: CounterpartyFlow[],
  filteredOverlayWallets: OverlayWallet[],
  address: string,
  walletColors: string[],
): CounterpartyDisplay[] {
  const readyOverlays = filteredOverlayWallets.filter((ow) => !ow.loading && !ow.error);
  if (readyOverlays.length === 0) {
    return filteredCounterparties.map((cp) => ({
      ...cp,
      walletColors: [walletColors[0]],
    }));
  }

  const hubAddresses = new Set([address, ...readyOverlays.map((overlay) => overlay.address)]);
  const recentCutoff = Math.floor(Date.now() / 1000) - THIRTY_DAY_WINDOW_SECONDS;

  interface MergedEntry extends CounterpartyDisplay {
    sourceIndices: number[];
    sourceStats: Map<string, PerSourceStats>;
  }

  const merged = new Map<string, MergedEntry>();

  for (const cp of filteredCounterparties) {
    if (hubAddresses.has(cp.address)) continue;
    merged.set(cp.address, {
      ...cp,
      sourceIndices: [0],
      walletColors: [],
      sourceStats: new Map([[address, { txCount: cp.txCount, solSent: cp.solSent, solReceived: cp.solReceived }]]),
    });
  }

  for (let i = 0; i < readyOverlays.length; i++) {
    const overlay = readyOverlays[i];
    const colorIdx = i + 1;
    for (const cp of overlay.counterparties) {
      if (hubAddresses.has(cp.address)) continue;
      const existing = merged.get(cp.address);
      if (existing) {
        existing.txCount += cp.txCount;
        existing.solSent += cp.solSent;
        existing.solReceived += cp.solReceived;
        existing.solNet = existing.solReceived - existing.solSent;
        existing.firstSeen = Math.min(existing.firstSeen, cp.firstSeen);
        existing.lastSeen = Math.max(existing.lastSeen, cp.lastSeen);
        if (!existing.label && cp.label) existing.label = cp.label;
        if (!existing.sourceIndices.includes(colorIdx)) {
          existing.sourceIndices.push(colorIdx);
        }
        existing.sourceStats.set(overlay.address, {
          txCount: cp.txCount,
          solSent: cp.solSent,
          solReceived: cp.solReceived,
        });
      } else {
        merged.set(cp.address, {
          ...cp,
          sourceIndices: [colorIdx],
          walletColors: [],
          sourceStats: new Map([[overlay.address, {
            txCount: cp.txCount,
            solSent: cp.solSent,
            solReceived: cp.solReceived,
          }]]),
        });
      }
    }
  }

  return Array.from(merged.values()).map((cp) => {
    const walletCount = cp.sourceIndices.length;
    const totalVolume = cp.solSent + cp.solReceived;
    const multiWalletRecent = walletCount > 1 && cp.lastSeen >= recentCutoff;
    return {
      ...cp,
      walletColors: cp.sourceIndices.map((index) => walletColors[index]),
      connectionScore: computeConnectionScore(walletCount, totalVolume, cp.txCount, multiWalletRecent),
      sourceStats: cp.sourceStats,
    };
  });
}

export function buildWalletInsights(params: {
  enrichedAllTimeCounterparties: CounterpartyFlow[];
  filteredCounterparties: CounterpartyFlow[];
  sharedComparisonCount: number;
  sharedFunders: SharedFunder[];
  strongestSharedCounterparty: CounterpartyDisplay | null;
}): WalletInsight[] {
  const {
    enrichedAllTimeCounterparties,
    filteredCounterparties,
    sharedComparisonCount,
    sharedFunders,
    strongestSharedCounterparty,
  } = params;
  const historicalCounterparties = enrichedAllTimeCounterparties.length > 0
    ? enrichedAllTimeCounterparties
    : filteredCounterparties;
  let byOutflow: CounterpartyFlow | undefined;
  let byInflow: CounterpartyFlow | undefined;
  for (const cp of filteredCounterparties) {
    if (cp.solSent > 0 && (!byOutflow || cp.solSent > byOutflow.solSent)) byOutflow = cp;
    if (cp.solReceived > 0 && (!byInflow || cp.solReceived > byInflow.solReceived)) byInflow = cp;
  }
  let byOldest: CounterpartyFlow | undefined;
  let byNewest: CounterpartyFlow | undefined;
  for (const cp of historicalCounterparties) {
    if (cp.firstSeen > 0) {
      if (!byOldest || cp.firstSeen < byOldest.firstSeen) byOldest = cp;
      if (!byNewest || cp.firstSeen > byNewest.firstSeen) byNewest = cp;
    }
  }

  return [
    byOutflow
      ? {
          id: "largest-outflow",
          title: "Largest Outflow",
          value: describeCounterparty(byOutflow),
          description: `${formatSolCompact(byOutflow.solSent)} sent across ${byOutflow.txCount.toLocaleString()} tx`,
          accentColor: "#ff2d2d",
          address: byOutflow.address,
          preset: "outflows",
        }
      : {
          id: "largest-outflow",
          title: "Largest Outflow",
          value: "No direct outflows",
          description: "Nothing in the current wallet view has outgoing volume.",
          accentColor: "#ff2d2d",
          preset: "outflows",
        },
    byInflow
      ? {
          id: "largest-inflow",
          title: "Largest Inflow",
          value: describeCounterparty(byInflow),
          description: `${formatSolCompact(byInflow.solReceived)} received across ${byInflow.txCount.toLocaleString()} tx`,
          accentColor: "#00ff88",
          address: byInflow.address,
          preset: "inflows",
        }
      : {
          id: "largest-inflow",
          title: "Largest Inflow",
          value: "No direct inflows",
          description: "Nothing in the current wallet view has incoming volume.",
          accentColor: "#00ff88",
          preset: "inflows",
        },
    sharedFunders.length > 0
      ? {
          id: "shared-funder",
          title: "Shared Funder",
          value: sharedFunders[0].funderLabel ?? truncAddr(sharedFunders[0].funderAddress),
          description: `${sharedFunders.length + 1} wallets funded by same source`,
          accentColor: "#ff2d2d",
          address: sharedFunders[0].funderAddress,
        }
      : sharedComparisonCount > 0 && strongestSharedCounterparty
        ? {
            id: "mutual-overlap",
            title: "Mutual Overlap",
            value: `${sharedComparisonCount.toLocaleString()} shared`,
            description: `Strongest overlap: ${describeCounterparty(strongestSharedCounterparty)}`,
            accentColor: "#00d4ff",
            address: strongestSharedCounterparty.address,
            preset: "mutuals",
          }
        : byOldest
          ? {
              id: "oldest-relationship",
              title: "Oldest Relationship",
              value: describeCounterparty(byOldest),
              description: `Active since ${formatDateCompact(byOldest.firstSeen)}`,
              accentColor: "#ffb800",
              address: byOldest.address,
            }
          : {
              id: "oldest-relationship",
              title: "Oldest Relationship",
              value: "No history yet",
              description: "The current view has no dated counterparties.",
              accentColor: "#ffb800",
            },
    byNewest
      ? {
          id: "newest-counterparty",
          title: "Newest Counterparty",
          value: describeCounterparty(byNewest),
          description: `First seen ${formatDateCompact(byNewest.firstSeen)}`,
          accentColor: "#a855f7",
          address: byNewest.address,
          preset: "new30d",
        }
      : {
          id: "newest-counterparty",
          title: "Newest Counterparty",
          value: "No new counterparties",
          description: "No counterparties are available in the current view.",
          accentColor: "#a855f7",
          preset: "new30d",
        },
  ];
}
