import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BalanceExplorer } from "@/components/BalanceExplorer";
import { getWalletAssetBalanceHistory } from "@/lib/backend-api";

vi.mock("@/components/SearchBar", () => ({
  SearchBar: ({
    onSearch,
    defaultValue,
  }: {
    onSearch: (address: string) => void | Promise<void>;
    defaultValue?: string;
  }) => (
    <button
      data-testid="search-bar"
      onClick={() => void onSearch("SearchWallet1111111111111111111111111111111")}
    >
      {defaultValue || "search"}
    </button>
  ),
}));

vi.mock("@/components/AssetBalanceChart", () => ({
  AssetBalanceChart: ({ points }: { points: Array<unknown> }) => (
    <div data-testid="asset-balance-chart">{points.length} points</div>
  ),
}));

vi.mock("@/lib/backend-api", () => ({
  getWalletAssetBalanceHistory: vi.fn(),
}));

const sampleResult = {
  address: "8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y",
  strategy: "gtfa-wallet-assets" as const,
  firstTimestamp: 1_710_000_000,
  lastTimestamp: 1_710_200_000,
  txCount: 4,
  estimatedTxCount: 4,
  assetCount: 3,
  currentAssetCount: 2,
  historicalAssetCount: 1,
  assets: [
    {
      assetId: "native:sol",
      kind: "native" as const,
      mint: null,
      symbol: "SOL",
      name: "Native SOL",
      decimals: 9,
      pointCount: 4,
      firstTimestamp: 1_710_000_000,
      lastTimestamp: 1_710_200_000,
      currentBalance: 2.4,
      startingBalance: 1,
      netChange: 1.4,
      minBalance: 1,
      maxBalance: 2.4,
      currentlyHeld: true,
      downsampled: false,
      points: [
        { signature: "sig-1", slot: 1, timestamp: 1_710_000_000, balance: 1.2, delta: 0.2 },
        { signature: "sig-2", slot: 2, timestamp: 1_710_100_000, balance: 1.9, delta: 0.7 },
      ],
    },
    {
      assetId: "TokenBMint11111111111111111111111111111111",
      kind: "token" as const,
      mint: "TokenBMint11111111111111111111111111111111",
      symbol: "TKB",
      name: "Token B",
      decimals: 6,
      pointCount: 2,
      firstTimestamp: 1_710_050_000,
      lastTimestamp: 1_710_200_000,
      currentBalance: 7,
      startingBalance: 0,
      netChange: 7,
      minBalance: 0,
      maxBalance: 7,
      currentlyHeld: true,
      downsampled: false,
      points: [
        { signature: "sig-3", slot: 3, timestamp: 1_710_050_000, balance: 5, delta: 5 },
        { signature: "sig-4", slot: 4, timestamp: 1_710_200_000, balance: 7, delta: 2 },
      ],
    },
    {
      assetId: "TokenAMint11111111111111111111111111111111",
      kind: "token" as const,
      mint: "TokenAMint11111111111111111111111111111111",
      symbol: "TKA",
      name: "Token A",
      decimals: 6,
      pointCount: 2,
      firstTimestamp: 1_710_000_000,
      lastTimestamp: 1_710_150_000,
      currentBalance: 0,
      startingBalance: 0,
      netChange: 0,
      minBalance: 0,
      maxBalance: 2,
      currentlyHeld: false,
      downsampled: false,
      points: [
        { signature: "sig-1", slot: 1, timestamp: 1_710_000_000, balance: 2, delta: 2 },
        { signature: "sig-5", slot: 5, timestamp: 1_710_150_000, balance: 0, delta: -2 },
      ],
    },
  ],
};

describe("BalanceExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    window.history.pushState({}, "", "/balances");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads and renders multi-asset GTFA history for an initial address", async () => {
    vi.mocked(getWalletAssetBalanceHistory).mockResolvedValue(sampleResult);

    render(<BalanceExplorer initialAddress={sampleResult.address} />);

    await waitFor(() => {
      expect(getWalletAssetBalanceHistory).toHaveBeenCalledWith(
        sampleResult.address,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    expect(screen.getAllByText(sampleResult.address).length).toBeGreaterThan(0);
    expect(screen.getByText("Token holdings and former positions")).toBeTruthy();
    expect(screen.getByText("TKB")).toBeTruthy();
    expect(screen.getByText("TKA")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByTestId("asset-balance-chart")).toHaveLength(1);
    });
  });

  it("loads a searched address and updates the route", async () => {
    vi.mocked(getWalletAssetBalanceHistory).mockResolvedValue(sampleResult);

    render(<BalanceExplorer />);

    fireEvent.click(screen.getByTestId("search-bar"));

    await waitFor(() => {
      expect(getWalletAssetBalanceHistory).toHaveBeenCalledWith(
        "SearchWallet1111111111111111111111111111111",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    expect(window.location.pathname).toBe("/balances/SearchWallet1111111111111111111111111111111");
  });

  it("disables rerun while the GTFA asset-history request is in flight", async () => {
    vi.mocked(getWalletAssetBalanceHistory).mockImplementation(() => new Promise(() => {}));

    render(<BalanceExplorer initialAddress={sampleResult.address} />);

    await waitFor(() => {
      expect(getWalletAssetBalanceHistory).toHaveBeenCalledWith(
        sampleResult.address,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    expect(screen.getByRole("button", { name: /rerun/i }).hasAttribute("disabled")).toBe(true);
  });
});
