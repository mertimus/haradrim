// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildTokenHolderSnapshot } from "../../backend/src/token-snapshot-core.mjs";

const MINT = "Mint111111111111111111111111111111111111111";
const OWNER_A = "OwnerA1111111111111111111111111111111111111";
const OWNER_B = "OwnerB1111111111111111111111111111111111111";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
function largestAccount(owner, amount, decimals = 0) {
  return {
    owner,
    amount: String(amount),
    decimals,
  };
}

describe("buildTokenHolderSnapshot", () => {
  it("aggregates balances by owner across the largest-account slice and filters zero balances", async () => {
    const snapshot = await buildTokenHolderSnapshot(
      MINT,
      {},
      {
        rpcJson: async (method, params) => {
          if (method === "getTokenSupply") {
            expect(params).toEqual([MINT]);
            return { result: { value: { amount: "1000", decimals: 0, uiAmount: 1000 } } };
          }

          if (method === "getTokenLargestAccountsV2") {
            expect(params).toEqual([
              MINT,
              {
                commitment: "confirmed",
                limit: 10000,
              },
            ]);
            return {
              result: {
                value: {
                  accounts: [
                    largestAccount(OWNER_A, 100),
                    largestAccount(OWNER_A, 25),
                    largestAccount(OWNER_B, 50),
                    largestAccount(OWNER_B, 5),
                    largestAccount(OWNER_B, 0),
                  ],
                },
              },
            };
          }

          if (method === "getMultipleAccounts") {
            expect(params).toEqual([
              [OWNER_A, OWNER_B],
              { encoding: "jsonParsed", commitment: "confirmed" },
            ]);
            return {
              result: {
                value: [
                  { executable: false, owner: PUMP_AMM_PROGRAM },
                  { executable: false, owner: "11111111111111111111111111111111" },
                ],
              },
            };
          }

          throw new Error(`unexpected rpc call ${method}`);
        },
      },
    );

    expect(snapshot.mint).toBe(MINT);
    expect(snapshot.supply).toBe(1000);
    expect(snapshot.holderCount).toBe(2);
    expect(snapshot.holders).toEqual([
      {
        owner: OWNER_A,
        uiAmount: 125,
        percentage: 12.5,
        ownerAccountType: "other",
        ownerProgram: PUMP_AMM_PROGRAM,
        ownerProgramLabel: "Pump.fun AMM",
        label: "Pump.fun AMM",
      },
      {
        owner: OWNER_B,
        uiAmount: 55,
        percentage: 5.5,
        ownerAccountType: "wallet",
      },
    ]);
    expect(snapshot.snapshotAt).toEqual(expect.any(Number));
    expect(snapshot.source).toBe("helius:getTokenLargestAccountsV2");
    expect(snapshot.accountLimit).toBe(10000);
    expect(snapshot.partial).toBe(false);
    expect(snapshot.tokenAccountCount).toBe(5);
  });

  it("applies the optional holder limit after sorting", async () => {
    const snapshot = await buildTokenHolderSnapshot(
      MINT,
      { limit: 1 },
      {
        rpcJson: async (method, params) => {
          if (method === "getTokenSupply") {
            return { result: { value: { amount: "1000", decimals: 0, uiAmount: 1000 } } };
          }

          if (method === "getTokenLargestAccountsV2") {
            return {
              result: {
                value: {
                  accounts: [
                    largestAccount(OWNER_B, 50),
                    largestAccount(OWNER_A, 200),
                  ],
                },
              },
            };
          }

          if (method === "getMultipleAccounts") {
            return {
              result: {
                value: [
                  { executable: false, owner: "11111111111111111111111111111111" },
                ],
              },
            };
          }

          return { result: { value: { accounts: [] } } };
        },
      },
    );

    expect(snapshot.holderCount).toBe(1);
    expect(snapshot.holders).toEqual([
        {
          owner: OWNER_A,
          uiAmount: 200,
          percentage: 20,
          ownerAccountType: "wallet",
        },
      ]);
    expect(snapshot.accountLimit).toBe(100);
    expect(snapshot.ownerLimit).toBe(1);
  });

  it("fails closed when the mint supply cannot be loaded", async () => {
    await expect(
      buildTokenHolderSnapshot(
        MINT,
        {},
        {
          rpcJson: async (method) => {
            if (method === "getTokenSupply") {
              return { result: { value: { amount: "0", decimals: 0, uiAmount: 0 } } };
            }
            return { result: [] };
          },
        },
      ),
    ).rejects.toThrow("Unable to fetch token supply.");
  });
});
