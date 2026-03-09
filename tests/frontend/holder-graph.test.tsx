import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HolderGraph } from "@/components/HolderGraph";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    nodeTypes,
    children,
  }: {
    nodes: Array<{ id: string; type?: string; data: unknown }>;
    nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
    children?: React.ReactNode;
  }) => (
    <div className="react-flow">
      {nodes.map((node) => {
        const NodeComponent = nodeTypes?.[node.type ?? ""];
        if (!NodeComponent) return null;
        return (
          <div
            key={node.id}
            className="react-flow__node"
            data-id={node.id}
          >
            <NodeComponent
              id={node.id}
              type={node.type}
              data={node.data}
              selected={false}
              dragging={false}
              isConnectable={false}
              xPos={0}
              yPos={0}
              zIndex={0}
            />
          </div>
        );
      })}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Right: "right", Left: "left" },
  BackgroundVariant: { Lines: "lines" },
  useNodesState: (initial: unknown[]) => {
    const [state, setState] = React.useState(initial);
    return [state, setState, vi.fn()] as const;
  },
  useEdgesState: (initial: unknown[]) => {
    const [state, setState] = React.useState(initial);
    return [state, setState, vi.fn()] as const;
  },
}));

vi.mock("@/components/ConnectionEdge", () => ({
  ConnectionEdge: () => null,
}));

vi.mock("@/components/EvidenceEdge", () => ({
  EvidenceEdge: () => null,
}));

vi.mock("@/components/FundingNodes", () => ({
  FunderNode: () => null,
  IntermediateNode: () => null,
  FundingEdge: () => null,
}));

describe("HolderGraph", () => {
  it("renders holder nodes without an edges prop", () => {
    render(
      <HolderGraph
        loading={false}
        nodes={[
          {
            id: "token-center",
            type: "bubbleNode",
            position: { x: 0, y: 0 },
            data: {
              isCenter: true,
              symbol: "TEST",
              holderCount: 2,
              nodeSize: 80,
            },
          },
          {
            id: "wallet-a",
            type: "bubbleNode",
            position: { x: 120, y: 0 },
            data: {
              isCenter: false,
              address: "wallet-a",
              percentage: 12.5,
              nodeSize: 64,
              color: "#00d4ff",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("TEST")).toBeTruthy();
    expect(screen.getByText("2 holders")).toBeTruthy();
  });
});
