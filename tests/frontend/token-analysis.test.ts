import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FundingSource, RpcTransaction } from "@/api";
import {
  getBatchIdentity,
  getBatchSolDomains,
  getFunding,
  getTokenAccountAddressesByOwner,
  gtfaPage,
} from "@/api";
import type { TokenHolder } from "@/birdeye-api";
import { scanBundles } from "@/lib/bundle-scan";
import { appendFundingNodes } from "@/lib/parse-funding-graph";
import { buildHolderGraphData } from "@/lib/parse-holders";
import { scanHolderConnections } from "@/lib/scan-holder-connections";
import { walkFundingHistory } from "@/lib/funding-walk";

vi.mock("@/api", () => ({
  gtfaPage: vi.fn(),
  getFunding: vi.fn(),
  getBatchIdentity: vi.fn(),
  getBatchSolDomains: vi.fn(),
  getTokenAccountAddressesByOwner: vi.fn(),
  resolveWalletInput: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/cache", () => ({
  cached: vi.fn(async (_namespace, _key, _ttlMs, fetcher) => fetcher()),
}));

function makeAddress(seed: number): string {
  return `${String(seed).padStart(32, "1")}AbCdEFGhijkLMNoPQRs`;
}

function makeHolder(owner: string, percentage: number): TokenHolder {
  return {
    owner,
    percentage,
    uiAmount: percentage * 1_000,
  };
}

function makeTokenBalance(accountIndex: number, owner: string, mint: string, amount: number) {
  return {
    accountIndex,
    owner,
    mint,
    uiTokenAmount: {
      uiAmount: amount,
      decimals: 0,
      amount: String(amount),
    },
  };
}

function makeTokenTransferTx({
  signature,
  slot,
  mint,
  fromOwner,
  toOwner,
  sourceTokenAccount,
  destinationTokenAccount,
  amount,
}: {
  signature: string;
  slot: number;
  mint: string;
  fromOwner: string;
  toOwner: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  amount: number;
}): RpcTransaction {
  return {
    slot,
    blockTime: slot,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [sourceTokenAccount, destinationTokenAccount],
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                source: sourceTokenAccount,
                destination: destinationTokenAccount,
                mint,
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
      preBalances: [0, 0],
      postBalances: [0, 0],
      preTokenBalances: [
        makeTokenBalance(0, fromOwner, mint, amount),
        makeTokenBalance(1, toOwner, mint, 0),
      ],
      postTokenBalances: [
        makeTokenBalance(0, fromOwner, mint, 0),
        makeTokenBalance(1, toOwner, mint, amount),
      ],
    },
  };
}

function makeOwnerDeltaTx({
  signature,
  slot,
  mint,
  owner,
  preAmount,
  postAmount,
}: {
  signature: string;
  slot: number;
  mint: string;
  owner: string;
  preAmount?: number;
  postAmount?: number;
}): RpcTransaction {
  return {
    slot,
    blockTime: slot,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [makeAddress(slot % 255)],
        instructions: [],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances:
        preAmount == null ? [] : [makeTokenBalance(0, owner, mint, preAmount)],
      postTokenBalances:
        postAmount == null ? [] : [makeTokenBalance(0, owner, mint, postAmount)],
    },
  };
}

function findConnection(
  connections: Array<{ source: string; target: string }>,
  a: string,
  b: string,
) {
  const connection = connections.find(
    (candidate) =>
      (candidate.source === a && candidate.target === b)
      || (candidate.source === b && candidate.target === a),
  );
  if (!connection) {
    throw new Error(`Missing connection for ${a} <-> ${b}`);
  }
  return connection;
}

