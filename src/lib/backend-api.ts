import { API_BASE_URL } from "@/lib/constants";
import type { CounterpartyFlow, ParsedTransaction } from "@/lib/parse-transactions";
import type { TraceNodeFlows } from "@/lib/trace-types";

export interface WalletAnalysisResult {
  address: string;
  counterparties: CounterpartyFlow[];
  transactions: ParsedTransaction[];
  txCount: number;
  lastBlockTime: number;
}

function buildQuery(range?: { start?: number | null; end?: number | null }): string {
  if (!range) return "";
  const params = new URLSearchParams();
  if (range.start != null) params.set("start", String(range.start));
  if (range.end != null) params.set("end", String(range.end));
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(payload?.message ?? payload?.error ?? `Request failed (${res.status})`);
  }
  return payload as T;
}

export function getWalletAnalysis(
  address: string,
  range?: { start?: number | null; end?: number | null },
): Promise<WalletAnalysisResult> {
  return fetchJson<WalletAnalysisResult>(
    `/wallets/${address}/analysis${buildQuery(range)}`,
  );
}

export function getTraceAnalysis(
  address: string,
  range?: { start?: number | null; end?: number | null },
): Promise<TraceNodeFlows> {
  return fetchJson<TraceNodeFlows>(
    `/traces/${address}/flows${buildQuery(range)}`,
  );
}
