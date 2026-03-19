import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenExplorer } from "@/components/TokenExplorer";
import { getTokenOverview } from "@/birdeye-api";
import { getTokenHolderSnapshot } from "@/lib/backend-api";

vi.mock("@/birdeye-api", () => ({
  getTokenOverview: vi.fn(),
  getTrendingTokens: vi.fn(async () => []),
  searchTokens: vi.fn(async () => []),
}));

vi.mock("@/lib/backend-api", () => ({
  getTokenHolderSnapshot: vi.fn(),
  getTokenForensics: vi.fn(),
}));

vi.mock("@/api", () => ({
  getBatchIdentity: vi.fn(async () => new Map()),
  getBatchSolDomains: vi.fn(async () => new Map()),
  getBatchFunding: vi.fn(async () => new Map()),
  resolveWalletInput: vi.fn(async (value: string) => value),
}));

vi.mock("@/components/HolderGraph", () => ({
  HolderGraph: ({ loading }: { loading: boolean }) => (
    <div data-testid="holder-graph">{loading ? "loading" : "graph"}</div>
  ),
}));

vi.mock("@/components/HolderTable", () => ({
  HolderTable: ({ holders }: { holders: unknown[] }) => (
    <div data-testid="holder-table">{holders.length}</div>
  ),
}));

describe("TokenExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/token/TestMint1111111111111111111111111111111111");
  });

  it("shows an error when holder loading fails even if overview succeeds", async () => {
    vi.mocked(getTokenOverview).mockResolvedValue({
      address: "TestMint1111111111111111111111111111111111",
      name: "Test Token",
      symbol: "TEST",
      image: "",
      marketCap: 0,
      holder: 42,
      price: 0,
      supply: 1000,
      decimals: 6,
      liquidity: 0,
      volume24h: 0,
      priceChange24h: 0,
      priceChange1h: 0,
    });
    vi.mocked(getTokenHolderSnapshot).mockRejectedValue(
      new Error("Unable to fetch token holders."),
    );

    render(<TokenExplorer />);

    await waitFor(() => {
      expect(
        screen.getByText("Unable to fetch token holders."),
      ).toBeTruthy();
    });

    expect(screen.getByTestId("holder-table").textContent).toBe("0");
  });
});
