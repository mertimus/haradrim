import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";

vi.mock("@/components/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar">search</div>,
}));

vi.mock("@/components/WalletProfile", () => ({
  WalletProfile: () => <div data-testid="wallet-profile" />,
}));

vi.mock("@/components/CounterpartyTable", () => ({
  CounterpartyTable: () => <div data-testid="counterparty-table" />,
}));

vi.mock("@/components/CounterpartyDetailPanel", () => ({
  CounterpartyDetailPanel: () => <div data-testid="counterparty-detail" />,
}));

vi.mock("@/components/FlowTransferHistoryPanel", () => ({
  FlowTransferHistoryPanel: () => <div data-testid="flow-history" />,
}));

vi.mock("@/components/TransactionGraph", () => ({
  TransactionGraph: () => <div data-testid="transaction-graph" />,
}));

vi.mock("@/components/WalletFlowView", () => ({
  WalletFlowView: () => <div data-testid="wallet-flow-view" />,
}));

vi.mock("@/components/WalletConnectionsCoachmark", () => ({
  WalletConnectionsCoachmark: () => null,
}));

vi.mock("@/components/WalletOverlayPanel", () => ({
  WalletOverlayPanel: () => <div data-testid="wallet-overlay" />,
}));

vi.mock("@/components/WalletInsightsStrip", () => ({
  WalletInsightsStrip: () => <div data-testid="wallet-insights" />,
}));

vi.mock("@/components/TraceExplorer", () => ({
  TraceExplorer: () => <div data-testid="trace-explorer" />,
}));

vi.mock("@/components/BalanceExplorer", () => ({
  BalanceExplorer: () => <div data-testid="balance-explorer" />,
}));

vi.mock("@/api", () => ({
  getIdentity: vi.fn(async () => null),
  getBatchIdentity: vi.fn(async () => new Map()),
  getBalances: vi.fn(async () => ({
    totalUsdValue: 0,
    tokens: [],
  })),
  getFunding: vi.fn(async () => null),
  getPreferredSolDomain: vi.fn(() => null),
}));

vi.mock("@/lib/backend-api", () => ({
  getEnhancedCounterpartyHistory: vi.fn(async () => []),
  getWalletAnalysis: vi.fn(async () => ({
    counterparties: [],
    transactions: [],
    txCount: 0,
    lastBlockTime: 0,
  })),
}));

describe("App token routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("does not render a tokens entry in the navbar", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: /tokens/i })).toBeNull();
    expect(screen.getByRole("button", { name: /balances/i })).toBeTruthy();
  });

  it.each([
    "/tokens",
    "/token/TestMint1111111111111111111111111111111111",
  ])("redirects %s back to home", async (pathname) => {
    window.history.pushState({}, "", pathname);

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("search-bar").length).toBeGreaterThan(0);
    });
  });

  it("renders the balances route without falling back to the wallet explorer", async () => {
    window.history.pushState({}, "", "/balances/8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("balance-explorer")).toBeTruthy();
    });
    expect(screen.queryByTestId("transaction-graph")).toBeNull();
  });

  it("carries the active wallet into the balances route from the navbar", async () => {
    const address = "8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y";
    window.history.pushState({}, "", `/wallet/${address}`);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("transaction-graph")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /balances/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/balances/${address}`);
    });
  });
});
