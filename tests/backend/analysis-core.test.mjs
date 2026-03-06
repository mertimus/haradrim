// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analysisInternals } from "../../backend/src/analysis-core.mjs";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const COUNTERPARTY = "BgdZ8o5eG6u8dR6c2QxJmK5f4nLp2sT9vYw8aBcDeFg";
const ROUTER_PDA = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RANDOM_ACCOUNT = "Route11111111111111111111111111111111111111";

function createSystemTransferTx({
  signature,
  blockTime = 1_710_000_000,
  lamportsList,
}) {
  const fee = 5_000;
  const transferred = lamportsList.reduce((sum, value) => sum + value, 0);

  return {
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [WALLET, COUNTERPARTY, SYSTEM_PROGRAM_ID, ROUTER_PDA, RANDOM_ACCOUNT],
        instructions: lamportsList.map((lamports) => ({
          program: "system",
          programId: SYSTEM_PROGRAM_ID,
          parsed: {
            type: "transfer",
            info: {
              source: WALLET,
              destination: COUNTERPARTY,
              lamports: String(lamports),
            },
          },
        })),
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [3_000_000_000, 0, 0, 0, 0],
      postBalances: [3_000_000_000 - transferred - fee, transferred, 0, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

describe("analysisInternals.parseTransactions", () => {
  it("derives counterparties from explicit transfers, not co-occurring account keys", () => {
    const result = analysisInternals.parseTransactions(
      [createSystemTransferTx({ signature: "sig-1", lamportsList: [1_000_000_000] })],
      WALLET,
    );

    expect(result.counterparties).toHaveLength(1);
    expect(result.counterparties[0]).toMatchObject({
      address: COUNTERPARTY,
      txCount: 1,
      solSent: 1,
      solReceived: 0,
      solNet: -1,
      firstSeen: 1_710_000_000,
      lastSeen: 1_710_000_000,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].counterparties).toEqual([COUNTERPARTY]);
  });

  it("counts repeated transfers in one signature once per tx while preserving total volume", () => {
    const result = analysisInternals.parseTransactions(
      [createSystemTransferTx({ signature: "sig-2", lamportsList: [1_000_000_000, 500_000_000] })],
      WALLET,
    );

    expect(result.counterparties).toHaveLength(1);
    expect(result.counterparties[0].txCount).toBe(1);
    expect(result.counterparties[0].solSent).toBe(1.5);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].solChange).toBeCloseTo(-1.500005, 6);
  });
});
