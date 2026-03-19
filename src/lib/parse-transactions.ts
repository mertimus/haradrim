import type { FundingSource, RpcParsedInstruction, RpcTransaction, WalletIdentity } from "@/api";
import { LAMPORTS_PER_SOL } from "@/lib/constants";
import {
  aggregateTraceCounterparties,
  NATIVE_SOL_ASSET_ID,
  type TraceCounterparty,
  type TraceDirection,
  type TraceTransferEvent,
} from "@/lib/trace-types";
import type { Node, Edge } from "@xyflow/react";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

export interface CounterpartyTokenTransfer {
  mint: string;
  decimals: number;
  sent: number;
  received: number;
  net: number;
  txCount: number;
  symbol?: string;
  name?: string;
  logoUri?: string;
}

export interface CounterpartyFlow {
  address: string;
  txCount: number;
  solSent: number;
  solReceived: number;
  solNet: number;
  firstSeen: number;
  lastSeen: number;
  label?: string;
  category?: string;
  accountType?: string;
  mint?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenLogoUri?: string;
  tokenTransfers?: CounterpartyTokenTransfer[];
}

export type GraphFlowFilter = "all" | "inflow" | "outflow";

export interface ParsedTransferEvent {
  counterparty: string;
  direction: "inflow" | "outflow";
  kind: "native" | "token";
  assetId: string;
  mint?: string;
  symbol?: string;
  name?: string;
  logoUri?: string;
  decimals?: number;
  uiAmount: number;
}

export interface ParsedTransactionProgram {
  id: string;
  label: string;
}

export interface ParsedTransaction {
  signature: string;
  timestamp: number;
  solChange: number;
  walletBalanceAfter: number;
  counterparties: string[];
  transfers: ParsedTransferEvent[];
  programs: ParsedTransactionProgram[];
  fee: number;
}

export interface ParseResult {
  counterparties: CounterpartyFlow[];
  transactions: ParsedTransaction[];
  historicalMints: string[];
}

interface MutableTokenFlow {
  mint: string;
  decimals: number;
  sent: number;
  received: number;
  signatures: Set<string>;
}

interface MutableCounterpartyFlow {
  txCount: number;
  solSent: number;
  solReceived: number;
  firstSeen: number;
  lastSeen: number;
  signatures: Set<string>;
  tokenFlows: Map<string, MutableTokenFlow>;
}

interface MutableParsedTransaction {
  signature: string;
  timestamp: number;
  solChange: number;
  walletBalanceAfter: number;
  counterparties: Set<string>;
  transfers: ParsedTransferEvent[];
  programs: ParsedTransactionProgram[];
  fee: number;
}

export interface WalletParseAccumulator {
  counterparties: Map<string, MutableCounterpartyFlow>;
  transactions: Map<string, MutableParsedTransaction>;
  historicalMints: Set<string>;
  seenSignatures: Set<string>;
}

export interface OverlayWallet {
  address: string;
  identity: WalletIdentity | null;
  counterparties: CounterpartyFlow[];
  loading: boolean;
  error?: string;
  funding?: FundingSource | null;
}

export const DEFAULT_WALLET_COLORS = ["#00d4ff", "#ffb800", "#7cc6fe", "#ffd966", "#94a3b8", "#4a9eff", "#e6a200", "#b0c4de"];

/** Generate a color for wallet index i, cycling through defaults then generating hsl */
export function getWalletColor(i: number, overrides?: Map<number, string>): string {
  if (overrides?.has(i)) return overrides.get(i)!;
  if (i < DEFAULT_WALLET_COLORS.length) return DEFAULT_WALLET_COLORS[i];
  // Generate distinct hues for overflow
  const hue = (i * 137.508) % 360; // golden angle
  return `hsl(${hue}, 70%, 60%)`;
}

/** Extract the string pubkey from an accountKey entry */
function resolveKey(
  key: string | { pubkey: string; signer: boolean; writable: boolean },
): string {
  return typeof key === "string" ? key : key.pubkey;
}

function finalizeTokenFlows(tokenFlows: Map<string, MutableTokenFlow>): CounterpartyTokenTransfer[] | undefined {
  if (tokenFlows.size === 0) return undefined;
  return Array.from(tokenFlows.values())
    .map((tf) => ({
      mint: tf.mint,
      decimals: tf.decimals,
      sent: tf.sent,
      received: tf.received,
      net: tf.received - tf.sent,
      txCount: tf.signatures.size,
    }))
    .sort((a, b) => (b.sent + b.received) - (a.sent + a.received));
}

function finalizeCounterparties(
  counterpartyMap: Map<string, {
    txCount: number;
    solSent: number;
    solReceived: number;
    firstSeen: number;
    lastSeen: number;
    tokenTransfers?: CounterpartyTokenTransfer[];
  }>,
  sortBy: "txCount" | "volume" = "txCount",
): CounterpartyFlow[] {
  const counterparties: CounterpartyFlow[] = Array.from(
    counterpartyMap.entries(),
  ).map(([address, data]) => ({
    address,
    ...data,
    solNet: data.solReceived - data.solSent,
  }));

  counterparties.sort((a, b) => {
    if (sortBy === "volume") {
      const volumeDiff = (b.solSent + b.solReceived) - (a.solSent + a.solReceived);
      if (volumeDiff !== 0) return volumeDiff;
    }
    return b.txCount - a.txCount;
  });

  return counterparties;
}

export function projectCounterpartiesForGraphFlow(
  counterparties: CounterpartyFlow[],
  flowFilter: GraphFlowFilter,
): CounterpartyFlow[] {
  if (flowFilter === "all") return counterparties;

  return counterparties.flatMap((cp) => {
    const solSent = flowFilter === "outflow" ? cp.solSent : 0;
    const solReceived = flowFilter === "inflow" ? cp.solReceived : 0;
    if (solSent <= 0 && solReceived <= 0) return [];
    return [{
      ...cp,
      solSent,
      solReceived,
      solNet: solReceived - solSent,
    }];
  });
}

function initMutableCounterpartyEntry(timestamp: number): MutableCounterpartyFlow {
  return {
    txCount: 0,
    solSent: 0,
    solReceived: 0,
    firstSeen: timestamp,
    lastSeen: timestamp,
    signatures: new Set<string>(),
    tokenFlows: new Map<string, MutableTokenFlow>(),
  };
}

function flattenInstructions(tx: RpcTransaction): RpcParsedInstruction[] {
  const topLevel = tx.transaction.message.instructions ?? [];
  const innerByIndex = new Map<number, RpcParsedInstruction[]>();

  for (const entry of tx.meta?.innerInstructions ?? []) {
    const bucket = innerByIndex.get(entry.index) ?? [];
    bucket.push(...(entry.instructions ?? []));
    innerByIndex.set(entry.index, bucket);
  }

  const ordered: RpcParsedInstruction[] = [];
  for (let index = 0; index < topLevel.length; index += 1) {
    ordered.push(topLevel[index]);
    const inner = innerByIndex.get(index);
    if (inner) {
      ordered.push(...inner);
      innerByIndex.delete(index);
    }
  }

  for (const remaining of innerByIndex.values()) {
    ordered.push(...remaining);
  }

  return ordered;
}

