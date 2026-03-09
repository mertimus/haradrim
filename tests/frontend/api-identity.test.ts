import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bonfida/spl-name-service", () => ({
  getDomainKeysWithReverses: vi.fn(),
  getAllDomains: vi.fn(async () => []),
  reverseLookupBatch: vi.fn(async () => []),
  resolve: vi.fn(),
}));

import { getBatchIdentity, getIdentity } from "@/api";

describe("api identity normalization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("prefers a .sol domain label when the wallet identity API returns domainNames", async () => {
    const address = "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL";

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(`/helius-api/v1/wallet/${address}/identity`);
      return new Response(
        JSON.stringify({
          address,
          name: "Jito Tip 7",
          category: "Transaction Sending",
          domainNames: ["jitotip7.sol"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }));

    const identity = await getIdentity(address);

    expect(identity).toEqual({
      address,
      name: "Jito Tip 7",
      label: "jitotip7.sol",
      category: "Transaction Sending",
      tags: ["jitotip7.sol"],
    });
  });

  it("recovers missing batch identities from individual lookups when the cached batch payload is stale", async () => {
    const address = "DtvWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRM";
    const batchCacheKey = `haradrim:batchId:${address}`;

    localStorage.setItem(batchCacheKey, JSON.stringify({
      ts: Date.now(),
      data: {},
    }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method ?? "GET").toBe("GET");
      expect(url).toContain(`/helius-api/v1/wallet/${address}/identity`);
      return new Response(
        JSON.stringify({
          address,
          name: "Jito Tip 7",
          category: "Transaction Sending",
          domainNames: ["jitotip7.sol"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const identities = await getBatchIdentity([address]);

    expect(identities.get(address)).toEqual({
      address,
      name: "Jito Tip 7",
      label: "jitotip7.sol",
      category: "Transaction Sending",
      tags: ["jitotip7.sol"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
