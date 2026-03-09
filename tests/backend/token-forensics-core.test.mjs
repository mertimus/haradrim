// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analyzeTokenForensics } from "../../backend/src/token-forensics-core.mjs";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "Mint111111111111111111111111111111111111111";
const HOLDER_A = "HolderA111111111111111111111111111111111111";
const HOLDER_B = "HolderB111111111111111111111111111111111111";
const HOLDER_C = "HolderC111111111111111111111111111111111111";
const HOLDER_A_ATA = "HolderAATA11111111111111111111111111111111";
const HOLDER_B_ATA = "HolderBATA11111111111111111111111111111111";
const ROOT = "Root111111111111111111111111111111111111111";
const DISTRIBUTOR = "Distributor11111111111111111111111111111111";
const VENUE = "Venue11111111111111111111111111111111111111";
const VENUE_A_ATA = "VenueAATA11111111111111111111111111111111";
const VENUE_B_ATA = "VenueBATA11111111111111111111111111111111";
const FEE_PAYER = "FeePayer1111111111111111111111111111111111";
const SHARED_SIGNER = "Signer11111111111111111111111111111111111";

function createAcquisitionTx({
  signature,
  slot,
  owner,
  feePayer = FEE_PAYER,
  sharedSigner = SHARED_SIGNER,
}) {
  return {
    slot,
    blockTime: slot,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: feePayer, signer: true },
          { pubkey: owner, signer: true },
          { pubkey: sharedSigner, signer: true },
        ],
        instructions: [],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

function createDirectTransferTx({
  signature,
  slot,
  sourceOwner,
  destinationOwner,
  sourceTokenAccount,
  destinationTokenAccount,
  amount,
  sourceBefore,
  destinationBefore,
}) {
  return {
    slot,
    blockTime: slot,
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
                mint: MINT,
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
      fee: 5_000,
      preBalances: [0, 0, 0, 0],
      postBalances: [0, 0, 0, 0],
      preTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: sourceOwner,
          uiTokenAmount: { amount: String(sourceBefore), uiAmount: sourceBefore, decimals: 0 },
        },
        {
          accountIndex: 1,
          mint: MINT,
          owner: destinationOwner,
          uiTokenAmount: { amount: String(destinationBefore), uiAmount: destinationBefore, decimals: 0 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: MINT,
          owner: sourceOwner,
          uiTokenAmount: { amount: String(sourceBefore - amount), uiAmount: sourceBefore - amount, decimals: 0 },
        },
        {
          accountIndex: 1,
          mint: MINT,
          owner: destinationOwner,
          uiTokenAmount: { amount: String(destinationBefore + amount), uiAmount: destinationBefore + amount, decimals: 0 },
        },
      ],
    },
  };
}

function provenanceFor(wallet, signature, slot, acquiredUiAmount) {
  return {
    wallet,
    mint: MINT,
    maxDepth: 2,
    candidateLimit: 3,
    acquisition: {
      signature,
      slot,
      timestamp: slot,
      acquiredUiAmount,
      classification: "purchase_or_swap",
      paymentRequirements: [
        {
          upstream: {
            attribution: "exact",
            candidateSources: [
              {
                address: ROOT,
                label: "Root",
              },
            ],
          },
        },
      ],
      acquisitionTransfers: [],
    },
    notes: [],
  };
}

function provenanceWithDirectSource(wallet, signature, slot, acquiredUiAmount) {
  return {
    wallet,
    mint: MINT,
    maxDepth: 2,
    candidateLimit: 3,
    acquisition: {
      signature,
      slot,
      timestamp: slot,
      acquiredUiAmount,
      classification: "transfer_or_airdrop",
      paymentRequirements: [],
      acquisitionTransfers: [
        {
          address: DISTRIBUTOR,
          label: "Distributor",
          signature,
          timestamp: slot,
          rawAmount: String(acquiredUiAmount),
          uiAmount: acquiredUiAmount,
        },
      ],
    },
    notes: [],
  };
}

