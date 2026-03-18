import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "../../src/components/TraceExplorer";
import { getBatchSolDomains, getIdentity } from "@/api";
import { getTraceAnalysis } from "@/lib/backend-api";
import {
  DEFAULT_TRACE_SOL_DUST_THRESHOLD_SOL,
  NATIVE_SOL_ASSET_ID,
  type TraceNodeFlows,
} from "@/lib/trace-types";

vi.mock("@/api", () => ({
  getIdentity: vi.fn(),
  getBatchSolDomains: vi.fn(async () => new Map()),
  resolveWalletInput: vi.fn(async (value: string) => value),
  rememberPreferredSolDomain: vi.fn(),
}));

vi.mock("@/lib/backend-api", () => ({
  getTraceAnalysis: vi.fn(),
  parseTransactions: vi.fn(async () => ({ transactions: [] })),
}));

vi.mock("@/components/TraceGraph", () => ({
  TraceGraph: () => <div data-testid="trace-graph" />,
}));

const ADDRESS = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const COUNTERPARTY = "9ZvA5bD5mEBnNsxkVQxgs5gcm4qg3L5BoXxq3GR7oJ6f";

function createFlows(events: TraceNodeFlows["events"]): TraceNodeFlows {
  return {
    address: ADDRESS,
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
    metadataPending: false,
  };
}

describe("TraceExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getIdentity).mockResolvedValue(null);
    vi.mocked(getBatchSolDomains).mockResolvedValue(new Map());
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

    const filterButton = screen.getByRole("button", { name: "Trace filters" });
    expect(within(filterButton).queryByText("1")).toBeNull();

    fireEvent.click(filterButton);
    const dustToggle = screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement;
    expect(dustToggle.checked).toBe(true);

    fireEvent.click(dustToggle);

    await screen.findByText("Dust Sender");
    expect(within(filterButton).getByText("1")).toBeTruthy();
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

    await screen.findByRole("button", { name: "Trace filters" });
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    const filterButton = screen.getByRole("button", { name: "Trace filters" });
    fireEvent.click(filterButton);

    const dustToggle = screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement;
    fireEvent.click(dustToggle);

    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(within(filterButton).getByText("1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect((screen.getByLabelText(/Hide SOL dust/) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
      expect(within(filterButton).queryByText("1")).toBeNull();
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

    await screen.findByText("Big Sender");

    fireEvent.click(screen.getByRole("button", { name: "Trace filters" }));
    fireEvent.change(screen.getByLabelText("From"), {
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
});
