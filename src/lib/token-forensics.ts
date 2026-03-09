import type { RpcTransaction } from "@/api";
import { parseTraceTransferEvents } from "@/lib/parse-transactions";

export interface OwnerMintTransferEvent {
  signature: string;
  timestamp: number;
  source: string;
  target: string;
  rawAmount: string;
  uiAmount: number;
}

interface OwnerTokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
  };
}

function aggregateOwnerMintBalance(
  balances: OwnerTokenBalance[] | undefined,
  owner: string,
  mint: string,
): bigint {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.owner !== owner || balance.mint !== mint) continue;
    try {
      total += BigInt(balance.uiTokenAmount.amount);
    } catch {
      // Ignore malformed balances from upstream.
    }
  }
  return total;
}

export function computeOwnerMintDelta(
  tx: RpcTransaction,
  owner: string,
  mint: string,
): bigint {
  if (!tx.meta) return 0n;
  const pre = aggregateOwnerMintBalance(tx.meta.preTokenBalances, owner, mint);
  const post = aggregateOwnerMintBalance(tx.meta.postTokenBalances, owner, mint);
  return post - pre;
}

export function extractOwnerMintTransfers(
  txs: RpcTransaction[],
  owner: string,
  mint: string,
  allowedCounterparties?: Set<string>,
): OwnerMintTransferEvent[] {
  return parseTraceTransferEvents(txs, owner)
    .filter((event) => {
      if (event.kind !== "token" || event.mint !== mint) return false;
      if (!allowedCounterparties) return true;
      return allowedCounterparties.has(event.counterparty);
    })
    .map((event) => ({
      signature: event.signature,
      timestamp: event.timestamp,
      source: event.direction === "outflow" ? owner : event.counterparty,
      target: event.direction === "outflow" ? event.counterparty : owner,
      rawAmount: event.rawAmount,
      uiAmount: event.uiAmount,
    }))
    .filter((event) => event.source !== event.target);
}

export function findFirstOwnerMintAcquisition(
  txs: RpcTransaction[],
  owner: string,
  mint: string,
): RpcTransaction | null {
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    if (computeOwnerMintDelta(tx, owner, mint) > 0n) return tx;
  }
  return null;
}
