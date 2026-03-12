import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StablecoinDashboard } from "@/components/StablecoinDashboard";
import type { StablecoinDashboardResult } from "@/lib/backend-api";

const MOCK_RESULT: StablecoinDashboardResult = {
  snapshotAt: 1710000000,
  stablecoins: [
    { ticker: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", uiAmount: 10_000_000_000, decimals: 6, sharePct: 59.88 },
    { ticker: "USDT", name: "Tether USD", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", uiAmount: 5_000_000_000, decimals: 6, sharePct: 29.94 },
    { ticker: "PYUSD", name: "PayPal USD", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", uiAmount: 1_000_000_000, decimals: 6, sharePct: 5.99 },
    { ticker: "USDG", name: "Global Dollar", mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", uiAmount: 500_000_000, decimals: 6, sharePct: 2.99 },
    { ticker: "CASH", name: "Cash", mint: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", uiAmount: 200_000_000, decimals: 6, sharePct: 1.20 },
  ],
  totalSupply: 16_700_000_000,
  holdersByTicker: {
    USDC: {
      holders: [
        { owner: "USDCHolder1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", uiAmount: 1_000_000_000, percentage: 10, label: "Coinbase" },
        { owner: "USDCHolder2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", uiAmount: 500_000_000, percentage: 5 },
      ],
      concentration: { top10Pct: 40, top50Pct: 70, top100Pct: 90 },
    },
    USDT: {
      holders: [
        { owner: "USDTHolder1cccccccccccccccccccccccccccccccccccc", uiAmount: 800_000_000, percentage: 16 },
      ],
      concentration: { top10Pct: 50, top50Pct: 80, top100Pct: 95 },
    },
    PYUSD: {
      holders: [
        { owner: "PYUSDHolder1dddddddddddddddddddddddddddddddd", uiAmount: 200_000_000, percentage: 20 },
      ],
      concentration: { top10Pct: 60, top50Pct: 85, top100Pct: 98 },
    },
    USDG: {
      holders: [],
      concentration: { top10Pct: 0, top50Pct: 0, top100Pct: 0 },
    },
    CASH: {
      holders: [],
      concentration: { top10Pct: 0, top50Pct: 0, top100Pct: 0 },
    },
  },
  concentrationRanking: [
    { ticker: "PYUSD", top10Pct: 60, top50Pct: 85, top100Pct: 98 },
    { ticker: "USDT", top10Pct: 50, top50Pct: 80, top100Pct: 95 },
    { ticker: "USDC", top10Pct: 40, top50Pct: 70, top100Pct: 90 },
  ],
  editorial: "USDC dominates Solana stablecoin supply at $10.0B (59.9%). USDT at $5.0B follows behind.",
  diversification: {
    walletCount: 1,
    totalValue: 350_000_000,
    pctOfSupply: 2.1,
  },
  overlap: [
    {
      owner: "OverlapOwner1ddddddddddddddddddddddddddddddddd",
      label: "Binance",
      holdings: {
        USDC: { amount: 200_000_000, pct: 2 },
        USDT: { amount: 150_000_000, pct: 3 },
      },
    },
  ],
  yieldMarkets: [
    {
      id: "yield-usdc-kamino",
      type: "lending" as const,
      name: "Main Market",
      ticker: "USDC",
      tokenIcon: "",
      provider: "Kamino",
      providerIcon: "",
      depositApy: 0.0487,
      baseDepositApy: 0.035,
      baseDepositApy30d: 0.036,
      baseDepositApy90d: 0.061,
      boosted: true,
      totalDepositUsd: 421_050_000,
      borrowApy: 0.078,
      totalBorrowUsd: 200_000_000,
      url: "https://app.kamino.finance",
    },
    {
      id: "yield-usdc-jup",
      type: "yield" as const,
      name: "Jupiter Earn",
      ticker: "USDC",
      tokenIcon: "",
      provider: "Jupiter",
      providerIcon: "",
      depositApy: 0.042,
      baseDepositApy: 0.042,
      baseDepositApy30d: null,
      baseDepositApy90d: null,
      boosted: false,
      totalDepositUsd: 66_620_000,
      borrowApy: null,
      totalBorrowUsd: null,
      url: null,
    },
  ],
};

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual("@/lib/backend-api");
  return {
    ...actual,
    getStablecoinDashboard: vi.fn(),
  };
});

import { getStablecoinDashboard } from "@/lib/backend-api";

describe("StablecoinDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially", () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<StablecoinDashboard />);
    expect(screen.getByText(/loading stablecoin data/i)).toBeTruthy();
  });

  it("renders hero total supply after load", async () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RESULT);
    render(<StablecoinDashboard />);

    await waitFor(() => {
      expect(screen.getByText("$16.70B")).toBeTruthy();
    });
  });

  it("renders error state on failure", async () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    render(<StablecoinDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });
  });

  it("renders supply ranking section", async () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RESULT);
    render(<StablecoinDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Supply Ranking")).toBeTruthy();
    });
  });

  it("renders tabbed holder detail", async () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RESULT);
    render(<StablecoinDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Top Holders")).toBeTruthy();
      expect(screen.getByText("Coinbase")).toBeTruthy();
    });
  });

  it("renders yield markets section", async () => {
    (getStablecoinDashboard as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RESULT);
    render(<StablecoinDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Yield Markets")).toBeTruthy();
      expect(screen.getByText("Main Market")).toBeTruthy();
      expect(screen.getAllByText("Kamino").length).toBeGreaterThan(0);
    });
  });
});
