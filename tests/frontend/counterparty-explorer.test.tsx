import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CounterpartyExplorer } from "@/components/CounterpartyExplorer";
import { getWalletAnalysis } from "@/lib/backend-api";

vi.mock("@/components/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
}));

vi.mock("@/components/ExplorerLanding", () => ({
  ExplorerLanding: () => <div data-testid="explorer-landing" />,
}));

vi.mock("@/components/WalletProfile", () => ({
  WalletProfile: () => <div data-testid="wallet-profile" />,
}));

vi.mock("@/components/WalletInsightsStrip", () => ({
  WalletInsightsStrip: () => <div data-testid="wallet-insights" />,
}));

vi.mock("@/components/TransactionGraph", () => ({
  TransactionGraph: () => <div data-testid="transaction-graph" />,
}));

vi.mock("@/components/CounterpartyDetailPanel", () => ({
  CounterpartyDetailPanel: () => <div data-testid="counterparty-detail" />,
}));

vi.mock("@/components/CounterpartyTable", () => ({
  CounterpartyTable: () => <div data-testid="counterparty-table" />,
}));

vi.mock("@/components/WalletOverlayPanel", () => ({
  WalletOverlayPanel: () => <div data-testid="wallet-overlay" />,
}));

vi.mock("@/components/WalletConnectionsCoachmark", () => ({
  WalletConnectionsCoachmark: () => null,
}));

vi.mock("@/api", () => ({
  getIdentity: vi.fn(async () => null),
  getBatchIdentity: vi.fn(async () => new Map()),
  getBalances: vi.fn(async () => null),
  getFunding: vi.fn(async () => null),
  getPreferredSolDomain: vi.fn(() => null),
}));

vi.mock("@/lib/backend-api", () => ({
  getWalletAnalysis: vi.fn(),
  getEnhancedCounterpartyHistory: vi.fn(async () => ({ counterparty: "", annotations: [] })),
  getWalletPairSignals: vi.fn(async () => ({ walletA: "", walletB: "", sharedCounterpartyCount: 0, signals: [] })),
}));

const ADDRESS = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";

describe("CounterpartyExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWalletAnalysis).mockResolvedValue({
      address: ADDRESS,
      counterparties: [],
      transactions: [],
      txCount: 12,
      lastBlockTime: 1710000000,
    });
  });

  it("loads the initial address as a quick scan and lets the user request full history", async () => {
    render(<CounterpartyExplorer initialAddress={ADDRESS} />);

    await waitFor(() => {
      expect(getWalletAnalysis).toHaveBeenCalledWith(ADDRESS, undefined, { limit: 2000 });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load full history" }));

    await waitFor(() => {
      expect(getWalletAnalysis).toHaveBeenNthCalledWith(2, ADDRESS);
    });
  });
});
