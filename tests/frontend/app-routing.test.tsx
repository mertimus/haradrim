import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";

const traceExplorerMock = vi.hoisted(() =>
  vi.fn(({ initialAddress }: { initialAddress?: string }) => (
    <div data-testid="trace-explorer" data-address={initialAddress ?? ""} />
  )),
);

const counterpartyExplorerMock = vi.hoisted(() =>
  vi.fn(({ initialAddress }: { initialAddress?: string }) => (
    <div data-testid="counterparty-explorer" data-address={initialAddress ?? ""} />
  )),
);

vi.mock("@/components/TraceExplorer", () => ({
  TraceExplorer: traceExplorerMock,
}));

vi.mock("@/components/CounterpartyExplorer", () => ({
  CounterpartyExplorer: counterpartyExplorerMock,
}));

const ADDRESS = "8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y";

describe("App trace routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("renders the trace explorer on the base route", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("trace-explorer")).toBeTruthy();
    });
    expect(screen.getByTestId("trace-explorer").getAttribute("data-address")).toBe("");
  });

  it("passes the traced wallet from /trace/:address into the explorer", async () => {
    window.history.pushState({}, "", `/trace/${ADDRESS}`);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("trace-explorer").getAttribute("data-address")).toBe(ADDRESS);
    });
  });

  it("updates the traced wallet on popstate navigation", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("trace-explorer").getAttribute("data-address")).toBe("");
    });

    window.history.pushState({}, "", `/trace/${ADDRESS}`);
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => {
      expect(screen.getByTestId("trace-explorer").getAttribute("data-address")).toBe(ADDRESS);
    });
  });

  it("renders the counterparties explorer for /counterparties/:address", async () => {
    window.history.pushState({}, "", `/counterparties/${ADDRESS}`);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("counterparty-explorer").getAttribute("data-address")).toBe(ADDRESS);
    });
  });
});
