// @vitest-environment node

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzeTraceMock = vi.fn();
const getTraceTargetProfileMock = vi.fn();
const getTxCountForAddressMock = vi.fn();

vi.mock("../../backend/src/analysis-core.mjs", async () => {
  const actual = await vi.importActual("../../backend/src/analysis-core.mjs");
  return {
    ...actual,
    analyzeTrace: analyzeTraceMock,
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

describe("trace server flow joins in-flight enrichment", () => {
  beforeEach(() => {
    clearCache();
    serverInternals.clearTraceEnrichmentState();
    analyzeTraceMock.mockReset();
    getTraceTargetProfileMock.mockReset();
    getTxCountForAddressMock.mockReset();
    getTraceTargetProfileMock.mockResolvedValue({
      address: ADDRESS,
      accountType: "wallet",
      onCurve: true,
      walletLike: true,
    });
    getTxCountForAddressMock.mockResolvedValue(10_000);
  });

  afterEach(() => {
    clearCache();
    serverInternals.clearTraceEnrichmentState();
  });

  it("serves a second trace poll from the pending enrichment instead of rerunning analysis", async () => {
    analyzeTraceMock.mockImplementation(async (address, _range, onEnriched) => {
      setTimeout(() => {
        onEnriched?.({
          address,
          events: [{
            signature: "sig-1",
            timestamp: 1_710_000_000,
            direction: "outflow",
            counterparty: "BgdZ8o5eG6u8dR6c2QxJmK5f4nLp2sT9vYw8aBcDeFg",
            assetId: "native:sol",
            kind: "native",
            decimals: 9,
            rawAmount: "1000000",
            uiAmount: 0.001,
          }],
          assets: [],
          firstSeen: 1_710_000_000,
          lastSeen: 1_710_000_000,
          metadataPending: false,
        });
      }, 1_500);

      return {
        address,
        events: [],
        assets: [],
        firstSeen: 0,
        lastSeen: 0,
        metadataPending: true,
      };
    });

    const server = createServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/traces/${ADDRESS}/flows`;

    try {
      const firstResponse = await fetch(url);
      const firstPayload = await firstResponse.json();
      expect(firstResponse.status).toBe(200);
      expect(firstPayload.metadataPending).toBe(true);

      const secondResponse = await fetch(url);
      const secondPayload = await secondResponse.json();
      expect(secondResponse.status).toBe(200);
      expect(secondPayload.metadataPending).toBe(false);
      expect(analyzeTraceMock).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it("rejects non-wallet trace targets before analysis", async () => {
    getTraceTargetProfileMock.mockResolvedValue({
      address: ADDRESS,
      accountType: "program",
      onCurve: false,
      walletLike: false,
    });

    const server = createServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/traces/${ADDRESS}/flows?limit=2000`;

    try {
      const response = await fetch(url);
      const payload = await response.json();

      expect(response.status).toBe(422);
      expect(payload.error).toBe("trace_wallet_only");
      expect(payload.details).toMatchObject({
        accountType: "program",
        onCurve: false,
      });
      expect(getTxCountForAddressMock).not.toHaveBeenCalled();
      expect(analyzeTraceMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects oversized full-history traces before analysis", async () => {
    getTxCountForAddressMock.mockResolvedValue(30_001);

    const server = createServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/traces/${ADDRESS}/flows`;

    try {
      const response = await fetch(url);
      const payload = await response.json();

      expect(response.status).toBe(422);
      expect(payload.error).toBe("trace_too_large");
      expect(payload.details).toMatchObject({
        txCount: 30_001,
        txCap: 25_000,
      });
      expect(getTxCountForAddressMock).toHaveBeenCalledWith(ADDRESS);
      expect(analyzeTraceMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("skips the tx-count probe for quick scans", async () => {
    analyzeTraceMock.mockResolvedValue({
      address: ADDRESS,
      events: [],
      assets: [],
      firstSeen: 0,
      lastSeen: 0,
      metadataPending: false,
    });

    const server = createServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/traces/${ADDRESS}/flows?limit=2000`;

    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(getTxCountForAddressMock).not.toHaveBeenCalled();
      expect(analyzeTraceMock).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });
});
