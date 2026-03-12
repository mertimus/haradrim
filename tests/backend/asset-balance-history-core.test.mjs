// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analyzeWalletAssetBalanceHistory } from "../../backend/src/asset-balance-history-core.mjs";
import { NATIVE_SOL_ASSET_ID } from "../../backend/src/analysis-core.mjs";

const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const TOKEN_A = "TokenAMint11111111111111111111111111111111";
const TOKEN_B = "TokenBMint11111111111111111111111111111111";

function makeTokenBalance(accountIndex, owner, mint, amount, decimals = 6) {
  return {
    accountIndex,
    owner,
    mint,
    uiTokenAmount: {
      amount: String(amount),
      decimals,
      uiAmount: Number(amount) / 10 ** decimals,
    },
  };
}

function createTx({
  signature,
  blockTime,
  slot = blockTime,
  preLamports,
  postLamports,
  preTokenBalances = [],
  postTokenBalances = [],
}) {
  return {
    slot,
    blockTime,
    transactionIndex: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [WALLET, "wallet-token-a-1", "wallet-token-a-2", "wallet-token-b-1"],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [preLamports, 0, 0, 0],
      postBalances: [postLamports, 0, 0, 0],
      preTokenBalances,
      postTokenBalances,
    },
  };
}

describe("analyzeWalletAssetBalanceHistory", () => {
  it("builds histories for SOL plus current and former token holdings", async () => {
    const txs = [
      createTx({
        signature: "sig-1",
        blockTime: 100,
        preLamports: 1_000_000_000,
        postLamports: 1_500_000_000,
        preTokenBalances: [],
        postTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 2_000_000),
        ],
      }),
      createTx({
        signature: "sig-2",
        blockTime: 200,
        preLamports: 1_500_000_000,
        postLamports: 1_400_000_000,
        preTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 2_000_000),
        ],
        postTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 1_000_000),
          makeTokenBalance(2, WALLET, TOKEN_A, 1_000_000),
        ],
      }),
      createTx({
        signature: "sig-3",
        blockTime: 300,
        preLamports: 1_400_000_000,
        postLamports: 1_700_000_000,
        preTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 1_000_000),
          makeTokenBalance(2, WALLET, TOKEN_A, 1_000_000),
        ],
        postTokenBalances: [
          makeTokenBalance(3, WALLET, TOKEN_B, 5_000_000),
        ],
      }),
      createTx({
        signature: "sig-4",
        blockTime: 400,
        preLamports: 1_700_000_000,
        postLamports: 1_650_000_000,
        preTokenBalances: [
          makeTokenBalance(3, WALLET, TOKEN_B, 5_000_000),
        ],
        postTokenBalances: [
          makeTokenBalance(3, WALLET, TOKEN_B, 7_000_000),
        ],
      }),
    ];

    const result = await analyzeWalletAssetBalanceHistory(WALLET, {
      fetchTransactions: async () => txs,
      getCurrentTokenBalancesByOwner: async () => new Map([
        [TOKEN_B, { rawAmount: 7_000_000n, decimals: 6 }],
      ]),
      getTokenMetadataBatch: async () => new Map([
        [TOKEN_A, { symbol: "TKA", name: "Token A" }],
        [TOKEN_B, { symbol: "TKB", name: "Token B" }],
      ]),
    });

    expect(result.strategy).toBe("gtfa-wallet-assets");
    expect(result.txCount).toBe(4);
    expect(result.estimatedTxCount).toBe(4);
    expect(result.assetCount).toBe(3);
    expect(result.currentAssetCount).toBe(2);
    expect(result.historicalAssetCount).toBe(1);
    expect(result.firstTimestamp).toBe(100);
    expect(result.lastTimestamp).toBe(400);

    expect(result.assets.map((asset) => asset.assetId)).toEqual([
      NATIVE_SOL_ASSET_ID,
      TOKEN_B,
      TOKEN_A,
    ]);

    const sol = result.assets[0];
    expect(sol.currentlyHeld).toBe(true);
    expect(sol.currentBalance).toBe(1.65);
    expect(sol.pointCount).toBe(4);

    const tokenB = result.assets[1];
    expect(tokenB.symbol).toBe("TKB");
    expect(tokenB.currentlyHeld).toBe(true);
    expect(tokenB.currentBalance).toBe(7);
    expect(tokenB.pointCount).toBe(2);
    expect(tokenB.points.map((point) => point.signature)).toEqual(["sig-3", "sig-4"]);

    const tokenA = result.assets[2];
    expect(tokenA.symbol).toBe("TKA");
    expect(tokenA.currentlyHeld).toBe(false);
    expect(tokenA.currentBalance).toBe(0);
    expect(tokenA.startingBalance).toBe(0);
    expect(tokenA.maxBalance).toBe(2);
    expect(tokenA.pointCount).toBe(2);
    expect(tokenA.points.map((point) => point.signature)).toEqual(["sig-1", "sig-3"]);
  });

  it("returns an empty asset set when the wallet has no GTFA transactions", async () => {
    const result = await analyzeWalletAssetBalanceHistory(WALLET, {
      fetchTransactions: async () => [],
      getCurrentTokenBalancesByOwner: async () => new Map(),
      getTokenMetadataBatch: async () => new Map(),
    });

    expect(result).toEqual({
      address: WALLET,
      strategy: "gtfa-wallet-assets",
      txCount: 0,
      estimatedTxCount: 0,
      assetCount: 0,
      currentAssetCount: 0,
      historicalAssetCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      assets: [],
    });
  });

  it("uses the current owner balance snapshot to reconstruct mints spread across multiple token accounts", async () => {
    const txs = [
      createTx({
        signature: "sig-multi-account",
        blockTime: 100,
        preLamports: 2_000_000_000,
        postLamports: 1_999_995_000,
        preTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 10_000_000),
        ],
        postTokenBalances: [
          makeTokenBalance(1, WALLET, TOKEN_A, 5_000_000),
        ],
      }),
    ];

    const result = await analyzeWalletAssetBalanceHistory(WALLET, {
      fetchTransactions: async () => txs,
      getCurrentTokenBalancesByOwner: async () => new Map([
        [TOKEN_A, { rawAmount: 8_000_000n, decimals: 6 }],
      ]),
      getTokenMetadataBatch: async () => new Map([
        [TOKEN_A, { symbol: "TKA", name: "Token A" }],
      ]),
    });

    const tokenA = result.assets.find((asset) => asset.assetId === TOKEN_A);
    expect(tokenA).toBeTruthy();
    expect(tokenA.currentlyHeld).toBe(true);
    expect(tokenA.currentBalance).toBe(8);
    expect(tokenA.startingBalance).toBe(13);
    expect(tokenA.netChange).toBe(-5);
    expect(tokenA.pointCount).toBe(1);
    expect(tokenA.points[0]).toMatchObject({
      signature: "sig-multi-account",
      balance: 8,
      delta: -5,
    });
  });
});
