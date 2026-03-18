import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "../../src/components/TraceExplorer";
import { getBatchSolDomains, getIdentity } from "@/api";
import { getTraceAnalysis } from "@/lib/backend-api";

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

describe("TraceExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
});
