import type { CounterpartyFlow } from "@/lib/parse-transactions";
import type { CounterpartySortDir, CounterpartySortKey } from "@/components/CounterpartyTable";

function getSortValue<T extends CounterpartyFlow>(cp: T, key: CounterpartySortKey): number {
  switch (key) {
    case "tx":
      return cp.txCount;
    case "vol":
      return cp.solSent + cp.solReceived;
    case "net":
      return cp.solNet;
    case "last":
      return cp.lastSeen;
  }
}

export function sortCounterparties<T extends CounterpartyFlow>(
  counterparties: T[],
  sortKey: CounterpartySortKey | null,
  sortDir: CounterpartySortDir,
): T[] {
  if (!sortKey) {
    return [...counterparties].sort((a, b) => b.txCount - a.txCount);
  }
  const mul = sortDir === "desc" ? -1 : 1;
  return [...counterparties].sort(
    (a, b) => mul * (getSortValue(a, sortKey) - getSortValue(b, sortKey)),
  );
}
