// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccountTypesParallelMock = vi.fn();
const getBatchIdentityMock = vi.fn();
const getTokenMetadataBatchMock = vi.fn();

vi.mock("../../backend/src/providers.mjs", async () => {
  const actual = await vi.importActual("../../backend/src/providers.mjs");
  return {
    ...actual,
    getAccountTypesParallel: getAccountTypesParallelMock,
    getBatchIdentity: getBatchIdentityMock,
    getTokenMetadataBatch: getTokenMetadataBatchMock,
  };
});

const { analysisInternals } = await import("../../backend/src/analysis-core.mjs");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const COUNTERPARTY = "BgdZ8o5eG6u8dR6c2QxJmK5f4nLp2sT9vYw8aBcDeFg";
const FORWARDED_COUNTERPARTY = "DKDnaM3y9aGxCkVLqacqnzhbFzBMMBSffRcnkswEtoju";
const ROUTER_PDA = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RANDOM_ACCOUNT = "Route11111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const SOURCE_TOKEN = "SrcTok111111111111111111111111111111111111";
const MID_TOKEN = "MidTok111111111111111111111111111111111111";
const DEST_TOKEN = "DstTok111111111111111111111111111111111111";

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

beforeEach(() => {
  getAccountTypesParallelMock.mockReset();
  getBatchIdentityMock.mockReset();
  getTokenMetadataBatchMock.mockReset();
  getAccountTypesParallelMock.mockResolvedValue(new Map());
  getBatchIdentityMock.mockResolvedValue(new Map());
  getTokenMetadataBatchMock.mockResolvedValue(new Map());
});

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

