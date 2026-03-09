import { describe, expect, it } from "vitest";
import { buildGraphData } from "@/lib/parse-transactions";

describe("buildGraphData", () => {
  it("places two single-wallet counterparties at different positions", () => {
    const graph = buildGraphData(
      "8CrRU1NzNpjL3k2BwjW3VixAcX6VFc29KHr4KZg8cs2Y",
      [
        {
          address: "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
          txCount: 331,
          solSent: 0.03,
          solReceived: 0,
          solNet: -0.03,
          firstSeen: 1712534400,
          lastSeen: 1738281600,
        },
        {
          address: "7MytW5N5m2b7sE4NABhWmfw3uD9hDk8i7vN7hDzDkX1",
          txCount: 226,
          solSent: 0,
          solReceived: 0.04,
          solNet: 0.04,
          firstSeen: 1699574400,
          lastSeen: 1730851200,
        },
      ],
      null,
      undefined,
      50,
    );

    const first = graph.nodes.find((node) => node.id === "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL");
    const second = graph.nodes.find((node) => node.id === "7MytW5N5m2b7sE4NABhWmfw3uD9hDk8i7vN7hDzDkX1");

    expect(first?.position).toBeTruthy();
    expect(second?.position).toBeTruthy();
    expect(first?.position).not.toEqual(second?.position);
  });
});
