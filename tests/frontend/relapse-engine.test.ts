import { describe, expect, it } from "vitest";
import { buildRelapseData } from "../../src/lib/relapse-engine";
import type { CounterpartyFlow, ParsedTransaction } from "../../src/lib/parse-transactions";

describe("buildRelapseData", () => {
  it("uses exact post-transaction wallet balances instead of summing deltas from zero", () => {
    const counterparties: CounterpartyFlow[] = [
      {
        address: "cp-1",
        txCount: 1,
        solSent: 1,
        solReceived: 0,
        solNet: -1,
        firstSeen: 100,
        lastSeen: 100,
      },
      {
        address: "cp-2",
        txCount: 1,
        solSent: 0,
        solReceived: 0.5,
        solNet: 0.5,
        firstSeen: 200,
        lastSeen: 200,
      },
    ];

    const transactions: ParsedTransaction[] = [
      {
        signature: "tx-1",
        timestamp: 100,
        solChange: -1,
        walletBalanceAfter: 9,
        counterparties: ["cp-1"],
        fee: 0.000005,
      },
      {
        signature: "tx-2",
        timestamp: 200,
        solChange: 0.5,
        walletBalanceAfter: 9.5,
        counterparties: ["cp-2"],
        fee: 0.000005,
      },
    ];

    const relapse = buildRelapseData(counterparties, transactions, []);

    expect(relapse.finalStats.walletBalance).toBe(9.5);
    expect(relapse.frames[0].stats.walletBalance).toBe(9);
  });
});
