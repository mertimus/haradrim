import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CounterpartyDetailPanel } from "@/components/CounterpartyDetailPanel";

describe("CounterpartyDetailPanel", () => {
  it("can transition from empty state to a selected detail without crashing", () => {
    const { rerender } = render(
      <CounterpartyDetailPanel
        detail={null}
        loading={false}
        graphAddresses={new Set()}
        onNavigate={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onAddOverlay={vi.fn()}
      />,
    );

    rerender(
      <CounterpartyDetailPanel
        detail={{
          address: "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
          label: "jitotip7.sol",
          txCount: 331,
          solSent: 0.03,
          solReceived: 0,
          solNet: -0.03,
          firstSeen: 1712534400,
          lastSeen: 1738281600,
          connectedWallets: [],
        }}
        loading={false}
        graphAddresses={new Set()}
        onNavigate={vi.fn()}
        onAddNode={vi.fn()}
        onRemoveNode={vi.fn()}
        onAddOverlay={vi.fn()}
      />,
    );

    expect(screen.getByText("jitotip7.sol")).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
  });
});