describe("token analysis forensics", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(gtfaPage).mockReset();
    vi.mocked(getFunding).mockReset();
    vi.mocked(getBatchIdentity).mockReset();
    vi.mocked(getBatchSolDomains).mockReset();
    vi.mocked(getTokenAccountAddressesByOwner).mockReset();
    vi.mocked(getFunding).mockResolvedValue(null);
    vi.mocked(getBatchIdentity).mockResolvedValue(new Map());
    vi.mocked(getBatchSolDomains).mockResolvedValue(new Map());
    vi.mocked(getTokenAccountAddressesByOwner).mockResolvedValue([]);
  });

  it("dedupes a one-way transfer seen from both holders and keeps the flow one-sided", async () => {
    const mint = makeAddress(101);
    const holderA = makeAddress(11);
    const holderB = makeAddress(12);
    const tokenAccountA = makeAddress(13);
    const tokenAccountB = makeAddress(14);
    const sharedTx = makeTokenTransferTx({
      signature: "shared-one-way",
      slot: 100,
      mint,
      fromOwner: holderA,
      toOwner: holderB,
      sourceTokenAccount: tokenAccountA,
      destinationTokenAccount: tokenAccountB,
      amount: 25,
    });

    vi.mocked(getTokenAccountAddressesByOwner).mockImplementation(async (owner, targetMint) => {
      if (targetMint !== mint) return [];
      if (owner === holderA) return [tokenAccountA];
      if (owner === holderB) return [tokenAccountB];
      return [];
    });
    vi.mocked(gtfaPage).mockImplementation(async (address) => {
      if ([tokenAccountA, tokenAccountB, holderA, holderB].includes(address)) {
        return { txs: [sharedTx], nextToken: null };
      }
      throw new Error(`Unexpected address ${address}`);
    });

    const result = await scanHolderConnections(
      mint,
      [makeHolder(holderA, 18), makeHolder(holderB, 12)],
      50,
      vi.fn(),
    );
    const connection = findConnection(result.connections, holderA, holderB);

    expect(result.connections).toHaveLength(1);
    expect(connection.txCount).toBe(1);
    expect(connection.bidirectional).toBe(false);
    expect(connection.sourceToTargetTxCount).toBe(1);
    expect(connection.targetToSourceTxCount).toBe(0);
    expect(result.clusters).toHaveLength(0);
  });

  it("only clusters stronger bidirectional evidence, not a single incidental transfer", async () => {
    const mint = makeAddress(102);
    const holderA = makeAddress(21);
    const holderB = makeAddress(22);
    const holderC = makeAddress(23);
    const tokenAccountA = makeAddress(24);
    const tokenAccountB = makeAddress(25);
    const tokenAccountC = makeAddress(26);

    const aToB = makeTokenTransferTx({
      signature: "a-to-b",
      slot: 200,
      mint,
      fromOwner: holderA,
      toOwner: holderB,
      sourceTokenAccount: tokenAccountA,
      destinationTokenAccount: tokenAccountB,
      amount: 10,
    });
    const bToA = makeTokenTransferTx({
      signature: "b-to-a",
      slot: 201,
      mint,
      fromOwner: holderB,
      toOwner: holderA,
      sourceTokenAccount: tokenAccountB,
      destinationTokenAccount: tokenAccountA,
      amount: 12,
    });
    const aToC = makeTokenTransferTx({
      signature: "a-to-c",
      slot: 202,
      mint,
      fromOwner: holderA,
      toOwner: holderC,
      sourceTokenAccount: tokenAccountA,
      destinationTokenAccount: tokenAccountC,
      amount: 8,
    });

    vi.mocked(getTokenAccountAddressesByOwner).mockImplementation(async (owner, targetMint) => {
      if (targetMint !== mint) return [];
      if (owner === holderA) return [tokenAccountA];
      if (owner === holderB) return [tokenAccountB];
      if (owner === holderC) return [tokenAccountC];
      return [];
    });
    vi.mocked(gtfaPage).mockImplementation(async (address) => {
      if ([tokenAccountA, holderA].includes(address)) {
        return { txs: [aToB, bToA, aToC], nextToken: null };
      }
      if ([tokenAccountB, holderB].includes(address)) {
        return { txs: [aToB, bToA], nextToken: null };
      }
      if ([tokenAccountC, holderC].includes(address)) {
        return { txs: [aToC], nextToken: null };
      }
      throw new Error(`Unexpected address ${address}`);
    });

    const holders = [
      makeHolder(holderA, 15),
      makeHolder(holderB, 11),
      makeHolder(holderC, 7),
    ];
    const result = await scanHolderConnections(mint, holders, 50, vi.fn());
    const abConnection = findConnection(result.connections, holderA, holderB);
    const acConnection = findConnection(result.connections, holderA, holderC);
    const { edges } = buildHolderGraphData(holders, null, {
      mode: "connections",
      analysisScope: new Set(holders.map((holder) => holder.owner)),
      connections: result.connections,
      clusters: result.clusters,
    });

    expect(abConnection.txCount).toBe(2);
    expect(abConnection.bidirectional).toBe(true);
    expect(abConnection.evidenceScore).toBeGreaterThan(acConnection.evidenceScore);
    expect(acConnection.txCount).toBe(1);
    expect(acConnection.bidirectional).toBe(false);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].members).toEqual(
      expect.arrayContaining([holderA, holderB]),
    );
    expect(result.clusters[0].members).not.toContain(holderC);
    expect(edges).toHaveLength(2);
  });

  it("uses the first positive owner delta as the acquisition slot instead of the first token-account touch", async () => {
    const mint = makeAddress(103);
    const holderA = makeAddress(31);
    const holderB = makeAddress(32);
    const tokenAccountA = makeAddress(33);
    const tokenAccountB = makeAddress(34);

    vi.mocked(getTokenAccountAddressesByOwner).mockImplementation(async (owner, targetMint) => {
      if (targetMint !== mint) return [];
      if (owner === holderA) return [tokenAccountA];
      if (owner === holderB) return [tokenAccountB];
      return [];
    });
    vi.mocked(gtfaPage).mockImplementation(async (address) => {
      if (address === tokenAccountA) {
        return {
          txs: [
            makeOwnerDeltaTx({
              signature: "ata-touch-only",
              slot: 101,
              mint,
              owner: holderA,
              preAmount: 0,
              postAmount: 0,
            }),
            makeOwnerDeltaTx({
              signature: "acquire-a",
              slot: 105,
              mint,
              owner: holderA,
              postAmount: 50,
            }),
          ],
          nextToken: null,
        };
      }
      if (address === tokenAccountB) {
        return {
          txs: [
            makeOwnerDeltaTx({
              signature: "acquire-b",
              slot: 107,
              mint,
              owner: holderB,
              postAmount: 10,
            }),
          ],
          nextToken: null,
        };
      }
      if ([holderA, holderB].includes(address)) {
        return { txs: [], nextToken: null };
      }
      throw new Error(`Unexpected address ${address}`);
    });

    const result = await scanBundles(
      mint,
      [makeHolder(holderA, 9), makeHolder(holderB, 7)],
      100,
      vi.fn(),
    );

    expect(result.firstAcquisitionSlots.get(holderA)).toBe(105);
    expect(result.firstAcquisitionSlots.get(holderB)).toBe(107);
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0].members).toEqual(
      expect.arrayContaining([holderA, holderB]),
    );
  });

  it("renders intermediate ancestry nodes instead of flattening a common ancestor directly to holders", async () => {
    const holderA = makeAddress(41);
    const holderB = makeAddress(42);
    const intermediateA = makeAddress(43);
    const intermediateB = makeAddress(44);
    const commonAncestor = makeAddress(45);

    const fundingByAddress = new Map<string, FundingSource | null>([
      [holderA, { address: intermediateA, amount: 1.25 }],
      [holderB, { address: intermediateB, amount: 2.5 }],
      [intermediateA, { address: commonAncestor, amount: 5 }],
      [intermediateB, { address: commonAncestor, amount: 6 }],
      [commonAncestor, null],
    ]);

    vi.mocked(getFunding).mockImplementation(async (address) => {
      return fundingByAddress.get(address) ?? null;
    });

    const holders = [makeHolder(holderA, 14), makeHolder(holderB, 9)];
    const fundingResult = await walkFundingHistory(holders, 4, 2);
    const baseNodes: Node[] = [
      { id: "token-center", position: { x: 0, y: 0 }, data: {} },
      { id: holderA, position: { x: -120, y: 0 }, data: {} },
      { id: holderB, position: { x: 120, y: 0 }, data: {} },
    ];
    const graph = appendFundingNodes(baseNodes, fundingResult);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edgeIds = new Set(
      graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    );

    expect(fundingResult.commonFunders.map((node) => node.address)).toContain(
      commonAncestor,
    );
    expect(nodeIds.has(commonAncestor)).toBe(true);
    expect(nodeIds.has(intermediateA)).toBe(true);
    expect(nodeIds.has(intermediateB)).toBe(true);
    expect(edgeIds.has(`${commonAncestor}->${intermediateA}`)).toBe(true);
    expect(edgeIds.has(`${commonAncestor}->${intermediateB}`)).toBe(true);
    expect(edgeIds.has(`${intermediateA}->${holderA}`)).toBe(true);
    expect(edgeIds.has(`${intermediateB}->${holderB}`)).toBe(true);
    expect(edgeIds.has(`${commonAncestor}->${holderA}`)).toBe(false);
    expect(edgeIds.has(`${commonAncestor}->${holderB}`)).toBe(false);
  });
});
