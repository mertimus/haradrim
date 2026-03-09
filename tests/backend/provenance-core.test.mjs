// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analyzeWalletMintProvenance } from "../../backend/src/provenance-core.mjs";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NATIVE_SOL_ASSET_ID = "native:sol";

const HOLDER = "Holder11111111111111111111111111111111111111";
const FUNDER_A = "FundrA1111111111111111111111111111111111111";
const FUNDER_B = "FundrB1111111111111111111111111111111111111";
const ROOT = "Root111111111111111111111111111111111111111";
const DEX = "Dex1111111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const POOL_OWNER = "Pool111111111111111111111111111111111111111";
const HOLDER_ATA = "HoldATA111111111111111111111111111111111111";
const POOL_ATA = "PoolATA111111111111111111111111111111111111";

function accountTypeDeps(extra = {}) {
  const defaults = {
    [HOLDER]: { type: "wallet" },
    [FUNDER_A]: { type: "wallet" },
    [FUNDER_B]: { type: "wallet" },
    [ROOT]: { type: "wallet" },
    [DEX]: { type: "program" },
    [POOL_OWNER]: { type: "program" },
  };
  return { ...defaults, ...extra };
}

function createDeps(transactionMap, options = {}) {
  const accountTypes = accountTypeDeps(options.accountTypes);
  const identities = options.identities ?? {};
  const tokenAccounts = options.tokenAccounts ?? {};

  return {
    fetchTransactions: async (address) => transactionMap[address] ?? [],
    getTokenAccountAddressesByOwner: async (owner, mint) =>
      tokenAccounts[`${owner}:${mint}`] ?? [],
    getAccountTypesParallel: async (addresses) =>
      new Map(addresses.map((address) => [address, accountTypes[address] ?? { type: "unknown" }])),
    getBatchIdentity: async (addresses) =>
      new Map(
        addresses
          .filter((address) => identities[address])
          .map((address) => [address, identities[address]]),
      ),
    getTokenMetadataBatch: async (mints) =>
      new Map(
        mints.map((mint) => [
          mint,
          mint === MINT
            ? { symbol: "TOK", name: "Token" }
            : { symbol: "USDC", name: "USD Coin" },
        ]),
      ),
  };
}

