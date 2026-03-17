export type TraceDirection = "inflow" | "outflow";
export type TraceAssetKind = "native" | "token";
export type TraceAssetKindFilter = "all" | TraceAssetKind;

export const NATIVE_SOL_ASSET_ID = "native:sol";
export const TRACE_ALL_ASSETS = "__all_assets__";

export interface TraceAssetFlow {
  assetId: string;
  kind: TraceAssetKind;
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals: number;
  rawAmount: string;
  uiAmount: number;
  transferCount: number;
  txCount: number;
}

export interface TraceTransferEvent {
  signature: string;
  timestamp: number;
  direction: TraceDirection;
  counterparty: string;
  counterpartyLabel?: string;
  counterpartyCategory?: string;
  counterpartyAccountType?: string;
  assetId: string;
  kind: TraceAssetKind;
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals: number;
  rawAmount: string;
  uiAmount: number;
}

export interface TraceAssetOption {
  assetId: string;
  kind: TraceAssetKind;
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals: number;
  transferCount: number;
  txCount: number;
  uiAmount: number;
}

export interface TraceCounterparty {
  address: string;
  txCount: number;
  transferCount: number;
  inflowTxCount: number;
  outflowTxCount: number;
  inflowTransferCount: number;
  outflowTransferCount: number;
  firstSeen: number;
  lastSeen: number;
  inflowAssets: TraceAssetFlow[];
  outflowAssets: TraceAssetFlow[];
  label?: string;
  category?: string;
  accountType?: string;
}

export interface TraceNodeFlows {
  address: string;
  events: TraceTransferEvent[];
  assets: TraceAssetOption[];
  firstSeen: number;
  lastSeen: number;
  metadataPending: boolean;
}

export interface TraceFlowFilters {
  minAmount: string;
  maxAmount: string;
  dateFrom: string;
  dateTo: string;
  assetKind: TraceAssetKindFilter;
  assetId: string;
}

export const DEFAULT_TRACE_FLOW_FILTERS: TraceFlowFilters = {
  minAmount: "",
  maxAmount: "",
  dateFrom: "",
  dateTo: "",
  assetKind: "all",
  assetId: TRACE_ALL_ASSETS,
};

interface MutableTraceAssetFlow {
  assetId: string;
  kind: TraceAssetKind;
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals: number;
  rawAmount: bigint;
  uiAmount: number;
  transferCount: number;
  txCount: number;
}

interface MutableTraceCounterparty {
  txCount: number;
  transferCount: number;
  inflowTxCount: number;
  outflowTxCount: number;
  inflowTransferCount: number;
  outflowTransferCount: number;
  firstSeen: number;
  lastSeen: number;
  inflowAssets: Map<string, MutableTraceAssetFlow>;
  outflowAssets: Map<string, MutableTraceAssetFlow>;
  label?: string;
  category?: string;
  accountType?: string;
}

function bigintToUiAmount(rawAmount: bigint, decimals: number): number {
  if (decimals <= 0) return Number(rawAmount);
  const negative = rawAmount < 0n;
  const value = negative ? -rawAmount : rawAmount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const normalized = fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
  const parsed = Number(negative ? `-${normalized}` : normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function initTraceCounterpartyEntry(timestamp: number): MutableTraceCounterparty {
  const ts = timestamp > 0 ? timestamp : 0;
  return {
    txCount: 0,
    transferCount: 0,
    inflowTxCount: 0,
    outflowTxCount: 0,
    inflowTransferCount: 0,
    outflowTransferCount: 0,
    firstSeen: ts,
    lastSeen: ts,
    inflowAssets: new Map(),
    outflowAssets: new Map(),
  };
}

function upsertTraceAssetFlow(
  assetMap: Map<string, MutableTraceAssetFlow>,
  directionTxSeen: Set<string>,
  event: TraceTransferEvent,
  txKey: string,
): void {
  const amountRaw = BigInt(event.rawAmount);
  const existing = assetMap.get(event.assetId) ?? {
    assetId: event.assetId,
    kind: event.kind,
    mint: event.mint,
    symbol: event.symbol,
    name: event.name,
    logoUri: event.logoUri,
    decimals: event.decimals,
    rawAmount: 0n,
    uiAmount: 0,
    transferCount: 0,
    txCount: 0,
  };
  existing.rawAmount += amountRaw;
  existing.uiAmount = bigintToUiAmount(existing.rawAmount, existing.decimals);
  existing.transferCount += 1;
  if (!directionTxSeen.has(txKey)) {
    directionTxSeen.add(txKey);
    existing.txCount += 1;
  }
  assetMap.set(event.assetId, existing);
}

function finalizeTraceAssets(assetMap: Map<string, MutableTraceAssetFlow>): TraceAssetFlow[] {
  return Array.from(assetMap.values())
    .map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.name,
      logoUri: asset.logoUri,
      decimals: asset.decimals,
      rawAmount: asset.rawAmount.toString(),
      uiAmount: asset.uiAmount,
      transferCount: asset.transferCount,
      txCount: asset.txCount,
    }))
    .sort(compareTraceAssets);
}

