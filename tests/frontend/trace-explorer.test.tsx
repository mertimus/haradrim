import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "../../src/components/TraceExplorer";
import { getBatchIdentity, getIdentity, getTokenMetadataBatch } from "@/api";
import { getTraceAnalysis } from "@/lib/backend-api";
import {
  DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL,
  NATIVE_SOL_ASSET_ID,
  type TraceNodeFlows,
} from "@/lib/trace-types";

vi.mock("@/api", () => ({
  getIdentity: vi.fn(),
  getBatchIdentity: vi.fn(async () => new Map()),
  getTokenMetadataBatch: vi.fn(async () => new Map()),
  resolveWalletInput: vi.fn(async (value: string) => value),
  rememberPreferredSolDomain: vi.fn(),
}));

vi.mock("@/lib/backend-api", () => ({
  getTraceAnalysis: vi.fn(),
  parseTransactions: vi.fn(async () => ({ transactions: [] })),
}));

vi.mock("@/components/TraceGraph", () => ({
  TraceGraph: ({ nodes = [], onNodeClick }: { nodes?: Array<{ id: string; data?: { label?: string } }>; onNodeClick: (address: string) => void }) => (
    <div data-testid="trace-graph">
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={`trace-node-${node.id}`}
          onClick={() => onNodeClick(node.id)}
        >
          {node.data?.label ?? node.id}
        </button>
      ))}
    </div>
  ),
}));

const ADDRESS = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const COUNTERPARTY = "9ZvA5bD5mEBnNsxkVQxgs5gcm4qg3L5BoXxq3GR7oJ6f";

function createFlows(
  events: TraceNodeFlows["events"],
  options: Partial<Pick<TraceNodeFlows, "metadataPending" | "address">> = {},
): TraceNodeFlows {
  return {
    address: options.address ?? ADDRESS,
    events,
    assets: [{
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      transferCount: events.length,
      txCount: events.length,
      uiAmount: events.reduce((sum, event) => sum + event.uiAmount, 0),
      symbol: "SOL",
      name: "Native SOL",
    }],
    firstSeen: events[0]?.timestamp ?? 0,
    lastSeen: events[events.length - 1]?.timestamp ?? 0,
    metadataPending: options.metadataPending ?? false,
  };
}

