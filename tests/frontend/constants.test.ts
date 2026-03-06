import { describe, expect, it } from "vitest";
import { resolveHeliusRpcUrl } from "../../src/lib/constants";

describe("resolveHeliusRpcUrl", () => {
  it("falls back to the backend proxy when the public RPC url is blank", () => {
    expect(resolveHeliusRpcUrl("", "https://haradrim.app/api")).toBe(
      "https://haradrim.app/api/helius-rpc",
    );
    expect(resolveHeliusRpcUrl("   ", "https://haradrim.app/api")).toBe(
      "https://haradrim.app/api/helius-rpc",
    );
    expect(resolveHeliusRpcUrl(undefined, "https://haradrim.app/api")).toBe(
      "https://haradrim.app/api/helius-rpc",
    );
  });

  it("uses the explicit public RPC url when it is present", () => {
    expect(resolveHeliusRpcUrl("https://rpc.example.com", "https://haradrim.app/api")).toBe(
      "https://rpc.example.com",
    );
  });
});
