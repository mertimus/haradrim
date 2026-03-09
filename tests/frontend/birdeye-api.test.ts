import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTokenHolders } from "@/birdeye-api";

describe("birdeye-api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("builds holders from RPC token accounts across token programs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (!url.includes("/helius-rpc")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }

      const body = JSON.parse(String(init?.body ?? "{}"));

      if (body.method === "getTokenSupply") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              value: {
                uiAmount: 1000,
              },
            },
            id: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (body.method === "getProgramAccounts") {
        const programId = body.params?.[0];
        const filters = body.params?.[1]?.filters ?? [];
        expect(filters).toEqual([
          { dataSize: 165 },
          {
            memcmp: {
              offset: 0,
              bytes: "Mint111111111111111111111111111111111111111",
            },
          },
        ]);

        if (programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              result: [
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          owner: "holder-a",
                          tokenAmount: { uiAmount: 600 },
                        },
                      },
                    },
                  },
                },
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          owner: "holder-b",
                          tokenAmount: { uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
              ],
              id: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              result: [
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          owner: "holder-a",
                          tokenAmount: { uiAmountString: "100" },
                        },
                      },
                    },
                  },
                },
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          owner: "holder-c",
                          tokenAmount: { uiAmount: 300 },
                        },
                      },
                    },
                  },
                },
              ],
              id: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }

      throw new Error(`Unexpected RPC body: ${JSON.stringify(body)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const holders = await getTokenHolders(
      "Mint111111111111111111111111111111111111111",
    );

    expect(holders).toEqual([
      {
        owner: "holder-a",
        uiAmount: 700,
        percentage: 70,
      },
      {
        owner: "holder-c",
        uiAmount: 300,
        percentage: 30,
      },
    ]);
  });
});
