import { describe, expect, it } from "vitest";
import { buildGraphData, parseTraceTransferEvents } from "@/lib/parse-transactions";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const COUNTERPARTY = "BgdZ8o5eG6u8dR6c2QxJmK5f4nLp2sT9vYw8aBcDeFg";
const FORWARDED_COUNTERPARTY = "DKDnaM3y9aGxCkVLqacqnzhbFzBMMBSffRcnkswEtoju";
const MINT = "Mint111111111111111111111111111111111111111";
const SOURCE_TOKEN = "SrcTok111111111111111111111111111111111111";
const MID_TOKEN = "MidTok111111111111111111111111111111111111";
const DEST_TOKEN = "DstTok111111111111111111111111111111111111";

describe("buildGraphData", () => {
  it("places two single-wallet counterparties at different positions", () => {
    const graph = buildGraphData(
      "8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y",
      [
        {
          address: "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
          txCount: 331,
          solSent: 0.03,
          solReceived: 0,
          solNet: -0.03,
          firstSeen: 1712534400,
          lastSeen: 1738281600,
        },
        {
          address: "7MytW5N5m2b7sE4NABhWmfw3uD9hDk8i7vN7hDzDkX1",
          txCount: 226,
          solSent: 0,
          solReceived: 0.04,
          solNet: 0.04,
          firstSeen: 1699574400,
          lastSeen: 1730851200,
        },
      ],
      null,
      undefined,
      50,
    );

    const first = graph.nodes.find((node) => node.id === "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL");
    const second = graph.nodes.find((node) => node.id === "7MytW5N5m2b7sE4NABhWmfw3uD9hDk8i7vN7hDzDkX1");

    expect(first?.position).toBeTruthy();
    expect(second?.position).toBeTruthy();
    expect(first?.position).not.toEqual(second?.position);
  });
});

describe("parseTraceTransferEvents", () => {
  it("infers token counterparties from initializeAccount3", () => {
    const events = parseTraceTransferEvents([
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
      } as never,
    ], WALLET);

    expect(events).toEqual([expect.objectContaining({
      signature: "sig-token-init",
      direction: "outflow",
      counterparty: COUNTERPARTY,
      assetId: MINT,
      kind: "token",
      rawAmount: "4200000",
      uiAmount: 4.2,
    })]);
  });

  it("surfaces closeAccount rent as a native SOL trace event", () => {
    const events = parseTraceTransferEvents([
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
      } as never,
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
    const events = parseTraceTransferEvents([
      {
        blockTime: 1_710_000_020,
        transaction: {
          signatures: ["sig-native-forward"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, "11111111111111111111111111111111"],
            instructions: [
              {
                program: "system",
                programId: "11111111111111111111111111111111",
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
                programId: "11111111111111111111111111111111",
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
      } as never,
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
    const events = parseTraceTransferEvents([
      {
        blockTime: 1_710_000_021,
        transaction: {
          signatures: ["sig-native-mismatch"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, "11111111111111111111111111111111"],
            instructions: [
              {
                program: "system",
                programId: "11111111111111111111111111111111",
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
                programId: "11111111111111111111111111111111",
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
      } as never,
      {
        blockTime: 1_710_000_022,
        transaction: {
          signatures: ["sig-native-reversed"],
          message: {
            accountKeys: [WALLET, COUNTERPARTY, FORWARDED_COUNTERPARTY, "11111111111111111111111111111111"],
            instructions: [
              {
                program: "system",
                programId: "11111111111111111111111111111111",
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
                programId: "11111111111111111111111111111111",
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
      } as never,
    ], WALLET);

    expect(events.filter((event) => event.counterparty === FORWARDED_COUNTERPARTY)).toHaveLength(0);
  });

  it("infers a same-tx token pass-through only when the downstream leg matches exactly", () => {
    const events = parseTraceTransferEvents([
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
      } as never,
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
