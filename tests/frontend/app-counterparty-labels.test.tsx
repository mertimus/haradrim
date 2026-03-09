import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";

const counterpartyAddress = "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL";

vi.mock("@/components/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar">search</div>,
}));

vi.mock("@/components/WalletProfile", () => ({
  WalletProfile: () => <div data-testid="wallet-profile" />,
}));

vi.mock("@/components/CounterpartyTable", () => ({
  CounterpartyTable: ({ counterparties }: { counterparties: Array<{ address: string; label?: string }> }) => (
    <div data-testid="counterparty-table">
      {counterparties.map((cp) => (
        <div key={cp.address}>{cp.label ?? cp.address}</div>
      ))}
    </div>
  ),
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

vi.mock("@/api", () => ({
  getIdentity: vi.fn(async () => null),
  getBatchIdentity: vi.fn(async () => new Map([
    [counterpartyAddress, {
      address: counterpartyAddress,
      name: "Jito Tip 7",
      label: "jitotip7.sol",
      category: "Transaction Sending",
      tags: ["jitotip7.sol"],
    }],
  ])),
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
    counterparties: [
      {
        address: counterpartyAddress,
        label: "Jito Tip 7",
        category: "Transaction Sending",
        txCount: 331,
        solSent: 0.03,
        solReceived: 0,
        solNet: -0.03,
        firstSeen: 1712534400,
        lastSeen: 1738281600,
      },
    ],
    transactions: [],
    txCount: 7083,
    lastBlockTime: 1738877100,
  })),
}));

describe("App counterparty label hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/wallet/8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y");
  });

  it("replaces visible counterparty labels with the hydrated identity label", async () => {
    render(<App />);

    const table = await screen.findByTestId("counterparty-table");

    await waitFor(() => {
      expect(within(table).getByText("jitotip7.sol")).toBeTruthy();
    });
    expect(within(table).queryByText("Jito Tip 7")).toBeNull();
  });
});