describe("TraceExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getIdentity).mockResolvedValue(null);
    vi.mocked(getBatchIdentity).mockResolvedValue(new Map());
    vi.mocked(getTokenMetadataBatch).mockResolvedValue(new Map());
    vi.mocked(getTraceAnalysis).mockResolvedValue({
      address: ADDRESS,
      events: [],
      assets: [],
      firstSeen: 0,
      lastSeen: 0,
      metadataPending: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues the trace when seed identity lookup fails", async () => {
    vi.mocked(getIdentity).mockRejectedValueOnce(new Error("Identity unavailable"));

    render(<TraceExplorer />);

    fireEvent.change(screen.getByPlaceholderText("Paste wallet address..."), {
      target: { value: ADDRESS },
    });
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByTestId("trace-graph")).toBeTruthy();
    });
    expect(screen.queryByText("Identity unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("loads the initial seed trace as a quick scan", async () => {
    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByTestId("trace-graph");
    await waitFor(() => {
      expect(getTraceAnalysis).toHaveBeenCalledWith(ADDRESS, undefined, { limit: 2000 });
    });
  });

  it("hides SOL dust by default and lets the user reveal it", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([{
      signature: "dust-1",
      timestamp: 1712534400,
      direction: "outflow",
      counterparty: COUNTERPARTY,
      counterpartyLabel: "Dust Sender",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      rawAmount: "50000",
      uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL / 2,
      symbol: "SOL",
      name: "Native SOL",
    }]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText(
      `Only sub-${DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL} SOL transfers were found. SOL dust is hidden by default.`,
    );

    const dustToggle = screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement;
    expect(dustToggle.checked).toBe(true);
    expect(screen.queryByText("1 active")).toBeNull();

    fireEvent.click(dustToggle);

    fireEvent.click(screen.getByText("Outflow →"));
    await screen.findByText("Dust Sender");
    expect(screen.getByText("1 active")).toBeTruthy();
  });

  it("treats default dust hiding as the reset baseline", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([{
      signature: "dust-1",
      timestamp: 1712534400,
      direction: "outflow",
      counterparty: COUNTERPARTY,
      counterpartyLabel: "Dust Sender",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      rawAmount: "50000",
      uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL / 2,
      symbol: "SOL",
      name: "Native SOL",
    }]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByLabelText(/Hide SOL dust/);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    const dustToggle = screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement;
    fireEvent.click(dustToggle);

    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByText("1 active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect((screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
      expect(screen.queryByText("1 active")).toBeNull();
    });
  });

  it("keeps the dust-hidden hint when date filters isolate only dust transfers", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([
      {
        signature: "dust-1",
        timestamp: 1712534400,
        direction: "outflow",
        counterparty: COUNTERPARTY,
        counterpartyLabel: "Dust Sender",
        assetId: NATIVE_SOL_ASSET_ID,
        kind: "native",
        decimals: 9,
        rawAmount: "50000",
        uiAmount: DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL / 2,
        symbol: "SOL",
        name: "Native SOL",
      },
      {
        signature: "big-sol-1",
        timestamp: 1712620800,
        direction: "outflow",
        counterparty: "7KVQXH1nZaS7VY1QvYJX9h53r7S4A1wzVQ6Q9cQ1Ac6W",
        counterpartyLabel: "Big Sender",
        assetId: NATIVE_SOL_ASSET_ID,
        kind: "native",
        decimals: 9,
        rawAmount: "5000000",
        uiAmount: 0.005,
        symbol: "SOL",
        name: "Native SOL",
      },
    ]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    fireEvent.change(await screen.findByLabelText("From"), {
      target: { value: "2024-04-08" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2024-04-08" },
    });

    await screen.findByText(
      `Only sub-${DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL} SOL transfers were found. SOL dust is hidden by default.`,
    );
    expect(screen.queryByText("No flows match the current filters")).toBeNull();
  });

  it("starts with both outflow and inflow groups collapsed", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([
      {
        signature: "outflow-1",
        timestamp: 1712620800,
        direction: "outflow",
        counterparty: COUNTERPARTY,
        counterpartyLabel: "Outflow Sender",
        assetId: NATIVE_SOL_ASSET_ID,
        kind: "native",
        decimals: 9,
        rawAmount: "5000000",
        uiAmount: 0.005,
        symbol: "SOL",
        name: "Native SOL",
      },
      {
        signature: "inflow-1",
        timestamp: 1712620810,
        direction: "inflow",
        counterparty: "5Wj7xUoYJfM4pr2m6Q1t8Q9VK2h8jHZnL9vFq8avR4Ns",
        counterpartyLabel: "Inflow Sender",
        assetId: NATIVE_SOL_ASSET_ID,
        kind: "native",
        decimals: 9,
        rawAmount: "7000000",
        uiAmount: 0.007,
        symbol: "SOL",
        name: "Native SOL",
      },
    ]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Outflow →");
    expect(screen.queryByText("Outflow Sender")).toBeNull();
    expect(screen.queryByText("Inflow Sender")).toBeNull();

    fireEvent.click(screen.getByText("Outflow →"));
    await screen.findByText("Outflow Sender");
    expect(screen.queryByText("Inflow Sender")).toBeNull();
  });

  it("shows a dedicated busy state for trace 429s", async () => {
    const busyError = Object.assign(
      new Error("Too many concurrent trace-analysis requests"),
      {
        status: 429,
        code: "route_busy",
        details: { retryAfterSec: 2 },
      },
    );
    vi.mocked(getTraceAnalysis).mockRejectedValue(busyError);

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Trace Workers Are Busy");
    expect(screen.getByText("The trace queue is saturated right now. Try again in about 2s.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows a provider-busy state for upstream rate limits", async () => {
    const providerBusyError = Object.assign(
      new Error("Upstream Solana data provider is saturated right now"),
      {
        status: 503,
        code: "upstream_rate_limited",
      },
    );
    vi.mocked(getTraceAnalysis).mockRejectedValue(providerBusyError);

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Trace Provider Busy");
    expect(screen.getByText("The upstream Solana data provider is saturated right now. Try again shortly.")).toBeTruthy();
  });

  it("shows a wallet-only state for non-user-wallet trace targets", async () => {
    const walletOnlyError = Object.assign(
      new Error("Trace mode currently supports user wallets only"),
      {
        status: 422,
        code: "trace_wallet_only",
      },
    );
    vi.mocked(getTraceAnalysis).mockRejectedValue(walletOnlyError);

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("User Wallets Only");
    expect(screen.getByText("Only user-owned wallet addresses can be traced. Programs, PDAs, token accounts, and protocol-owned addresses are not supported.")).toBeTruthy();
  });

  it("shows a dedicated missing-account state when the seed address no longer exists on-chain", async () => {
    const missingAccountError = Object.assign(
      new Error("Trace mode currently supports user wallets only"),
      {
        status: 422,
        code: "trace_wallet_only",
        details: {
          accountType: "missing_account",
        },
      },
    );
    vi.mocked(getTraceAnalysis).mockRejectedValue(missingAccountError);

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Address Not Active");
    expect(screen.getByText("This address does not currently have a live on-chain account, so Haradrim cannot verify it as a user-owned wallet for trace mode.")).toBeTruthy();
  });

  it("shows a dedicated state when full-history trace exceeds the tx cap", async () => {
    const tooLargeError = Object.assign(
      new Error("Full-history trace is disabled"),
      {
        status: 422,
        code: "trace_too_large",
        details: {
          txCount: 31_245,
          txCap: 25_000,
        },
      },
    );
    vi.mocked(getTraceAnalysis).mockRejectedValue(tooLargeError);

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Full History Too Large");
    expect(screen.getByText("This wallet has about 31,245 transactions. Interactive full-history trace is capped at 25,000. Stay on quick scan or narrow the time range.")).toBeTruthy();
  });

  it("resolves visible counterparty labels client-side without showing a global enrichment banner", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([{
      signature: "label-1",
      timestamp: 1712620800,
      direction: "outflow",
      counterparty: COUNTERPARTY,
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      rawAmount: "5000000",
      uiAmount: 0.005,
      symbol: "SOL",
      name: "Native SOL",
    }], { metadataPending: true }));
    vi.mocked(getBatchIdentity).mockResolvedValue(new Map([
      [COUNTERPARTY, {
        address: COUNTERPARTY,
        label: "Resolved Counterparty",
        category: "Exchange",
      }],
    ]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await screen.findByText("Outflow →");
    expect(screen.queryByText("Enriching labels...")).toBeNull();

    fireEvent.click(screen.getByText("Outflow →"));
    await screen.findByText("Resolved Counterparty");
  });

  it("resolves token symbols client-side for fast trace results", async () => {
    const tokenMint = "TokenMint11111111111111111111111111111111111";
    vi.mocked(getTraceAnalysis).mockResolvedValue({
      address: ADDRESS,
      events: [{
        signature: "token-1",
        timestamp: 1712620800,
        direction: "outflow",
        counterparty: COUNTERPARTY,
        counterpartyLabel: "Token Sender",
        assetId: tokenMint,
        kind: "token",
        mint: tokenMint,
        decimals: 6,
        rawAmount: "420000000",
        uiAmount: 420,
      }],
      assets: [{
        assetId: tokenMint,
        kind: "token",
        mint: tokenMint,
        decimals: 6,
        transferCount: 1,
        txCount: 1,
        uiAmount: 420,
      }],
      firstSeen: 1712620800,
      lastSeen: 1712620800,
      metadataPending: true,
    });
    vi.mocked(getTokenMetadataBatch).mockResolvedValue(new Map([
      [tokenMint, {
        symbol: "TOK",
        name: "Token",
      }],
    ]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    fireEvent.click(await screen.findByText("Outflow →"));
    fireEvent.click(await screen.findByText("Token Sender"));

    await screen.findByText("TOK");
  });

  it("marks non-wallet counterparties as wallet-only instead of allowing expansion", async () => {
    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows([{
      signature: "program-1",
      timestamp: 1712620800,
      direction: "outflow",
      counterparty: COUNTERPARTY,
      counterpartyLabel: "Program Counterparty",
      counterpartyAccountType: "program",
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      rawAmount: "5000000",
      uiAmount: 0.005,
      symbol: "SOL",
      name: "Native SOL",
    }]));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    fireEvent.click(await screen.findByText("Outflow →"));
    await screen.findByText("Program Counterparty");
    expect(screen.getByText("wallet only")).toBeTruthy();
  });

  it("adds a node to the graph without tracing it until the user clicks that node", async () => {
    vi.mocked(getTraceAnalysis)
      .mockResolvedValueOnce(createFlows([{
        signature: "seed-out-1",
        timestamp: 1712620800,
        direction: "outflow",
        counterparty: COUNTERPARTY,
        counterpartyLabel: "Child Wallet",
        counterpartyAccountType: "wallet",
        assetId: NATIVE_SOL_ASSET_ID,
        kind: "native",
        decimals: 9,
        rawAmount: "5000000",
        uiAmount: 0.005,
        symbol: "SOL",
        name: "Native SOL",
      }]))
      .mockResolvedValueOnce(createFlows([], { address: COUNTERPARTY }));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    await waitFor(() => {
      expect(getTraceAnalysis).toHaveBeenCalledTimes(1);
      expect(getTraceAnalysis).toHaveBeenCalledWith(ADDRESS, undefined, { limit: 2000 });
    });

    fireEvent.click(await screen.findByText("Outflow →"));
    await screen.findByText("Child Wallet");

    fireEvent.click(screen.getByRole("button", { name: "+" }));

    await waitFor(() => {
      expect(screen.getByTestId(`trace-node-${COUNTERPARTY}`)).toBeTruthy();
    });
    expect(getTraceAnalysis).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId(`trace-node-${COUNTERPARTY}`));

    await waitFor(() => {
      expect(getTraceAnalysis).toHaveBeenCalledTimes(2);
      expect(getTraceAnalysis).toHaveBeenLastCalledWith(COUNTERPARTY, undefined, { limit: 2000 });
    });
  });

  it("finds a deep-ranked counterparty when searching by a pasted full address", async () => {
    const targetAddress = "DKDnaM3y9aGxCkVLqacqnzhbFzBMMBSffRcnkswEtoju";
    const events = Array.from({ length: 40 }, (_, index) => ({
      signature: `inflow-${index + 1}`,
      timestamp: 1712620800 + index,
      direction: "inflow" as const,
      counterparty: `Cp${String(index).padStart(2, "0")}111111111111111111111111111111111`,
      counterpartyLabel: `Counterparty ${index + 1}`,
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native" as const,
      decimals: 9,
      rawAmount: "1000000",
      uiAmount: 0.001,
      symbol: "SOL",
      name: "Native SOL",
    }));

    events.push({
      signature: "target-inflow-1",
      timestamp: 1712629999,
      direction: "inflow",
      counterparty: targetAddress,
      assetId: NATIVE_SOL_ASSET_ID,
      kind: "native",
      decimals: 9,
      rawAmount: "172944720",
      uiAmount: 0.17294472,
      symbol: "SOL",
      name: "Native SOL",
    });

    vi.mocked(getTraceAnalysis).mockResolvedValue(createFlows(events));

    render(<TraceExplorer initialAddress={ADDRESS} />);

    const inflowHeader = await screen.findByText(/Inflow/i);
    fireEvent.click(inflowHeader);

    fireEvent.change(screen.getByPlaceholderText("Search counterparties..."), {
      target: { value: `  ${targetAddress}\n` },
    });

    await screen.findByText(targetAddress);
    expect(screen.queryByText("No matches")).toBeNull();
  });
});
