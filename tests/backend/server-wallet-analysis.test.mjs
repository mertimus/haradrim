// @vitest-environment node

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzeWalletMock = vi.fn();
const getTraceTargetProfileMock = vi.fn();
const getTxCountForAddressMock = vi.fn();

vi.mock("../../backend/src/analysis-core.mjs", async () => {
  const actual = await vi.importActual("../../backend/src/analysis-core.mjs");
  return {
    ...actual,
    analyzeWallet: analyzeWalletMock,
  };
});

vi.mock("../../backend/src/providers.mjs", async () => {
  const actual = await vi.importActual("../../backend/src/providers.mjs");
  return {
    ...actual,
    getTraceTargetProfile: getTraceTargetProfileMock,
    getTxCountForAddress: getTxCountForAddressMock,
  };
});

const { clearCache } = await import("../../backend/src/cache.mjs");
const { serverInternals } = await import("../../backend/src/server.mjs");

const ADDRESS = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";

function createServer() {
  return http.createServer((req, res) => {
    void serverInternals.requestHandler(req, res);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind test server"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("wallet analysis server policy", () => {
  beforeEach(() => {
    clearCache();
    analyzeWalletMock.mockReset();
    getTraceTargetProfileMock.mockReset();
    getTxCountForAddressMock.mockReset();
    getTraceTargetProfileMock.mockResolvedValue({
      address: ADDRESS,
      accountType: "wallet",
      onCurve: true,
      walletLike: true,
      exists: true,
      executable: false,
      owner: "11111111111111111111111111111111",
      dataLen: 0,
    });
    getTxCountForAddressMock.mockResolvedValue(10_000);
    analyzeWalletMock.mockResolvedValue({
      address: ADDRESS,
      counterparties: [],
      transactions: [],
      txCount: 0,
      lastBlockTime: 0,
    });
  });

  afterEach(() => {
    clearCache();
  });

  it("rejects non-wallet seed addresses before running wallet analysis", async () => {
    getTraceTargetProfileMock.mockResolvedValue({
      address: ADDRESS,
      accountType: "program",
      onCurve: true,
      walletLike: false,
      exists: true,
      executable: true,
      owner: "BPFLoaderUpgradeab1e11111111111111111111111",
      dataLen: 0,
    });

    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/wallets/${ADDRESS}/analysis`);
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.error).toBe("wallet_analysis_wallet_only");
      expect(analyzeWalletMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("runs initial quick scans with the explicit limit instead of full history", async () => {
    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/wallets/${ADDRESS}/analysis?limit=2000`);

      expect(response.status).toBe(200);
      expect(getTxCountForAddressMock).not.toHaveBeenCalled();
      expect(analyzeWalletMock).toHaveBeenCalledWith(ADDRESS, { start: undefined, end: undefined }, { limit: 2000 });
    } finally {
      await close(server);
    }
  });

  it("rejects unbounded full-history analysis above the tx cap", async () => {
    getTxCountForAddressMock.mockResolvedValue(30_000);

    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/wallets/${ADDRESS}/analysis`);
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.error).toBe("wallet_analysis_too_large");
      expect(getTxCountForAddressMock).toHaveBeenCalledWith(ADDRESS);
      expect(analyzeWalletMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("allows bounded range analysis without the full-history tx-count gate", async () => {
    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/wallets/${ADDRESS}/analysis?start=1700000000&end=1701000000`,
      );

      expect(response.status).toBe(200);
      expect(getTxCountForAddressMock).not.toHaveBeenCalled();
      expect(analyzeWalletMock).toHaveBeenCalledWith(
        ADDRESS,
        { start: 1700000000, end: 1701000000 },
        {},
      );
    } finally {
      await close(server);
    }
  });
});