function identityMap(addresses) {
  return new Map(
    addresses.map((address) => [
      address,
      {
        name:
          address === ROOT
            ? "Root"
            : address === DISTRIBUTOR
              ? "Distributor"
            : address === FEE_PAYER
              ? "Shared Fee Payer"
              : address === SHARED_SIGNER
                ? "Shared Signer"
                : address === VENUE
                  ? "Raydium Pool"
                : undefined,
      },
    ]),
  );
}

function accountTypeMap(addresses, overrides = new Map()) {
  return new Map(addresses.map((address) => [address, { type: overrides.get(address) ?? "wallet" }]));
}

describe("analyzeTokenForensics", () => {
  it("dedupes mirrored direct-transfer history and combines controller, timing, and funding evidence", async () => {
    const transferTx = createDirectTransferTx({
      signature: "transfer-1",
      slot: 120,
      sourceOwner: HOLDER_A,
      destinationOwner: HOLDER_B,
      sourceTokenAccount: HOLDER_A_ATA,
      destinationTokenAccount: HOLDER_B_ATA,
      amount: 10,
      sourceBefore: 100,
      destinationBefore: 0,
    });

    const report = await analyzeTokenForensics(
      MINT,
      { scopeLimit: 3 },
      {
        buildTokenHolderSnapshot: async () => ({
          mint: MINT,
          supply: 1000,
          holderCount: 3,
          snapshotAt: 1_710_000_000,
          holders: [
            { owner: HOLDER_A, uiAmount: 120, percentage: 12 },
            { owner: HOLDER_B, uiAmount: 110, percentage: 11 },
            { owner: HOLDER_C, uiAmount: 40, percentage: 4 },
          ],
        }),
        fetchTransactions: async (address) => {
          if (address === HOLDER_A) {
            return [
              createAcquisitionTx({ signature: "buy-a", slot: 100, owner: HOLDER_A }),
              transferTx,
            ];
          }
          if (address === HOLDER_B) {
            return [
              createAcquisitionTx({ signature: "buy-b", slot: 102, owner: HOLDER_B }),
              transferTx,
            ];
          }
          return [];
        },
        analyzeWalletMintProvenance: async (wallet) => {
          if (wallet === HOLDER_A) return provenanceFor(HOLDER_A, "buy-a", 100, 100);
          if (wallet === HOLDER_B) return provenanceFor(HOLDER_B, "buy-b", 102, 102);
          return {
            wallet,
            mint: MINT,
            maxDepth: 2,
            candidateLimit: 3,
            acquisition: null,
            notes: [],
          };
        },
        getBatchIdentity: async (addresses) => identityMap(addresses),
        getAccountTypesParallel: async (addresses) => accountTypeMap(addresses),
        getTokenAccountAddressesByOwner: async () => [],
      },
    );

    expect(report.edges).toHaveLength(1);
    expect(report.clusters).toHaveLength(1);

    const edge = report.edges[0];
    expect(edge.source).toBe(HOLDER_A);
    expect(edge.target).toBe(HOLDER_B);
    expect(edge.directTransferTxCount).toBe(1);
    expect(edge.bidirectional).toBe(false);
    expect(edge.signalKinds).toEqual(
      expect.arrayContaining([
        "direct_transfer",
        "shared_fee_payer",
        "shared_signer",
        "shared_funding_ancestor",
        "synchronized_acquisition",
        "amount_similarity",
      ]),
    );
    expect(edge.sharedFeePayer).toMatchObject({
      address: FEE_PAYER,
      holdersSharing: 2,
    });
    expect(edge.sharedSigners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: SHARED_SIGNER,
          holdersSharing: 2,
        }),
      ]),
    );
    expect(edge.sharedFundingCount).toBe(1);

    expect(report.clusters[0]).toMatchObject({
      label: "Controller-Linked Cluster",
      members: [HOLDER_A, HOLDER_B],
    });
  });

  it("finds acquisition controller evidence on token-account history when wallet history misses the acquisition signature", async () => {
    const report = await analyzeTokenForensics(
      MINT,
      { scopeLimit: 2 },
      {
        buildTokenHolderSnapshot: async () => ({
          mint: MINT,
          supply: 1000,
          holderCount: 2,
          snapshotAt: 1_710_000_000,
          holders: [
            { owner: HOLDER_A, uiAmount: 120, percentage: 12 },
            { owner: HOLDER_B, uiAmount: 110, percentage: 11 },
          ],
        }),
        fetchTransactions: async (address) => {
          if (address === HOLDER_A_ATA) {
            return [createAcquisitionTx({ signature: "buy-a", slot: 100, owner: HOLDER_A })];
          }
          if (address === HOLDER_B_ATA) {
            return [createAcquisitionTx({ signature: "buy-b", slot: 101, owner: HOLDER_B })];
          }
          return [];
        },
        analyzeWalletMintProvenance: async (wallet) => {
          if (wallet === HOLDER_A) return provenanceFor(HOLDER_A, "buy-a", 100, 100);
          if (wallet === HOLDER_B) return provenanceFor(HOLDER_B, "buy-b", 101, 99);
          return null;
        },
        getBatchIdentity: async (addresses) => identityMap(addresses),
        getAccountTypesParallel: async (addresses) => accountTypeMap(addresses),
        getTokenAccountAddressesByOwner: async (owner) => {
          if (owner === HOLDER_A) return [HOLDER_A_ATA];
          if (owner === HOLDER_B) return [HOLDER_B_ATA];
          return [];
        },
      },
    );

    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].signalKinds).toEqual(
      expect.arrayContaining(["shared_fee_payer", "shared_signer"]),
    );
    expect(report.clusters[0]?.label).toBe("Controller-Linked Cluster");
  });

  it("promotes shared direct token source evidence into a distribution cluster", async () => {
    const report = await analyzeTokenForensics(
      MINT,
      { scopeLimit: 2 },
      {
        buildTokenHolderSnapshot: async () => ({
          mint: MINT,
          supply: 1000,
          holderCount: 2,
          snapshotAt: 1_710_000_000,
          holders: [
            { owner: HOLDER_A, uiAmount: 80, percentage: 8 },
            { owner: HOLDER_B, uiAmount: 79, percentage: 7.9 },
          ],
        }),
        fetchTransactions: async (address) => {
          if (address === HOLDER_A) {
            return [
              createAcquisitionTx({
                signature: "buy-a",
                slot: 100,
                owner: HOLDER_A,
                feePayer: "FeePayerA1111111111111111111111111111111",
                sharedSigner: "SignerA111111111111111111111111111111111",
              }),
            ];
          }
          if (address === HOLDER_B) {
            return [
              createAcquisitionTx({
                signature: "buy-b",
                slot: 101,
                owner: HOLDER_B,
                feePayer: "FeePayerB1111111111111111111111111111111",
                sharedSigner: "SignerB111111111111111111111111111111111",
              }),
            ];
          }
          return [];
        },
        analyzeWalletMintProvenance: async (wallet) => {
          if (wallet === HOLDER_A) return provenanceWithDirectSource(HOLDER_A, "buy-a", 100, 80);
          if (wallet === HOLDER_B) return provenanceWithDirectSource(HOLDER_B, "buy-b", 101, 79);
          return null;
        },
        getBatchIdentity: async (addresses) => identityMap(addresses),
        getAccountTypesParallel: async (addresses) => accountTypeMap(addresses),
        getTokenAccountAddressesByOwner: async () => [],
      },
    );

    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].signalKinds).toEqual(
      expect.arrayContaining(["shared_token_source", "synchronized_acquisition"]),
    );
    expect(report.edges[0].sharedTokenSource).toMatchObject({
      address: DISTRIBUTOR,
      label: "Distributor",
    });
    expect(report.clusters[0]).toMatchObject({
      label: "Shared-Source Bundle",
      sharedTokenSourcePairs: 1,
    });
    expect(report.summary.directDistributionPairs).toBe(1);
  });

  it("flags wash-like trading when controller-linked holders churn through the same venue", async () => {
    const report = await analyzeTokenForensics(
      MINT,
      { scopeLimit: 2 },
      {
        buildTokenHolderSnapshot: async () => ({
          mint: MINT,
          supply: 1000,
          holderCount: 2,
          snapshotAt: 1_710_000_000,
          holders: [
            { owner: HOLDER_A, uiAmount: 20, percentage: 2 },
            { owner: HOLDER_B, uiAmount: 22, percentage: 2.2 },
          ],
        }),
        fetchTransactions: async (address) => {
          if (address === HOLDER_A) {
            return [
              createAcquisitionTx({ signature: "buy-a", slot: 100, owner: HOLDER_A }),
              createDirectTransferTx({
                signature: "venue-buy-a",
                slot: 120,
                sourceOwner: VENUE,
                destinationOwner: HOLDER_A,
                sourceTokenAccount: VENUE_A_ATA,
                destinationTokenAccount: HOLDER_A_ATA,
                amount: 60,
                sourceBefore: 2_000,
                destinationBefore: 0,
              }),
              createDirectTransferTx({
                signature: "venue-sell-a",
                slot: 135,
                sourceOwner: HOLDER_A,
                destinationOwner: VENUE,
                sourceTokenAccount: HOLDER_A_ATA,
                destinationTokenAccount: VENUE_A_ATA,
                amount: 55,
                sourceBefore: 60,
                destinationBefore: 1_940,
              }),
            ];
          }
          if (address === HOLDER_B) {
            return [
              createAcquisitionTx({ signature: "buy-b", slot: 101, owner: HOLDER_B }),
              createDirectTransferTx({
                signature: "venue-buy-b",
                slot: 122,
                sourceOwner: VENUE,
                destinationOwner: HOLDER_B,
                sourceTokenAccount: VENUE_B_ATA,
                destinationTokenAccount: HOLDER_B_ATA,
                amount: 58,
                sourceBefore: 2_100,
                destinationBefore: 0,
              }),
              createDirectTransferTx({
                signature: "venue-sell-b",
                slot: 138,
                sourceOwner: HOLDER_B,
                destinationOwner: VENUE,
                sourceTokenAccount: HOLDER_B_ATA,
                destinationTokenAccount: VENUE_B_ATA,
                amount: 53,
                sourceBefore: 58,
                destinationBefore: 2_042,
              }),
            ];
          }
          return [];
        },
        analyzeWalletMintProvenance: async (wallet) => {
          if (wallet === HOLDER_A) return provenanceFor(HOLDER_A, "buy-a", 100, 60);
          if (wallet === HOLDER_B) return provenanceFor(HOLDER_B, "buy-b", 101, 58);
          return null;
        },
        getBatchIdentity: async (addresses) => identityMap(addresses),
        getAccountTypesParallel: async (addresses) =>
          accountTypeMap(addresses, new Map([[VENUE, "program"]])),
        getTokenAccountAddressesByOwner: async () => [],
      },
    );

    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].signalKinds).toEqual(
      expect.arrayContaining(["shared_trading_venue", "shared_fee_payer", "shared_signer"]),
    );
    expect(report.clusters[0]).toMatchObject({
      label: "Wash-Like Trading",
      sharedTradingVenuePairs: 1,
      twoWayTradeWallets: 2,
    });
    expect(report.clusters[0].churnRatio).toBeGreaterThanOrEqual(4);
    expect(report.summary.washLikeClusters).toBe(1);
  });
});