function createSolTransferTx({
  signature,
  blockTime,
  source,
  destination,
  lamports,
  sourceBalanceBeforeLamports,
  destinationBalanceBeforeLamports = 0,
}) {
  const fee = 5_000;
  return {
    slot: blockTime,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [source, destination, SYSTEM_PROGRAM_ID],
        instructions: [
          {
            program: "system",
            programId: SYSTEM_PROGRAM_ID,
            parsed: {
              type: "transfer",
              info: {
                source,
                destination,
                lamports: String(lamports),
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [sourceBalanceBeforeLamports, destinationBalanceBeforeLamports, 0],
      postBalances: [
        sourceBalanceBeforeLamports - lamports - fee,
        destinationBalanceBeforeLamports + lamports,
        0,
      ],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

function createTokenTransferTx({
  signature,
  blockTime,
  mint,
  sourceOwner,
  sourceTokenAccount,
  destinationOwner,
  destinationTokenAccount,
  amount,
  sourceBefore,
  destinationBefore,
}) {
  const fee = 5_000;
  return {
    slot: blockTime,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          sourceTokenAccount,
          destinationTokenAccount,
          sourceOwner,
          TOKEN_PROGRAM_ID,
        ],
        instructions: [
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                source: sourceTokenAccount,
                destination: destinationTokenAccount,
                mint,
                authority: sourceOwner,
                tokenAmount: {
                  amount: String(amount),
                  decimals: 0,
                },
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [0, 0, 1_000_000, 0],
      postBalances: [0, 0, 995_000, 0],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint,
          owner: sourceOwner,
          uiTokenAmount: { amount: String(sourceBefore), uiAmount: sourceBefore, decimals: 0 },
        },
        {
          accountIndex: 1,
          mint,
          owner: destinationOwner,
          uiTokenAmount: { amount: String(destinationBefore), uiAmount: destinationBefore, decimals: 0 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint,
          owner: sourceOwner,
          uiTokenAmount: { amount: String(sourceBefore - amount), uiAmount: sourceBefore - amount, decimals: 0 },
        },
        {
          accountIndex: 1,
          mint,
          owner: destinationOwner,
          uiTokenAmount: { amount: String(destinationBefore + amount), uiAmount: destinationBefore + amount, decimals: 0 },
        },
      ],
    },
  };
}

function createPurchaseTx({
  signature,
  blockTime,
  buyer,
  destination,
  spendLamports,
  buyerBalanceBeforeLamports,
  mint,
  poolOwner,
  poolTokenAccount,
  buyerTokenAccount,
  acquiredAmount,
  buyerTokenBefore = 0,
  poolTokenBefore = 1_000,
}) {
  const fee = 5_000;
  return {
    slot: blockTime,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          buyer,
          destination,
          poolTokenAccount,
          buyerTokenAccount,
          poolOwner,
          TOKEN_PROGRAM_ID,
          SYSTEM_PROGRAM_ID,
        ],
        instructions: [
          {
            program: "system",
            programId: SYSTEM_PROGRAM_ID,
            parsed: {
              type: "transfer",
              info: {
                source: buyer,
                destination,
                lamports: String(spendLamports),
              },
            },
          },
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                source: poolTokenAccount,
                destination: buyerTokenAccount,
                mint,
                authority: poolOwner,
                tokenAmount: {
                  amount: String(acquiredAmount),
                  decimals: 0,
                },
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [buyerBalanceBeforeLamports, 0, 0, 0, 1_000_000, 0, 0],
      postBalances: [buyerBalanceBeforeLamports - spendLamports - fee, spendLamports, 0, 0, 995_000, 0, 0],
      preTokenBalances: [
        {
          accountIndex: 2,
          mint,
          owner: poolOwner,
          uiTokenAmount: { amount: String(poolTokenBefore), uiAmount: poolTokenBefore, decimals: 0 },
        },
        {
          accountIndex: 3,
          mint,
          owner: buyer,
          uiTokenAmount: { amount: String(buyerTokenBefore), uiAmount: buyerTokenBefore, decimals: 0 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint,
          owner: poolOwner,
          uiTokenAmount: { amount: String(poolTokenBefore - acquiredAmount), uiAmount: poolTokenBefore - acquiredAmount, decimals: 0 },
        },
        {
          accountIndex: 3,
          mint,
          owner: buyer,
          uiTokenAmount: { amount: String(buyerTokenBefore + acquiredAmount), uiAmount: buyerTokenBefore + acquiredAmount, decimals: 0 },
        },
      ],
    },
  };
}

describe("analyzeWalletMintProvenance", () => {
  it("finds acquisitions from token-account history even when the wallet address history misses them", async () => {
    const airdropTx = createTokenTransferTx({
      signature: "sig-airdrop",
      blockTime: 100,
      mint: MINT,
      sourceOwner: POOL_OWNER,
      sourceTokenAccount: POOL_ATA,
      destinationOwner: HOLDER,
      destinationTokenAccount: HOLDER_ATA,
      amount: 50,
      sourceBefore: 1_000,
      destinationBefore: 0,
    });

    const deps = createDeps(
      {
        [HOLDER]: [],
        [HOLDER_ATA]: [airdropTx],
      },
      {
        tokenAccounts: {
          [`${HOLDER}:${MINT}`]: [HOLDER_ATA],
        },
      },
    );

    const result = await analyzeWalletMintProvenance(HOLDER, MINT, {}, deps);

    expect(result.acquisition?.signature).toBe("sig-airdrop");
    expect(result.acquisition?.classification).toBe("transfer_or_airdrop");
    expect(result.acquisition?.paymentRequirements).toHaveLength(0);
    expect(result.acquisition?.acquisitionTransfers[0]).toMatchObject({
      address: POOL_OWNER,
      uiAmount: 50,
      stopReason: "non_wallet_account",
    });
  });

  it("marks a single-source purchase as exact and traces the upstream wallet", async () => {
    const rootToA = createSolTransferTx({
      signature: "sig-root-a",
      blockTime: 100,
      source: ROOT,
      destination: FUNDER_A,
      lamports: 8_000_000_000,
      sourceBalanceBeforeLamports: 20_000_000_000,
    });
    const aToHolder = createSolTransferTx({
      signature: "sig-a-holder",
      blockTime: 110,
      source: FUNDER_A,
      destination: HOLDER,
      lamports: 8_000_000_000,
      sourceBalanceBeforeLamports: 8_000_000_000,
    });
    const buy = createPurchaseTx({
      signature: "sig-buy",
      blockTime: 120,
      buyer: HOLDER,
      destination: DEX,
      spendLamports: 8_000_000_000,
      buyerBalanceBeforeLamports: 8_000_000_000,
      mint: MINT,
      poolOwner: POOL_OWNER,
      poolTokenAccount: POOL_ATA,
      buyerTokenAccount: HOLDER_ATA,
      acquiredAmount: 100,
    });

    const deps = createDeps({
      [HOLDER]: [aToHolder, buy],
      [FUNDER_A]: [rootToA, aToHolder],
      [ROOT]: [rootToA],
    });

    const result = await analyzeWalletMintProvenance(
      HOLDER,
      MINT,
      { maxDepth: 2 },
      deps,
    );

    const payment = result.acquisition?.paymentRequirements[0];
    expect(payment).toMatchObject({
      assetId: NATIVE_SOL_ASSET_ID,
      attribution: "exact",
      uiAmount: 8,
      balanceBeforeUiAmount: 8,
      pooledBalanceBeforeUiAmount: 0,
      coveredByCandidateSourcesUiAmount: 8,
    });
    expect(payment.upstream?.candidateSources).toHaveLength(1);
    expect(payment.upstream?.candidateSources[0]).toMatchObject({
      address: FUNDER_A,
      uiAmount: 8,
    });
    expect(payment.upstream?.candidateSources[0].upstream).toMatchObject({
      attribution: "exact",
    });
  });

  it("marks mixed-source funding as possible instead of collapsing it to one funder", async () => {
    const aToHolder = createSolTransferTx({
      signature: "sig-a-holder",
      blockTime: 100,
      source: FUNDER_A,
      destination: HOLDER,
      lamports: 4_000_000_000,
      sourceBalanceBeforeLamports: 4_000_000_000,
    });
    const bToHolder = createSolTransferTx({
      signature: "sig-b-holder",
      blockTime: 110,
      source: FUNDER_B,
      destination: HOLDER,
      lamports: 8_000_000_000,
      sourceBalanceBeforeLamports: 8_000_000_000,
    });
    const buy = createPurchaseTx({
      signature: "sig-buy",
      blockTime: 120,
      buyer: HOLDER,
      destination: DEX,
      spendLamports: 10_000_000_000,
      buyerBalanceBeforeLamports: 12_000_000_000,
      mint: MINT,
      poolOwner: POOL_OWNER,
      poolTokenAccount: POOL_ATA,
      buyerTokenAccount: HOLDER_ATA,
      acquiredAmount: 100,
    });

    const deps = createDeps({
      [HOLDER]: [aToHolder, bToHolder, buy],
      [FUNDER_A]: [aToHolder],
      [FUNDER_B]: [bToHolder],
    });

    const result = await analyzeWalletMintProvenance(HOLDER, MINT, {}, deps);
    const payment = result.acquisition?.paymentRequirements[0];

    expect(payment?.attribution).toBe("possible");
    expect(payment?.uiAmount).toBe(10);
    expect(payment?.coveredByCandidateSourcesUiAmount).toBe(10);
    expect(payment?.pooledBalanceBeforeUiAmount).toBe(0);
    expect(payment?.upstream?.candidateSources).toHaveLength(2);
    expect(payment?.upstream?.candidateSources.map((source) => source.address)).toEqual([
      FUNDER_B,
      FUNDER_A,
    ]);
  });

  it("surfaces token origin when no payment asset outflow exists", async () => {
    const rootToSource = createTokenTransferTx({
      signature: "sig-root-source",
      blockTime: 90,
      mint: MINT,
      sourceOwner: ROOT,
      sourceTokenAccount: "RootATA11111111111111111111111111111111111",
      destinationOwner: FUNDER_A,
      destinationTokenAccount: "SrcATA111111111111111111111111111111111111",
      amount: 50,
      sourceBefore: 100,
      destinationBefore: 0,
    });
    const sourceToHolder = createTokenTransferTx({
      signature: "sig-source-holder",
      blockTime: 100,
      mint: MINT,
      sourceOwner: FUNDER_A,
      sourceTokenAccount: "SrcATA111111111111111111111111111111111111",
      destinationOwner: HOLDER,
      destinationTokenAccount: HOLDER_ATA,
      amount: 50,
      sourceBefore: 50,
      destinationBefore: 0,
    });

    const deps = createDeps(
      {
        [HOLDER]: [],
        [HOLDER_ATA]: [sourceToHolder],
        [FUNDER_A]: [rootToSource, sourceToHolder],
        ["SrcATA111111111111111111111111111111111111"]: [rootToSource, sourceToHolder],
      },
      {
        tokenAccounts: {
          [`${HOLDER}:${MINT}`]: [HOLDER_ATA],
          [`${FUNDER_A}:${MINT}`]: ["SrcATA111111111111111111111111111111111111"],
        },
      },
    );

    const result = await analyzeWalletMintProvenance(HOLDER, MINT, {}, deps);

    expect(result.notes[0]).toContain("No explicit payment-asset outflow");
    expect(result.acquisition?.acquisitionTransfers[0]).toMatchObject({
      address: FUNDER_A,
      uiAmount: 50,
    });
    expect(result.acquisition?.acquisitionTransfers[0].upstream).toMatchObject({
      attribution: "exact",
    });
  });
});