function getInstructionInfoString(
  instruction: RpcParsedInstruction,
  key: string,
): string | undefined {
  const value = instruction.parsed?.info?.[key];
  return typeof value === "string" ? value : undefined;
}

interface TokenAccountInfo {
  owner?: string;
  mint?: string;
  decimals?: number;
}

interface OrderedNativeTransfer {
  source: string;
  destination: string;
  lamports: bigint;
  order: number;
}

interface OrderedTokenTransfer {
  sourceOwner: string;
  destinationOwner: string;
  mint: string;
  decimals: number;
  amountRaw: bigint;
  order: number;
}

function getInstructionInfoObject(
  instruction: RpcParsedInstruction,
  key: string,
): Record<string, unknown> | undefined {
  const value = instruction.parsed?.info?.[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function getInstructionInfoBigInt(
  instruction: RpcParsedInstruction,
  key: string,
): bigint | undefined {
  const value = instruction.parsed?.info?.[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
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

function rememberTokenAccountInfo(
  map: Map<string, TokenAccountInfo>,
  account: string | undefined,
  next: TokenAccountInfo,
): void {
  if (!account) return;
  const current = map.get(account) ?? {};
  map.set(account, {
    owner: current.owner ?? next.owner,
    mint: current.mint ?? next.mint,
    decimals: current.decimals ?? next.decimals,
  });
}

function getInstructionAuthority(instruction: RpcParsedInstruction): string | undefined {
  return getInstructionInfoString(instruction, "owner")
    ?? getInstructionInfoString(instruction, "authority")
    ?? getInstructionInfoString(instruction, "wallet");
}

function getReleasedAccountLamports(tx: RpcTransaction, account: string): bigint | undefined {
  if (!tx.meta) return undefined;
  const accountKeys = tx.transaction.message.accountKeys.map(resolveKey);
  const accountIndex = accountKeys.indexOf(account);
  if (accountIndex < 0) return undefined;

  const preBalance = tx.meta.preBalances[accountIndex];
  const postBalance = tx.meta.postBalances[accountIndex];
  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) return undefined;

  const released = BigInt(Math.trunc(preBalance)) - BigInt(Math.trunc(postBalance));
  return released > 0n ? released : undefined;
}

function buildTokenAccountInfo(tx: RpcTransaction): Map<string, TokenAccountInfo> {
  const infoMap = new Map<string, TokenAccountInfo>();
  const accountKeys = tx.transaction.message.accountKeys.map(resolveKey);

  for (const tb of tx.meta?.preTokenBalances ?? []) {
    rememberTokenAccountInfo(infoMap, accountKeys[tb.accountIndex], {
      owner: tb.owner,
      mint: tb.mint,
      decimals: tb.uiTokenAmount.decimals,
    });
  }
  for (const tb of tx.meta?.postTokenBalances ?? []) {
    rememberTokenAccountInfo(infoMap, accountKeys[tb.accountIndex], {
      owner: tb.owner,
      mint: tb.mint,
      decimals: tb.uiTokenAmount.decimals,
    });
  }

  for (const instruction of flattenInstructions(tx)) {
    if (
      instruction.program === "spl-associated-token-account"
      || instruction.programId === ASSOCIATED_TOKEN_PROGRAM_ID
    ) {
      const account = getInstructionInfoString(instruction, "account");
      const wallet = getInstructionInfoString(instruction, "wallet");
      const mint = getInstructionInfoString(instruction, "mint");
      rememberTokenAccountInfo(infoMap, account, { owner: wallet, mint });
      continue;
    }
    if (
      instruction.program !== "spl-token"
      && !TOKEN_PROGRAM_IDS.has(instruction.programId ?? "")
    ) {
      continue;
    }
    if (!instruction.parsed?.type) continue;
    if (
      instruction.parsed.type === "initializeAccount"
      || instruction.parsed.type === "initializeAccount2"
      || instruction.parsed.type === "initializeAccount3"
    ) {
      const account = getInstructionInfoString(instruction, "account");
      const owner = getInstructionInfoString(instruction, "owner");
      const mint = getInstructionInfoString(instruction, "mint");
      rememberTokenAccountInfo(infoMap, account, { owner, mint });
      continue;
    }

    const authority = getInstructionAuthority(instruction);
    if (instruction.parsed.type === "closeAccount") {
      const account = getInstructionInfoString(instruction, "account");
      rememberTokenAccountInfo(infoMap, account, { owner: authority });
      continue;
    }

    const source = getInstructionInfoString(instruction, "source");
    const destination = getInstructionInfoString(instruction, "destination");
    const mint = getInstructionInfoString(instruction, "mint");
    const tokenAmount = getInstructionInfoObject(instruction, "tokenAmount");
    const decimals = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : undefined;

    if (source) rememberTokenAccountInfo(infoMap, source, { owner: authority, mint, decimals });
    if (destination) rememberTokenAccountInfo(infoMap, destination, { mint, decimals });
  }

  return infoMap;
}

function makeForwardingKey(...parts: Array<string | bigint>): string {
  return parts.map((part) => typeof part === "bigint" ? part.toString() : part).join(":");
}

function countByKey<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function inferNativeForwardingEvents(
  transfers: OrderedNativeTransfer[],
  walletAddress: string,
  signature: string,
  timestamp: number,
): TraceTransferEvent[] {
  const events: TraceTransferEvent[] = [];
  const directOutflows = transfers.filter((t) => t.source === walletAddress && t.destination !== walletAddress);
  const directInflows = transfers.filter((t) => t.destination === walletAddress && t.source !== walletAddress);
  const nonWalletTransfers = transfers.filter((t) => t.source !== walletAddress && t.destination !== walletAddress);

  if (nonWalletTransfers.length === 0) return events;

  const directOutflowCounts = countByKey(
    directOutflows,
    (t) => makeForwardingKey(t.destination, t.lamports),
  );
  const directInflowCounts = countByKey(
    directInflows,
    (t) => makeForwardingKey(t.source, t.lamports),
  );
  const forwardedOutflowCounts = countByKey(
    nonWalletTransfers,
    (t) => makeForwardingKey(t.source, t.lamports),
  );
  const upstreamInflowCounts = countByKey(
    nonWalletTransfers,
    (t) => makeForwardingKey(t.destination, t.lamports),
  );

  for (const transfer of nonWalletTransfers) {
    const outflowKey = makeForwardingKey(transfer.source, transfer.lamports);
    if (
      directOutflowCounts.get(outflowKey) === 1
      && forwardedOutflowCounts.get(outflowKey) === 1
    ) {
      const direct = directOutflows.find(
        (candidate) =>
          candidate.destination === transfer.source
          && candidate.lamports === transfer.lamports
          && candidate.order < transfer.order,
      );
      if (direct) {
        events.push({
          signature,
          timestamp,
          direction: "outflow",
          counterparty: transfer.destination,
          assetId: NATIVE_SOL_ASSET_ID,
          kind: "native",
          decimals: 9,
          rawAmount: transfer.lamports.toString(),
          uiAmount: bigintToUiAmount(transfer.lamports, 9),
        });
      }
    }

    const inflowKey = makeForwardingKey(transfer.destination, transfer.lamports);
    if (
      directInflowCounts.get(inflowKey) === 1
      && upstreamInflowCounts.get(inflowKey) === 1
    ) {
      const direct = directInflows.find(
        (candidate) =>
          candidate.source === transfer.destination
          && candidate.lamports === transfer.lamports
          && transfer.order < candidate.order,
      );
      if (direct) {
        events.push({
          signature,
          timestamp,
          direction: "inflow",
          counterparty: transfer.source,
          assetId: NATIVE_SOL_ASSET_ID,
          kind: "native",
          decimals: 9,
          rawAmount: transfer.lamports.toString(),
          uiAmount: bigintToUiAmount(transfer.lamports, 9),
        });
      }
    }
  }

  return events;
}

function inferTokenForwardingEvents(
  transfers: OrderedTokenTransfer[],
  walletAddress: string,
  signature: string,
  timestamp: number,
): TraceTransferEvent[] {
  const events: TraceTransferEvent[] = [];
  const directOutflows = transfers.filter((t) => t.sourceOwner === walletAddress && t.destinationOwner !== walletAddress);
  const directInflows = transfers.filter((t) => t.destinationOwner === walletAddress && t.sourceOwner !== walletAddress);
  const nonWalletTransfers = transfers.filter((t) => t.sourceOwner !== walletAddress && t.destinationOwner !== walletAddress);

  if (nonWalletTransfers.length === 0) return events;

  const directOutflowCounts = countByKey(
    directOutflows,
    (t) => makeForwardingKey(t.destinationOwner, t.mint, t.amountRaw),
  );
  const directInflowCounts = countByKey(
    directInflows,
    (t) => makeForwardingKey(t.sourceOwner, t.mint, t.amountRaw),
  );
  const forwardedOutflowCounts = countByKey(
    nonWalletTransfers,
    (t) => makeForwardingKey(t.sourceOwner, t.mint, t.amountRaw),
  );
  const upstreamInflowCounts = countByKey(
    nonWalletTransfers,
    (t) => makeForwardingKey(t.destinationOwner, t.mint, t.amountRaw),
  );

  for (const transfer of nonWalletTransfers) {
    const outflowKey = makeForwardingKey(transfer.sourceOwner, transfer.mint, transfer.amountRaw);
    if (
      directOutflowCounts.get(outflowKey) === 1
      && forwardedOutflowCounts.get(outflowKey) === 1
    ) {
      const direct = directOutflows.find(
        (candidate) =>
          candidate.destinationOwner === transfer.sourceOwner
          && candidate.mint === transfer.mint
          && candidate.amountRaw === transfer.amountRaw
          && candidate.order < transfer.order,
      );
      if (direct) {
        events.push({
          signature,
          timestamp,
          direction: "outflow",
          counterparty: transfer.destinationOwner,
          assetId: transfer.mint,
          kind: "token",
          mint: transfer.mint,
          decimals: transfer.decimals,
          rawAmount: transfer.amountRaw.toString(),
          uiAmount: bigintToUiAmount(transfer.amountRaw, transfer.decimals),
        });
      }
    }

    const inflowKey = makeForwardingKey(transfer.destinationOwner, transfer.mint, transfer.amountRaw);
    if (
      directInflowCounts.get(inflowKey) === 1
      && upstreamInflowCounts.get(inflowKey) === 1
    ) {
      const direct = directInflows.find(
        (candidate) =>
          candidate.sourceOwner === transfer.destinationOwner
          && candidate.mint === transfer.mint
          && candidate.amountRaw === transfer.amountRaw
          && transfer.order < candidate.order,
      );
      if (direct) {
        events.push({
          signature,
          timestamp,
          direction: "inflow",
          counterparty: transfer.sourceOwner,
          assetId: transfer.mint,
          kind: "token",
          mint: transfer.mint,
          decimals: transfer.decimals,
          rawAmount: transfer.amountRaw.toString(),
          uiAmount: bigintToUiAmount(transfer.amountRaw, transfer.decimals),
        });
      }
    }
  }

  return events;
}

function collectWalletMints(
  walletMints: Set<string>,
  tx: RpcTransaction,
  walletAddress: string,
): void {
  for (const tb of tx.meta?.preTokenBalances ?? []) {
    if (tb.owner === walletAddress && (tb.uiTokenAmount.uiAmount ?? 0) > 0) {
      walletMints.add(tb.mint);
    }
  }
  for (const tb of tx.meta?.postTokenBalances ?? []) {
    if (tb.owner === walletAddress && (tb.uiTokenAmount.uiAmount ?? 0) > 0) {
      walletMints.add(tb.mint);
    }
  }
}

const IGNORED_TX_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ...TOKEN_PROGRAM_IDS,
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJBfCR6MNLc4u1mfLsJgGT2ciczyG5hXVfHi",
]);

const PROGRAM_LABELS = new Map<string, string>([
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter V6"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", "OpenBook"],
  ["auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg", "Squads V4"],
  ["metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "Metaplex"],
  ["namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX", "SNS"],
]);

function prettifyProgramName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function collectTransactionPrograms(tx: RpcTransaction): ParsedTransactionProgram[] {
  const programs = new Map<string, ParsedTransactionProgram>();

  for (const instruction of flattenInstructions(tx)) {
    const programId = instruction.programId ?? "";
    const programName = typeof instruction.program === "string" ? instruction.program : "";
    if (programId && IGNORED_TX_PROGRAM_IDS.has(programId)) continue;
    if (!programId && (!programName || programName === "system")) continue;

    const label =
      (programId ? PROGRAM_LABELS.get(programId) : undefined)
      ?? (programName && !["system", "spl-token", "spl-associated-token-account"].includes(programName)
        ? prettifyProgramName(programName)
        : "")
      ?? "";

    const key = programId || programName;
    if (!key || programs.has(key)) continue;
    programs.set(key, {
      id: key,
      label: label || `${key.slice(0, 4)}...${key.slice(-4)}`,
    });
  }

  return [...programs.values()];
}

function walletSolChange(tx: RpcTransaction, walletAddress: string): number {
  const accountKeys = tx.transaction.message.accountKeys.map(resolveKey);
  const walletIndex = accountKeys.indexOf(walletAddress);
  if (walletIndex < 0 || !tx.meta) return 0;
  const pre = tx.meta.preBalances[walletIndex] ?? 0;
  const post = tx.meta.postBalances[walletIndex] ?? 0;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function walletPostBalance(tx: RpcTransaction, walletAddress: string): number {
  const accountKeys = tx.transaction.message.accountKeys.map(resolveKey);
  const walletIndex = accountKeys.indexOf(walletAddress);
  if (walletIndex < 0 || !tx.meta) return 0;
  const post = tx.meta.postBalances[walletIndex] ?? 0;
  return post / LAMPORTS_PER_SOL;
}

export function createWalletParseAccumulator(): WalletParseAccumulator {
  return {
    counterparties: new Map(),
    transactions: new Map(),
    historicalMints: new Set(),
    seenSignatures: new Set(),
  };
}

export function accumulateWalletParseResult(
  accumulator: WalletParseAccumulator,
  txs: RpcTransaction[],
  walletAddress: string,
): void {
  const freshTxs: RpcTransaction[] = [];

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const signature = tx.transaction.signatures[0];
    if (!signature || accumulator.seenSignatures.has(signature)) continue;
    accumulator.seenSignatures.add(signature);
    collectWalletMints(accumulator.historicalMints, tx, walletAddress);
    accumulator.transactions.set(signature, {
      signature,
      timestamp: tx.blockTime ?? 0,
      solChange: walletSolChange(tx, walletAddress),
      walletBalanceAfter: walletPostBalance(tx, walletAddress),
      counterparties: new Set<string>(),
      transfers: [],
      programs: collectTransactionPrograms(tx),
      fee: tx.meta.fee / LAMPORTS_PER_SOL,
    });
    freshTxs.push(tx);
  }

  if (freshTxs.length === 0) return;

  const events = parseTraceTransferEvents(freshTxs, walletAddress);
  for (const event of events) {
    const entry = accumulator.counterparties.get(event.counterparty)
      ?? initMutableCounterpartyEntry(event.timestamp);

    entry.firstSeen = Math.min(entry.firstSeen, event.timestamp);
    entry.lastSeen = Math.max(entry.lastSeen, event.timestamp);
    if (!entry.signatures.has(event.signature)) {
      entry.signatures.add(event.signature);
      entry.txCount += 1;
    }
    if (event.kind === "native") {
      if (event.direction === "outflow") entry.solSent += event.uiAmount;
      else entry.solReceived += event.uiAmount;
    } else if (event.kind === "token" && event.mint) {
      const tf = entry.tokenFlows.get(event.mint) ?? {
        mint: event.mint,
        decimals: event.decimals,
        sent: 0,
        received: 0,
        signatures: new Set<string>(),
      };
      if (event.direction === "outflow") tf.sent += event.uiAmount;
      else tf.received += event.uiAmount;
      tf.signatures.add(event.signature);
      entry.tokenFlows.set(event.mint, tf);
    }
    accumulator.counterparties.set(event.counterparty, entry);

    const txEntry = accumulator.transactions.get(event.signature);
    txEntry?.counterparties.add(event.counterparty);
    txEntry?.transfers.push({
      counterparty: event.counterparty,
      direction: event.direction,
      kind: event.kind,
      assetId: event.assetId,
      mint: event.mint,
      decimals: event.decimals,
      uiAmount: event.uiAmount,
    });
  }
}

export function finalizeWalletParseAccumulator(
  accumulator: WalletParseAccumulator,
): ParseResult {
  const counterparties = finalizeCounterparties(
    new Map(
      Array.from(accumulator.counterparties.entries()).map(([address, entry]) => [
        address,
        {
          txCount: entry.txCount,
          solSent: entry.solSent,
          solReceived: entry.solReceived,
          firstSeen: entry.firstSeen,
          lastSeen: entry.lastSeen,
          tokenTransfers: finalizeTokenFlows(entry.tokenFlows),
        },
      ]),
    ),
  );

  const transactions = Array.from(accumulator.transactions.values())
    .map((tx) => ({
      signature: tx.signature,
      timestamp: tx.timestamp,
      solChange: tx.solChange,
      walletBalanceAfter: tx.walletBalanceAfter,
      counterparties: [...tx.counterparties],
      transfers: tx.transfers,
      programs: tx.programs,
      fee: tx.fee,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  return {
    counterparties,
    transactions,
    historicalMints: [...accumulator.historicalMints],
  };
}

export function parseTransactions(
  txs: RpcTransaction[],
  walletAddress: string,
): ParseResult {
  const accumulator = createWalletParseAccumulator();
  accumulateWalletParseResult(accumulator, txs, walletAddress);
  return finalizeWalletParseAccumulator(accumulator);
}

/**
 * Trace-mode counterparty extraction:
 * count only explicit owner-normalized asset transfers touching the selected wallet.
 *
 * We read both top-level and inner parsed instructions and accept:
 * - native SOL: `system.transfer` / `system.transferWithSeed`
 * - SPL tokens / Token-2022: `transfer` / `transferChecked` / `transferCheckedWithFee`
 *
 * Token transfers are normalized from token accounts to their owners using the
 * tx's token balance owners plus ATA/init instructions. This is intentionally
 * conservative and avoids inferring counterparties from unrelated account
 * balance changes in multi-program transactions.
 */
export function parseTraceTransferEvents(
  txs: RpcTransaction[],
  walletAddress: string,
): TraceTransferEvent[] {
  const events: TraceTransferEvent[] = [];

  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const timestamp = tx.blockTime ?? 0;
    const signature = tx.transaction.signatures[0] ?? "";
    const tokenAccountInfo = buildTokenAccountInfo(tx);

    // Track all transfers in this tx for same-tx forwarding chain detection.
    // Pattern: walletAddress → X → Y  (single-hop pass-through)
    const txNativeTransfers: OrderedNativeTransfer[] = [];
    const txTokenTransfers: OrderedTokenTransfer[] = [];

    for (const [order, instruction] of flattenInstructions(tx).entries()) {
      let direction: TraceDirection | null = null;
      let counterparty: string | undefined;
      let assetId: string | undefined;
      let kind: "native" | "token" | undefined;
      let mint: string | undefined;
      let decimals = 0;
      let amountRaw: bigint | undefined;

      if (
        (instruction.program === "system" || instruction.programId === SYSTEM_PROGRAM_ID)
        && instruction.parsed?.type
      ) {
        if (instruction.parsed.type !== "transfer" && instruction.parsed.type !== "transferWithSeed") continue;
        const source = getInstructionInfoString(instruction, "source");
        const destination = getInstructionInfoString(instruction, "destination");
        const lamports = getInstructionInfoBigInt(instruction, "lamports");
        if (!source || !destination || !lamports || lamports <= 0n) continue;

        txNativeTransfers.push({ source, destination, lamports, order });

        if (source === walletAddress && destination !== walletAddress) {
          direction = "outflow";
          counterparty = destination;
        } else if (destination === walletAddress && source !== walletAddress) {
          direction = "inflow";
          counterparty = source;
        } else {
          continue;
        }
        assetId = NATIVE_SOL_ASSET_ID;
        kind = "native";
        decimals = 9;
        amountRaw = lamports;
      } else if (
        (instruction.program === "spl-token" || TOKEN_PROGRAM_IDS.has(instruction.programId ?? ""))
        && instruction.parsed?.type
      ) {
        if (
          instruction.parsed.type === "transfer"
          || instruction.parsed.type === "transferChecked"
          || instruction.parsed.type === "transferCheckedWithFee"
        ) {
          const source = getInstructionInfoString(instruction, "source");
          const destination = getInstructionInfoString(instruction, "destination");
          if (!source || !destination) continue;

          const tokenAmountInfo = getInstructionInfoObject(instruction, "tokenAmount");
          amountRaw =
            (tokenAmountInfo?.amount != null
              ? (() => {
                  try {
                    return BigInt(String(tokenAmountInfo.amount));
                  } catch {
                    return undefined;
                  }
                })()
              : undefined)
            ?? getInstructionInfoBigInt(instruction, "amount");
          if (!amountRaw || amountRaw <= 0n) continue;

          const sourceInfo = tokenAccountInfo.get(source);
          const destinationInfo = tokenAccountInfo.get(destination);
          const sourceOwner = sourceInfo?.owner ?? getInstructionAuthority(instruction);
          const destinationOwner = destinationInfo?.owner;
          mint = getInstructionInfoString(instruction, "mint") ?? sourceInfo?.mint ?? destinationInfo?.mint;
          decimals =
            typeof tokenAmountInfo?.decimals === "number"
              ? tokenAmountInfo.decimals as number
              : sourceInfo?.decimals ?? destinationInfo?.decimals ?? 0;

          if (sourceOwner && destinationOwner && mint) {
            txTokenTransfers.push({ sourceOwner, destinationOwner, mint, decimals, amountRaw, order });
          }

          if (sourceOwner === walletAddress && destinationOwner && destinationOwner !== walletAddress) {
            direction = "outflow";
            counterparty = destinationOwner;
          } else if (destinationOwner === walletAddress && sourceOwner && sourceOwner !== walletAddress) {
            direction = "inflow";
            counterparty = sourceOwner;
          } else {
            continue;
          }

          if (!mint) continue;
          assetId = mint;
          kind = "token";
        } else if (instruction.parsed.type === "closeAccount") {
          const account = getInstructionInfoString(instruction, "account");
          const destination = getInstructionInfoString(instruction, "destination");
          const owner = tokenAccountInfo.get(account ?? "")?.owner ?? getInstructionAuthority(instruction);
          if (!account || !destination || !owner) continue;

          amountRaw = getReleasedAccountLamports(tx, account);
          if (!amountRaw || amountRaw <= 0n) continue;

          if (owner === walletAddress && destination !== walletAddress) {
            direction = "outflow";
            counterparty = destination;
          } else if (destination === walletAddress && owner !== walletAddress) {
            direction = "inflow";
            counterparty = owner;
          } else {
            continue;
          }

          assetId = NATIVE_SOL_ASSET_ID;
          kind = "native";
          decimals = 9;
        } else {
          continue;
        }
      } else {
        continue;
      }

      if (!direction || !counterparty || !assetId || !kind || !amountRaw) continue;
      events.push({
        signature,
        timestamp,
        direction,
        counterparty,
        assetId,
        kind,
        mint,
        decimals,
        rawAmount: amountRaw.toString(),
        uiAmount: bigintToUiAmount(amountRaw, decimals),
      });
    }

    events.push(...inferNativeForwardingEvents(txNativeTransfers, walletAddress, signature, timestamp));
    events.push(...inferTokenForwardingEvents(txTokenTransfers, walletAddress, signature, timestamp));
  }

  return events;
}

export function parseTraceCounterparties(
  txs: RpcTransaction[],
  walletAddress: string,
): TraceCounterparty[] {
  return aggregateTraceCounterparties(parseTraceTransferEvents(txs, walletAddress));
}

interface ForceNode extends SimulationNodeDatum {
  id: string;
  isCenter: boolean;
  importance: number;
  nodeSize: number;
  hubX?: number;
  hubY?: number;
  anchorX?: number;
  anchorY?: number;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  distance: number;
}

/**
 * Logarithmic scaling: maps a value from [0, max] into [minOut, maxOut]
 * using log(1 + x) so one whale doesn't squash everything else.
 */
function logScale(value: number, max: number, minOut: number, maxOut: number): number {
  if (max <= 0) return minOut;
  const norm = Math.log1p(value) / Math.log1p(max);
  return minOut + norm * (maxOut - minOut);
}

function interpolateAngle(index: number, total: number, startDeg: number, endDeg: number): number {
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;
  if (total <= 1) return (start + end) / 2;
  const t = index / (total - 1);
  return start + (end - start) * t;
}

function ringCapacity(ringIndex: number): number {
  return 5 + ringIndex * 3;
}

function ringIndexForRank(rank: number): number {
  let remaining = rank;
  let ringIndex = 0;
  while (remaining >= ringCapacity(ringIndex)) {
    remaining -= ringCapacity(ringIndex);
    ringIndex += 1;
  }
  return ringIndex;
}

function buildSingleWalletPositionMap(
  counterparties: CounterpartyFlow[],
): Map<string, { x: number; y: number }> {
  const positionMap = new Map<string, { x: number; y: number }>();
  const rings = new Map<number, CounterpartyFlow[]>();

  counterparties.forEach((cp, rank) => {
    const ringIndex = ringIndexForRank(rank);
    const ring = rings.get(ringIndex) ?? [];
    ring.push(cp);
    rings.set(ringIndex, ring);
  });

  const assignRing = (
    items: CounterpartyFlow[],
    radius: number,
    startDeg: number,
    endDeg: number,
  ) => {
    items.forEach((cp, index) => {
      const angle = interpolateAngle(index, items.length, startDeg, endDeg);
      positionMap.set(cp.address, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    });
  };

  for (const [ringIndex, ringItems] of rings.entries()) {
    // Rank determines orbit. Angle is only for distributing nodes cleanly around the ring.
    const radius = 180 + ringIndex * 68;
    const startDeg = -90 + ringIndex * 12;
    const endDeg = ringItems.length <= 1
      ? startDeg + 360
      : startDeg + 360 - (360 / ringItems.length);
    assignRing(ringItems, radius, startDeg, endDeg);
  }

  return positionMap;
}

export interface GraphOverrides {
  added: Set<string>;
  removed: Set<string>;
}

export function buildGraphData(
  walletAddress: string,
  counterparties: CounterpartyFlow[],
  walletIdentity: WalletIdentity | null,
  overrides?: GraphOverrides,
  nodeBudget = 50,
): { nodes: Node[]; edges: Edge[] } {
  let top50 = counterparties.slice(0, nodeBudget);

  // Apply overrides
  if (overrides) {
    top50 = top50.filter(c => !overrides.removed.has(c.address));
    const selectedAddrs = new Set(top50.map(c => c.address));
    for (const addr of overrides.added) {
      if (selectedAddrs.has(addr)) continue;
      const cp = counterparties.find(c => c.address === addr);
      if (cp) top50.push(cp);
    }
  }
  const maxVolume = Math.max(
    ...top50.map((c) => Math.abs(c.solSent) + Math.abs(c.solReceived)),
    1,
  );
  const maxTx = Math.max(...top50.map((c) => c.txCount), 1);

  const tierMap = new Map<string, number>();
  top50.forEach((cp, i) => {
    tierMap.set(cp.address, i < 5 ? 1 : i < 15 ? 2 : 3);
  });

  // Node size is the one node-side encoding: tx count.
  const NODE_MIN = 72;
  const NODE_MAX = 124;
  const CENTER_SIZE = 160;

  const cpSizes = new Map<string, number>();
  for (const cp of top50) {
    cpSizes.set(cp.address, logScale(cp.txCount, maxTx, NODE_MIN, NODE_MAX));
  }

  const posMap = buildSingleWalletPositionMap(top50);

  // Build React Flow nodes
  const nodes: Node[] = [
    {
      id: walletAddress,
      type: "walletNode",
      data: {
        address: walletAddress,
        label: walletIdentity?.label ?? walletIdentity?.name,
        category: walletIdentity?.category,
        isCenter: true,
        nodeSize: CENTER_SIZE,
        tier: 0,
        volume: maxVolume,
        maxVolume,
        layoutMode: "single-wallet",
      },
      position: { x: 0, y: 0 },
    },
    ...top50.map((cp) => {
      const volume = cp.solSent + cp.solReceived;
      return {
        id: cp.address,
        type: "walletNode",
        draggable: true,
        data: {
          address: cp.address,
          label: cp.label,
          category: cp.category,
          isCenter: false,
          nodeSize: cpSizes.get(cp.address) ?? NODE_MIN,
          tier: tierMap.get(cp.address) ?? 3,
          volume,
          maxVolume,
          txCount: cp.txCount,
          solSent: cp.solSent,
          solReceived: cp.solReceived,
          accountType: cp.accountType,
          tokenName: cp.tokenName,
          tokenSymbol: cp.tokenSymbol,
          tokenLogoUri: cp.tokenLogoUri,
          layoutMode: "single-wallet",
        },
        position: posMap.get(cp.address) ?? { x: 0, y: 0 },
      };
    }),
  ];

  // Edge intensity is the one edge-side encoding: SOL volume.
  const edges: Edge[] = top50.map((cp) => {
    const volume = cp.solSent + cp.solReceived;
    const isOutflow = cp.solSent > cp.solReceived;
    const intensity = maxVolume > 0 ? Math.max(0.15, volume / maxVolume) : 0.15;

    return {
      id: `${walletAddress}-${cp.address}`,
      source: walletAddress,
      target: cp.address,
      type: "flowEdge",
      data: {
        solSent: cp.solSent,
        solReceived: cp.solReceived,
        txCount: cp.txCount,
        isOutflow,
        thickness: 2.25,
        intensity,
        volume,
        maxVolume,
      },
    };
  });

  return { nodes, edges };
}

export function countSharedCounterparties(
  wallets: Array<{
    address: string;
    counterparties: CounterpartyFlow[];
  }>,
): number {
  if (wallets.length < 2) return 0;

  const hubAddresses = new Set(wallets.map((wallet) => wallet.address));
  const sourcesByAddress = new Map<string, Set<number>>();

  for (let wi = 0; wi < wallets.length; wi++) {
    for (const cp of wallets[wi].counterparties) {
      if (hubAddresses.has(cp.address)) continue;
      const sources = sourcesByAddress.get(cp.address) ?? new Set<number>();
      sources.add(wi);
      sourcesByAddress.set(cp.address, sources);
    }
  }

  let sharedCount = 0;
  for (const sources of sourcesByAddress.values()) {
    if (sources.size > 1) sharedCount++;
  }
  return sharedCount;
}

export interface ForceSimData {
  simNodes: Array<{
    id: string;
    isCenter: boolean;
    importance: number;
    nodeSize: number;
    hubX?: number;
    hubY?: number;
    fx?: number | null;
    fy?: number | null;
  }>;
  simLinks: Array<{
    source: string;
    target: string;
    distance: number;
  }>;
}

export function buildMergedGraphData(
  wallets: Array<{
    address: string;
    counterparties: CounterpartyFlow[];
    identity: WalletIdentity | null;
  }>,
  walletColors: string[],
  overrides?: GraphOverrides,
  nodeBudget = 50,
  rankByAddress?: Map<string, number>,
  options?: { skipSimulation?: boolean },
): { nodes: Node[]; edges: Edge[]; forceSimData?: ForceSimData } {
  if (wallets.length === 0) return { nodes: [], edges: [] };
  if (wallets.length === 1) {
    return buildGraphData(wallets[0].address, wallets[0].counterparties, wallets[0].identity, overrides, nodeBudget);
  }

  const hubAddresses = new Set(wallets.map((w) => w.address));

  // Hub positions based on count
  const hubPositions: Array<{ x: number; y: number }> = [];
  if (wallets.length === 2) {
    hubPositions.push({ x: -200, y: 0 }, { x: 200, y: 0 });
  } else {
    const radius = 200;
    for (let i = 0; i < wallets.length; i++) {
      const angle = (2 * Math.PI * i) / wallets.length - Math.PI / 2;
      hubPositions.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }
  }

  // Deduplicate counterparties across wallets
  interface MergedCounterparty {
    address: string;
    txCount: number;
    solSent: number;
    solReceived: number;
    firstSeen: number;
    lastSeen: number;
    label?: string;
    category?: string;
    accountType?: string;
    mint?: string;
    tokenName?: string;
    tokenSymbol?: string;
    tokenLogoUri?: string;
    sourceWallets: number[]; // wallet indices
  }

  const mergedMap = new Map<string, MergedCounterparty>();

  for (let wi = 0; wi < wallets.length; wi++) {
    for (const cp of wallets[wi].counterparties) {
      if (hubAddresses.has(cp.address)) continue; // handled as hub-to-hub
      const existing = mergedMap.get(cp.address);
      if (existing) {
        existing.txCount += cp.txCount;
        existing.solSent += cp.solSent;
        existing.solReceived += cp.solReceived;
        existing.firstSeen = Math.min(existing.firstSeen, cp.firstSeen);
        existing.lastSeen = Math.max(existing.lastSeen, cp.lastSeen);
        if (!existing.label && cp.label) existing.label = cp.label;
        if (!existing.category && cp.category) existing.category = cp.category;
        if (!existing.accountType && cp.accountType) existing.accountType = cp.accountType;
        if (!existing.tokenName && cp.tokenName) existing.tokenName = cp.tokenName;
        if (!existing.tokenSymbol && cp.tokenSymbol) existing.tokenSymbol = cp.tokenSymbol;
        if (!existing.tokenLogoUri && cp.tokenLogoUri) existing.tokenLogoUri = cp.tokenLogoUri;
        if (!existing.mint && cp.mint) existing.mint = cp.mint;
        if (!existing.sourceWallets.includes(wi)) existing.sourceWallets.push(wi);
      } else {
        mergedMap.set(cp.address, {
          address: cp.address,
          txCount: cp.txCount,
          solSent: cp.solSent,
          solReceived: cp.solReceived,
          firstSeen: cp.firstSeen,
          lastSeen: cp.lastSeen,
          label: cp.label,
          category: cp.category,
          accountType: cp.accountType,
          mint: cp.mint,
          tokenName: cp.tokenName,
          tokenSymbol: cp.tokenSymbol,
          tokenLogoUri: cp.tokenLogoUri,
          sourceWallets: [wi],
        });
      }
    }
  }

  // Track hub-to-hub edges from counterparty overlap
  const hubToHubEdges: Array<{
    sourceIdx: number;
    targetIdx: number;
    txCount: number;
    solSent: number;
    solReceived: number;
  }> = [];
  for (let wi = 0; wi < wallets.length; wi++) {
    for (const cp of wallets[wi].counterparties) {
      if (!hubAddresses.has(cp.address)) continue;
      const targetIdx = wallets.findIndex((w) => w.address === cp.address);
      if (targetIdx < 0 || targetIdx === wi) continue;
      // Only add once per pair (lower index → higher index)
      if (wi > targetIdx) continue;
      hubToHubEdges.push({
        sourceIdx: wi,
        targetIdx,
        txCount: cp.txCount,
        solSent: cp.solSent,
        solReceived: cp.solReceived,
      });
    }
  }

  // Shared counterparties are always included; remaining budget is filled fairly across exclusives.
  const sharedAddresses = new Set(
    Array.from(mergedMap.values())
      .filter((cp) => cp.sourceWallets.length > 1)
      .map((cp) => cp.address),
  );
  const effectiveBudget = Math.max(nodeBudget, sharedAddresses.size);
  const selectedAddresses = new Set(sharedAddresses);

  const exclusiveQueues = wallets.map((wallet) =>
    wallet.counterparties.filter((cp) => {
      if (hubAddresses.has(cp.address)) return false;
      if (selectedAddresses.has(cp.address)) return false;
      return (mergedMap.get(cp.address)?.sourceWallets.length ?? 0) === 1;
    }),
  );
  const exclusiveIndices = new Array(wallets.length).fill(0);

  while (selectedAddresses.size < effectiveBudget) {
    let progressed = false;
    for (let wi = 0; wi < exclusiveQueues.length && selectedAddresses.size < effectiveBudget; wi++) {
      const queue = exclusiveQueues[wi];
      while (exclusiveIndices[wi] < queue.length) {
        const cp = queue[exclusiveIndices[wi]++];
        if (selectedAddresses.has(cp.address)) continue;
        selectedAddresses.add(cp.address);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

  let allMerged = Array.from(mergedMap.values())
    .filter((cp) => selectedAddresses.has(cp.address));
  allMerged.sort((a, b) => {
    if (rankByAddress) {
      const rankA = rankByAddress.get(a.address) ?? Number.MAX_SAFE_INTEGER;
      const rankB = rankByAddress.get(b.address) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
    }
    const volA = a.solSent + a.solReceived;
    const volB = b.solSent + b.solReceived;
    return volB + b.txCount * 0.1 - (volA + a.txCount * 0.1);
  });

  // Apply overrides
  if (overrides) {
    allMerged = allMerged.filter(c => !overrides.removed.has(c.address));
    const selectedMergedAddrs = new Set(allMerged.map(c => c.address));
    for (const addr of overrides.added) {
      if (selectedMergedAddrs.has(addr)) continue;
      const cp = mergedMap.get(addr);
      if (cp) allMerged.push(cp);
    }
  }

  const top50 = allMerged;

  const maxVolume = Math.max(...top50.map((c) => c.solSent + c.solReceived), 1);
  const maxTx = Math.max(...top50.map((c) => c.txCount), 1);

  // Tier assignment
  const sorted = [...top50].sort((a, b) => {
    const impA = ((a.solSent + a.solReceived) / maxVolume) * 0.6 + (a.txCount / maxTx) * 0.4;
    const impB = ((b.solSent + b.solReceived) / maxVolume) * 0.6 + (b.txCount / maxTx) * 0.4;
    return impB - impA;
  });
  const tierMap = new Map<string, number>();
  sorted.forEach((cp, i) => {
    tierMap.set(cp.address, i < 5 ? 1 : i < 15 ? 2 : 3);
  });

  const NODE_MIN = 100;
  const NODE_MAX = 180;
  const CENTER_SIZE = 160;

  const cpSizes = new Map<string, number>();
  for (const cp of top50) {
    const volume = cp.solSent + cp.solReceived;
    const importance = (volume / maxVolume) * 0.6 + (cp.txCount / maxTx) * 0.4;
    cpSizes.set(cp.address, logScale(importance, 1, NODE_MIN, NODE_MAX));
  }

  // Per-counterparty: track which wallet edges connect (for edge generation)
  const top50Addrs = new Set(top50.map(t => t.address));
  const cpEdges: Array<{
    hubAddr: string;
    cpAddr: string;
    walletIndex: number;
    solSent: number;
    solReceived: number;
    txCount: number;
  }> = [];
  for (let wi = 0; wi < wallets.length; wi++) {
    for (const cp of wallets[wi].counterparties) {
      if (hubAddresses.has(cp.address)) continue;
      if (!mergedMap.has(cp.address)) continue;
      // Only include if in top50
      if (!top50Addrs.has(cp.address)) continue;
      cpEdges.push({
        hubAddr: wallets[wi].address,
        cpAddr: cp.address,
        walletIndex: wi,
        solSent: cp.solSent,
        solReceived: cp.solReceived,
        txCount: cp.txCount,
      });
    }
  }

  // Build force nodes
  const simNodes: ForceNode[] = wallets.map((w, i) => ({
    id: w.address,
    isCenter: true,
    importance: 1,
    nodeSize: CENTER_SIZE,
    fx: hubPositions[i].x,
    fy: hubPositions[i].y,
  }));

  for (const cp of top50) {
    const volume = cp.solSent + cp.solReceived;
    const importance = (volume / maxVolume) * 0.6 + (cp.txCount / maxTx) * 0.4;
    // Average position of connected hubs — orbit around own hub(s)
    let hx = 0, hy = 0;
    for (const wi of cp.sourceWallets) {
      hx += hubPositions[wi].x;
      hy += hubPositions[wi].y;
    }
    hx /= cp.sourceWallets.length;
    hy /= cp.sourceWallets.length;
    simNodes.push({
      id: cp.address,
      isCenter: false,
      importance,
      nodeSize: cpSizes.get(cp.address) ?? NODE_MIN,
      hubX: hx,
      hubY: hy,
    });
  }

  // Build force links — one link per edge (hub → cp)
  const simLinks: ForceLink[] = cpEdges.map((e) => {
    const volume = e.solSent + e.solReceived;
    const importance = (volume / maxVolume) * 0.6 + (e.txCount / maxTx) * 0.4;
    const distance = logScale(1 - importance, 1, 160, 400);
    return { source: e.hubAddr, target: e.cpAddr, distance };
  });

  // Hub-to-hub links
  for (const hh of hubToHubEdges) {
    simLinks.push({
      source: wallets[hh.sourceIdx].address,
      target: wallets[hh.targetIdx].address,
      distance: 250,
    });
  }

  const posMap = new Map<string, { x: number; y: number }>();
  let forceSimData: ForceSimData | undefined;

  if (options?.skipSimulation) {
    // Serialize sim data for worker
    forceSimData = {
      simNodes: simNodes.map((n) => ({
        id: n.id,
        isCenter: n.isCenter,
        importance: n.importance,
        nodeSize: n.nodeSize,
        hubX: n.hubX,
        hubY: n.hubY,
        fx: n.fx,
        fy: n.fy,
      })),
      simLinks: simLinks.map((l) => ({
        source: typeof l.source === "string" ? l.source : typeof l.source === "object" ? (l.source as ForceNode).id : String(l.source),
        target: typeof l.target === "string" ? l.target : typeof l.target === "object" ? (l.target as ForceNode).id : String(l.target),
        distance: l.distance,
      })),
    };
    // Use hub/initial positions as placeholders
    for (const sn of simNodes) {
      posMap.set(sn.id, { x: sn.fx ?? sn.hubX ?? 0, y: sn.fy ?? sn.hubY ?? 0 });
    }
  } else {
    // Run simulation synchronously (fallback)
    const sim = forceSimulation<ForceNode>(simNodes)
      .force(
        "link",
        forceLink<ForceNode, ForceLink>(simLinks)
          .id((d) => d.id)
          .distance((d) => d.distance)
          .strength(1.2),
      )
      .force("charge", forceManyBody<ForceNode>().strength(-180))
      .force("center", forceCenter(0, 0).strength(0.1))
      .force(
        "collide",
        forceCollide<ForceNode>().radius((d) => d.nodeSize * 0.55 + 15).strength(0.8),
      )
      .force(
        "hubX",
        forceX<ForceNode>((d) => d.hubX ?? 0).strength((d) => (d.isCenter ? 0 : 0.4)),
      )
      .force(
        "hubY",
        forceY<ForceNode>((d) => d.hubY ?? 0).strength((d) => (d.isCenter ? 0 : 0.4)),
      )
      .stop();

    for (let i = 0; i < 400; i++) sim.tick();

    for (const sn of simNodes) {
      posMap.set(sn.id, { x: sn.x ?? 0, y: sn.y ?? 0 });
    }
  }

  // Build React Flow nodes
  const nodes: Node[] = [];

  // Hub nodes
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    nodes.push({
      id: w.address,
      type: "walletNode",
      data: {
        address: w.address,
        label: w.identity?.label ?? w.identity?.name,
        category: w.identity?.category,
        isCenter: true,
        nodeSize: CENTER_SIZE,
        tier: 0,
        volume: maxVolume,
        maxVolume,
        walletColor: walletColors[i],
        walletIndex: i,
      },
      position: posMap.get(w.address) ?? hubPositions[i],
    });
  }

  // Counterparty nodes
  for (const cp of top50) {
    const volume = cp.solSent + cp.solReceived;
    const connectedColors = cp.sourceWallets.map((wi) => walletColors[wi]);
    nodes.push({
      id: cp.address,
      type: "walletNode",
      draggable: true,
      data: {
        address: cp.address,
        label: cp.label,
        category: cp.category,
        isCenter: false,
        nodeSize: cpSizes.get(cp.address) ?? NODE_MIN,
        tier: tierMap.get(cp.address) ?? 3,
        volume,
        maxVolume,
        txCount: cp.txCount,
        solSent: cp.solSent,
        solReceived: cp.solReceived,
        accountType: cp.accountType,
        tokenName: cp.tokenName,
        tokenSymbol: cp.tokenSymbol,
        tokenLogoUri: cp.tokenLogoUri,
        connectedWalletColors: connectedColors,
      },
      position: posMap.get(cp.address) ?? { x: 0, y: 0 },
    });
  }

  // Build edges
  const edges: Edge[] = [];

  // Counterparty edges
  for (const e of cpEdges) {
    const volume = e.solSent + e.solReceived;
    const thickness = logScale(volume, maxVolume, 1, 6);
    const isOutflow = e.solSent > e.solReceived;
    edges.push({
      id: `${e.hubAddr}-${e.cpAddr}-${e.walletIndex}`,
      source: e.hubAddr,
      target: e.cpAddr,
      type: "flowEdge",
      data: {
        solSent: e.solSent,
        solReceived: e.solReceived,
        txCount: e.txCount,
        isOutflow,
        thickness,
        volume,
        maxVolume,
        walletColor: walletColors[e.walletIndex],
      },
    });
  }

  // Hub-to-hub edges
  for (const hh of hubToHubEdges) {
    const volume = hh.solSent + hh.solReceived;
    const thickness = logScale(volume, maxVolume, 1, 6);
    edges.push({
      id: `hub-${wallets[hh.sourceIdx].address}-${wallets[hh.targetIdx].address}`,
      source: wallets[hh.sourceIdx].address,
      target: wallets[hh.targetIdx].address,
      type: "flowEdge",
      data: {
        solSent: hh.solSent,
        solReceived: hh.solReceived,
        txCount: hh.txCount,
        isOutflow: hh.solSent > hh.solReceived,
        thickness,
        volume,
        maxVolume,
        walletColor: walletColors[hh.sourceIdx],
      },
    });
  }

  return { nodes, edges, forceSimData };
}
