const { resolveWalletInputMock, rememberPreferredSolDomainMock } = vi.hoisted(() => ({
  resolveWalletInputMock: vi.fn(async (value: string) => value),
  rememberPreferredSolDomainMock: vi.fn(),
}));

vi.mock("@/api", () => ({
  resolveWalletInput: resolveWalletInputMock,
  rememberPreferredSolDomain: rememberPreferredSolDomainMock,
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "@/components/SearchBar";

const VALID_ADDRESS = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";

describe("SearchBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWalletInputMock.mockImplementation(async (value: string) => value);
  });

  it("autofocuses the input when requested", async () => {
    render(
      <SearchBar
        onSearch={vi.fn()}
        autoFocus
        defaultValue={VALID_ADDRESS}
      />,
    );

    await waitFor(() => {
      const input = screen.getByPlaceholderText("PASTE WALLET ADDRESS...") as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(VALID_ADDRESS.length);
      expect(input.selectionEnd).toBe(VALID_ADDRESS.length);
    });
  });

  it("focuses the input with the slash shortcut and submits with the custom button", async () => {
    const onSearch = vi.fn();

    render(
      <div>
        <button type="button">other</button>
        <SearchBar
          onSearch={onSearch}
          enableShortcut
          placeholder="Paste wallet address..."
          submitLabel="Trace"
        />
      </div>,
    );

    const input = screen.getByPlaceholderText("Paste wallet address...");
    const otherButton = screen.getByRole("button", { name: "other" });

    otherButton.focus();
    fireEvent.keyDown(window, { key: "/" });

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    fireEvent.change(input, { target: { value: VALID_ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledWith(VALID_ADDRESS);
    });
    expect(screen.getByText("/")).toBeTruthy();
  });

  it("resolves .sol domains before submitting", async () => {
    const onSearch = vi.fn();
    resolveWalletInputMock.mockResolvedValueOnce(VALID_ADDRESS);

    render(
      <SearchBar
        onSearch={onSearch}
        placeholder="Paste wallet address..."
        submitLabel="Trace"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Paste wallet address..."), {
      target: { value: "devrugged.sol" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(resolveWalletInputMock).toHaveBeenCalledWith("devrugged.sol");
      expect(onSearch).toHaveBeenCalledWith(VALID_ADDRESS);
    });
    expect(rememberPreferredSolDomainMock).toHaveBeenCalledWith(VALID_ADDRESS, "devrugged.sol");
  });

  it("shows a resolved .sol domain in the dropdown before submit", async () => {
    resolveWalletInputMock.mockResolvedValueOnce(VALID_ADDRESS);

    render(
      <SearchBar
        onSearch={vi.fn()}
        placeholder="Paste wallet address..."
        submitLabel="Trace"
      />,
    );

    const input = screen.getByPlaceholderText("Paste wallet address...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "toly.sol" } });

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Resolves to ${VALID_ADDRESS}`))).toBeTruthy();
    });
    expect(screen.getByText("toly.sol")).toBeTruthy();
    expect(screen.getByText("Valid")).toBeTruthy();
  });

  it("shows a resolution error for an unknown .sol domain", async () => {
    resolveWalletInputMock.mockRejectedValueOnce(new Error("Unable to resolve .sol domain"));

    render(
      <SearchBar
        onSearch={vi.fn()}
        placeholder="Paste wallet address..."
        submitLabel="Trace"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Paste wallet address..."), {
      target: { value: "missing.sol" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));

    await waitFor(() => {
      expect(screen.getByText("Unable to resolve .sol domain")).toBeTruthy();
    });
  });

  it("shows an invalid-domain dropdown state while typing an unknown .sol domain", async () => {
    resolveWalletInputMock.mockRejectedValueOnce(new Error("Unable to resolve .sol domain"));

    render(
      <SearchBar
        onSearch={vi.fn()}
        placeholder="Paste wallet address..."
        submitLabel="Trace"
      />,
    );

    const input = screen.getByPlaceholderText("Paste wallet address...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "missing.sol" } });

    await waitFor(() => {
      expect(screen.getByText("No matching .sol domain found")).toBeTruthy();
    });
    expect(screen.getByText("Invalid")).toBeTruthy();
  });
});