describe("analysisInternals.parseTraceTransferEvents", () => {
  it("infers counterparty owners from initializeAccount3 for token transfers", () => {
    const events = analysisInternals.parseTraceTransferEvents([
      {
        blockTime: 1_710_000_000,
        transaction: {
          signatures: ["sig-token-init"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, SOURCE_TOKEN, DEST_TOKEN, MINT, TOKEN_PROGRAM_ID],
            instructions: [
              {
                program: "spl-token",
                programId: TOKEN_PROGRAM_ID,
                parsed: {
                  type: "initializeAccount3",
                  info: {
                    account: DEST_TOKEN,
                    mint: MINT,
                    owner: COUNTERPARTY,
                  },
                },
              },
              {
                program: "spl-token",
                programId: TOKEN_PROGRAM_ID,
                parsed: {
                  type: "transferChecked",
                  info: {
                    source: SOURCE_TOKEN,
                    destination: DEST_TOKEN,
                    mint: MINT,
                    authority: WALLET,
                    tokenAmount: {
                      amount: "4200000",
                      decimals: 6,
                    },
                  },
                },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 0, 0, 0, 0, 0],
          postBalances: [0, 0, 0, 0, 0, 0],
          preTokenBalances: [{
            accountIndex: 2,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: "4200000", decimals: 6, uiAmount: 4.2 },
          }],
          postTokenBalances: [],
        },
      },
    ], WALLET);

    expect(events).toEqual([expect.objectContaining({
      signature: "sig-token-init",
      direction: "outflow",
      counterparty: COUNTERPARTY,
      assetId: MINT,
      kind: "token",
      mint: MINT,
      rawAmount: "4200000",
      uiAmount: 4.2,
    })]);
  });

  it("surfaces closeAccount rent as a native SOL counterparty flow", () => {
    const events = analysisInternals.parseTraceTransferEvents([
      {
        blockTime: 1_710_000_010,
        transaction: {
          signatures: ["sig-close-account"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, SOURCE_TOKEN, TOKEN_PROGRAM_ID],
            instructions: [{
              program: "spl-token",
              programId: TOKEN_PROGRAM_ID,
              parsed: {
                type: "closeAccount",
                info: {
                  account: SOURCE_TOKEN,
                  destination: COUNTERPARTY,
                  owner: WALLET,
                },
              },
            }],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 2_039_280, 2_039_280, 0],
          postBalances: [0, 4_078_560, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      },
    ], WALLET);

    expect(events).toEqual([expect.objectContaining({
      signature: "sig-close-account",
      direction: "outflow",
      counterparty: COUNTERPARTY,
      assetId: "native:sol",
      kind: "native",
      rawAmount: "2039280",
      uiAmount: 0.00203928,
    })]);
  });

  it("infers a same-tx native pass-through only when order and amount match", () => {
    const events = analysisInternals.parseTraceTransferEvents([
      {
        blockTime: 1_710_000_020,
        transaction: {
          signatures: ["sig-native-forward"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, SYSTEM_PROGRAM_ID],
            instructions: [
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: WALLET,
                    destination: COUNTERPARTY,
                    lamports: "1000000000",
                  },
                },
              },
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: COUNTERPARTY,
                    destination: FORWARDED_COUNTERPARTY,
                    lamports: "1000000000",
                  },
                },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 0, 0, 0],
          postBalances: [0, 0, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      },
    ], WALLET);

    expect(events.filter((event) => event.counterparty === FORWARDED_COUNTERPARTY)).toEqual([
      expect.objectContaining({
        signature: "sig-native-forward",
        direction: "outflow",
        counterparty: FORWARDED_COUNTERPARTY,
        rawAmount: "1000000000",
        uiAmount: 1,
      }),
    ]);
  });

  it("does not infer a native pass-through for mismatched amounts or reversed order", () => {
    const events = analysisInternals.parseTraceTransferEvents([
      {
        blockTime: 1_710_000_021,
        transaction: {
          signatures: ["sig-native-mismatch"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, SYSTEM_PROGRAM_ID],
            instructions: [
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: WALLET,
                    destination: COUNTERPARTY,
                    lamports: "1",
                  },
                },
              },
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: COUNTERPARTY,
                    destination: FORWARDED_COUNTERPARTY,
                    lamports: "1000000000",
                  },
                },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 0, 0, 0],
          postBalances: [0, 0, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      },
      {
        blockTime: 1_710_000_022,
        transaction: {
          signatures: ["sig-native-reversed"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, SYSTEM_PROGRAM_ID],
            instructions: [
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: COUNTERPARTY,
                    destination: FORWARDED_COUNTERPARTY,
                    lamports: "1000000000",
                  },
                },
              },
              {
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: {
                  type: "transfer",
                  info: {
                    source: WALLET,
                    destination: COUNTERPARTY,
                    lamports: "1000000000",
                  },
                },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 0, 0, 0],
          postBalances: [0, 0, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      },
    ], WALLET);

    expect(events.filter((event) => event.counterparty === FORWARDED_COUNTERPARTY)).toHaveLength(0);
  });

  it("infers a same-tx token pass-through only when the downstream leg matches exactly", () => {
    const events = analysisInternals.parseTraceTransferEvents([
      {
        blockTime: 1_710_000_030,
        transaction: {
          signatures: ["sig-token-forward"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, SOURCE_TOKEN, MID_TOKEN, DEST_TOKEN, MINT, TOKEN_PROGRAM_ID],
            instructions: [
              {
                program: "spl-token",
                programId: TOKEN_PROGRAM_ID,
                parsed: {
                  type: "transferChecked",
                  info: {
                    source: SOURCE_TOKEN,
                    destination: MID_TOKEN,
                    mint: MINT,
                    authority: WALLET,
                    tokenAmount: {
                      amount: "4200000",
                      decimals: 6,
                    },
                  },
                },
              },
              {
                program: "spl-token",
                programId: TOKEN_PROGRAM_ID,
                parsed: {
                  type: "transferChecked",
                  info: {
                    source: MID_TOKEN,
                    destination: DEST_TOKEN,
                    mint: MINT,
                    authority: COUNTERPARTY,
                    tokenAmount: {
                      amount: "4200000",
                      decimals: 6,
                    },
                  },
                },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [0, 0, 0, 0, 0, 0, 0, 0],
          postBalances: [0, 0, 0, 0, 0, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 3,
              mint: MINT,
              owner: WALLET,
              uiTokenAmount: { amount: "4200000", decimals: 6, uiAmount: 4.2 },
            },
            {
              accountIndex: 4,
              mint: MINT,
              owner: COUNTERPARTY,
              uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 },
            },
            {
              accountIndex: 5,
              mint: MINT,
              owner: FORWARDED_COUNTERPARTY,
              uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 },
            },
          ],
          postTokenBalances: [],
        },
      },
    ], WALLET);

    expect(events.filter((event) => event.counterparty === FORWARDED_COUNTERPARTY)).toEqual([
      expect.objectContaining({
        signature: "sig-token-forward",
        direction: "outflow",
        counterparty: FORWARDED_COUNTERPARTY,
        assetId: MINT,
        kind: "token",
        rawAmount: "4200000",
        uiAmount: 4.2,
      }),
    ]);
  });
});

describe("analysisInternals.analyzeTraceEvents", () => {
  it("preserves standard SOL transfers even when the counterparty currently classifies as non-wallet", async () => {
    getAccountTypesParallelMock.mockResolvedValue(new Map([
      [COUNTERPARTY, { type: "program_owned" }],
    ]));

    let enrichedResult;
    const tx = createSystemTransferTx({ signature: "sig-sol-history", lamportsList: [172_000_000] });

    const fastResult = await analysisInternals.analyzeTraceEvents(WALLET, [tx], (value) => {
      enrichedResult = value;
    });

    expect(fastResult.events).toHaveLength(1);
    expect(fastResult.events[0]).toMatchObject({
      signature: "sig-sol-history",
      counterparty: COUNTERPARTY,
      assetId: "native:sol",
      kind: "native",
      uiAmount: 0.172,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enrichedResult?.events).toHaveLength(1);

    expect(enrichedResult.events[0]).toMatchObject({
      signature: "sig-sol-history",
      counterparty: COUNTERPARTY,
      assetId: "native:sol",
      kind: "native",
      rawAmount: "172000000",
      uiAmount: 0.172,
      counterpartyAccountType: "program_owned",
    });
  });
});
