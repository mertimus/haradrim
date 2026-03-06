import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TraceExplorer } from "../../src/components/TraceExplorer";
import { getIdentity } from "@/api";

vi.mock("@/api", () => ({
  getIdentity: vi.fn(),
}));

vi.mock("@/lib/backend-api", () => ({
  getTraceAnalysis: vi.fn(),
}));

vi.mock("@/components/TraceGraph", () => ({
  TraceGraph: () => <div data-testid="trace-graph" />,
}));

describe("TraceExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a retryable error banner when trace startup fails", async () => {
    vi.mocked(getIdentity).mockRejectedValueOnce(new Error("Identity unavailable"));

    render(<TraceExplorer />);

    fireEvent.change(screen.getByPlaceholderText("Paste wallet address..."), {
      target: { value: "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByText("Identity unavailable")).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