function startOfDayTimestamp(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00`);
  const time = parsed.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function endOfDayTimestamp(date: string): number | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setDate(parsed.getDate() + 1);
  return Math.floor(parsed.getTime() / 1000);
}

export function compareTraceAssets(a: TraceAssetFlow, b: TraceAssetFlow): number {
  return (
    b.txCount - a.txCount
    || b.transferCount - a.transferCount
    || b.uiAmount - a.uiAmount
    || a.assetId.localeCompare(b.assetId)
  );
}

export function compareTraceAssetOptions(a: TraceAssetOption, b: TraceAssetOption): number {
  return (
    b.txCount - a.txCount
    || b.transferCount - a.transferCount
    || b.uiAmount - a.uiAmount
    || assetLabel(a).localeCompare(assetLabel(b))
  );
}

export function getDirectionalAssets(
  cp: TraceCounterparty,
  direction: TraceDirection,
): TraceAssetFlow[] {
  return direction === "outflow" ? cp.outflowAssets : cp.inflowAssets;
}

export function getDirectionalTxCount(
  cp: TraceCounterparty,
  direction: TraceDirection,
): number {
  return direction === "outflow" ? cp.outflowTxCount : cp.inflowTxCount;
}

export function getDirectionalTransferCount(
  cp: TraceCounterparty,
  direction: TraceDirection,
): number {
  return direction === "outflow" ? cp.outflowTransferCount : cp.inflowTransferCount;
}

export function getPrimaryDirectionalAsset(
  cp: TraceCounterparty,
  direction: TraceDirection,
): TraceAssetFlow | undefined {
  return getDirectionalAssets(cp, direction)[0];
}

export function compareTraceCounterparties(a: TraceCounterparty, b: TraceCounterparty): number {
  return (
    b.txCount - a.txCount
    || b.transferCount - a.transferCount
    || (b.inflowAssets.length + b.outflowAssets.length) - (a.inflowAssets.length + a.outflowAssets.length)
    || b.lastSeen - a.lastSeen
  );
}

export function compareDirectionalCounterparties(
  a: TraceCounterparty,
  b: TraceCounterparty,
  direction: TraceDirection,
): number {
  return (
    getDirectionalTxCount(b, direction) - getDirectionalTxCount(a, direction)
    || getDirectionalTransferCount(b, direction) - getDirectionalTransferCount(a, direction)
    || getDirectionalAssets(b, direction).length - getDirectionalAssets(a, direction).length
    || b.lastSeen - a.lastSeen
  );
}

export function assetLabel(asset: Pick<TraceAssetFlow, "symbol" | "kind" | "mint" | "assetId" | "name">): string {
  return asset.symbol ?? asset.name ?? (asset.kind === "native" ? "SOL" : asset.mint ?? asset.assetId);
}

export function collectTraceAssetOptions(events: TraceTransferEvent[]): TraceAssetOption[] {
  const assetMap = new Map<string, MutableTraceAssetFlow>();
  const seenAssetTx = new Set<string>();
  for (const event of events) {
    upsertTraceAssetFlow(assetMap, seenAssetTx, event, `${event.assetId}:${event.signature}`);
    const current = assetMap.get(event.assetId);
    if (current) {
      current.symbol = current.symbol ?? event.symbol;
      current.name = current.name ?? event.name;
      current.logoUri = current.logoUri ?? event.logoUri;
    }
  }
  return Array.from(assetMap.values())
    .map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.name,
      logoUri: asset.logoUri,
      decimals: asset.decimals,
      transferCount: asset.transferCount,
      txCount: asset.txCount,
      uiAmount: asset.uiAmount,
    }))
    .sort(compareTraceAssetOptions);
}

export function filterTraceEvents(
  events: TraceTransferEvent[],
  filters: TraceFlowFilters,
): TraceTransferEvent[] {
  const min = Number(filters.minAmount);
  const minThreshold = Number.isFinite(min) && min > 0 ? min : 0;
  const max = Number(filters.maxAmount);
  const maxThreshold = Number.isFinite(max) && max > 0 ? max : Infinity;
  const fromTs = startOfDayTimestamp(filters.dateFrom);
  const toTsExclusive = endOfDayTimestamp(filters.dateTo);

  return events.filter((event) => {
    if (filters.assetKind !== "all" && event.kind !== filters.assetKind) return false;
    if (filters.assetId !== TRACE_ALL_ASSETS && event.assetId !== filters.assetId) return false;
    if (minThreshold > 0 && event.uiAmount < minThreshold) return false;
    if (maxThreshold < Infinity && event.uiAmount > maxThreshold) return false;
    if (fromTs != null && event.timestamp < fromTs) return false;
    if (toTsExclusive != null && event.timestamp >= toTsExclusive) return false;
    return true;
  });
}

export function aggregateTraceCounterparties(events: TraceTransferEvent[]): TraceCounterparty[] {
  const counterpartyMap = new Map<string, MutableTraceCounterparty>();
  const seenCounterpartyTx = new Set<string>();
  const seenDirectionalTx = {
    inflow: new Set<string>(),
    outflow: new Set<string>(),
  };
  const seenAssetTx = {
    inflow: new Set<string>(),
    outflow: new Set<string>(),
  };

  for (const event of events) {
    const entry = counterpartyMap.get(event.counterparty) ?? initTraceCounterpartyEntry(event.timestamp);
    entry.transferCount += 1;
    if (event.timestamp > 0) {
      entry.firstSeen = entry.firstSeen > 0 ? Math.min(entry.firstSeen, event.timestamp) : event.timestamp;
      entry.lastSeen = Math.max(entry.lastSeen, event.timestamp);
    }
    entry.label = entry.label ?? event.counterpartyLabel;
    entry.category = entry.category ?? event.counterpartyCategory;
    entry.accountType = entry.accountType ?? event.counterpartyAccountType;

    if (event.direction === "outflow") entry.outflowTransferCount += 1;
    else entry.inflowTransferCount += 1;

    const txKey = `${event.counterparty}:${event.signature}`;
    if (!seenCounterpartyTx.has(txKey)) {
      seenCounterpartyTx.add(txKey);
      entry.txCount += 1;
    }

    const directionalTxKey = `${event.direction}:${event.counterparty}:${event.signature}`;
    if (!seenDirectionalTx[event.direction].has(directionalTxKey)) {
      seenDirectionalTx[event.direction].add(directionalTxKey);
      if (event.direction === "outflow") entry.outflowTxCount += 1;
      else entry.inflowTxCount += 1;
    }

    const assetMap = event.direction === "outflow" ? entry.outflowAssets : entry.inflowAssets;
    upsertTraceAssetFlow(
      assetMap,
      seenAssetTx[event.direction],
      event,
      `${event.counterparty}:${event.assetId}:${event.signature}`,
    );

    counterpartyMap.set(event.counterparty, entry);
  }

  return Array.from(counterpartyMap.entries())
    .map(([address, data]) => ({
      address,
      txCount: data.txCount,
      transferCount: data.transferCount,
      inflowTxCount: data.inflowTxCount,
      outflowTxCount: data.outflowTxCount,
      inflowTransferCount: data.inflowTransferCount,
      outflowTransferCount: data.outflowTransferCount,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
      inflowAssets: finalizeTraceAssets(data.inflowAssets),
      outflowAssets: finalizeTraceAssets(data.outflowAssets),
      label: data.label,
      category: data.category,
      accountType: data.accountType,
    }))
    .sort(compareTraceCounterparties);
}
