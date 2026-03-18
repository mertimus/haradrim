// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;
const originalRateLimitRetries = process.env.RATE_LIMIT_RETRIES;
const originalMaxUpstreamFetchConcurrency = process.env.MAX_UPSTREAM_FETCH_CONCURRENCY;
const originalOrbAuthToken = process.env.ORB_AUTH_TOKEN;
const originalHeliusRpcUrl = process.env.HELIUS_RPC_URL;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
  if (originalRateLimitRetries == null) delete process.env.RATE_LIMIT_RETRIES;
  else process.env.RATE_LIMIT_RETRIES = originalRateLimitRetries;
  if (originalMaxUpstreamFetchConcurrency == null) delete process.env.MAX_UPSTREAM_FETCH_CONCURRENCY;
  else process.env.MAX_UPSTREAM_FETCH_CONCURRENCY = originalMaxUpstreamFetchConcurrency;
  if (originalOrbAuthToken == null) delete process.env.ORB_AUTH_TOKEN;
  else process.env.ORB_AUTH_TOKEN = originalOrbAuthToken;
  if (originalHeliusRpcUrl == null) delete process.env.HELIUS_RPC_URL;
  else process.env.HELIUS_RPC_URL = originalHeliusRpcUrl;
});

describe("providers", () => {
  it("surfaces upstream 429s as structured upstream_rate_limited errors", async () => {
    process.env.RATE_LIMIT_RETRIES = "0";
    vi.resetModules();
    const { rpcJson } = await import("../../backend/src/providers.mjs");

    global.fetch = vi.fn(async () => new Response("busy", { status: 429 }));

    await expect(rpcJson("getTransactionsForAddress", [])).rejects.toMatchObject({
      statusCode: 503,
      error: "upstream_rate_limited",
    });
  });

  it("queues upstream fetches when the concurrency limit is reached", async () => {
    process.env.MAX_UPSTREAM_FETCH_CONCURRENCY = "1";
    vi.resetModules();
    const { fetchWithTimeout } = await import("../../backend/src/providers.mjs");

    let releaseFirst;
    const started = [];
    global.fetch = vi.fn(() => {
      started.push(Date.now());
      if (started.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(new Response("{}"));
        });
      }
      return Promise.resolve(new Response("{}"));
    });

    const first = fetchWithTimeout("https://example.com/one", {});
    const second = fetchWithTimeout("https://example.com/two", {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await first;
    await second;

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("filters invalid addresses out of batch identity requests", async () => {
    vi.resetModules();
    const { getBatchIdentity } = await import("../../backend/src/providers.mjs");

    global.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({
        addresses: ["8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L"],
      }));
      return new Response(
        JSON.stringify([{
          address: "8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L",
          name: "Valid Wallet",
          category: "unknown",
          tags: [],
        }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await getBatchIdentity([
      "8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L",
      "",
      "toly.sol",
      "not-a-solana-address",
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect([...result.keys()]).toEqual(["8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L"]);
  });

  it("uses the Orb tx-count endpoint with the auth header when configured", async () => {
    process.env.ORB_AUTH_TOKEN = "orb-secret";
    process.env.HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=test-key";
    vi.resetModules();
    const { getTxCountForAddress } = await import("../../backend/src/providers.mjs");

    global.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://mainnet.helius-rpc.com/?api-key=test-key");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        "content-type": "application/json",
        "x-orb-auth": "orb-secret",
      });
      expect(init?.body).toBe(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTxAmountForAddress",
        params: {
          address: "8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L",
          config: {
            commitment: "finalized",
          },
        },
      }));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { count: 12_345 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const count = await getTxCountForAddress("8cRrU1KsgkgGcLHVapTds6eNJkRjKz5WoD1sW5v7n7L");
    expect(count).toBe(12_345);
  });
});
