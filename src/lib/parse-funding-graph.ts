import type { Edge, Node } from "@xyflow/react";
import {
  forceCollide,
  forceRadial,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { FundingEdge, FundingWalkResult } from "@/lib/funding-walk";

const MIN_ANCESTOR = 50;
const MAX_ANCESTOR = 130;
const INTERMEDIATE_SIZE = 24;

function funderSize(holdersFunded: number, maxFunded: number): number {
  if (maxFunded <= 0) return MIN_ANCESTOR;
  const t = Math.log1p(holdersFunded) / Math.log1p(maxFunded);
  return MIN_ANCESTOR + t * (MAX_ANCESTOR - MIN_ANCESTOR);
}

function funderColor(holdersFunded: number, maxFunded: number): string {
  if (maxFunded <= 2) return holdersFunded >= 2 ? "#ffb800" : "#ffb800";
  const t = Math.log1p(holdersFunded) / Math.log1p(maxFunded);
  const r = 255;
  const g = Math.round(184 - t * 139);
  const b = Math.round(t * 45);
  return `rgb(${r}, ${g}, ${b})`;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  radius: number;
  preferredRadius: number;
}

function collectDescendantHolders(
  start: string,
  holderAddrs: Set<string>,
  funderTargets: Map<string, Set<string>>,
): Set<string> {
  const reached = new Set<string>();
  const queue = [start];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (holderAddrs.has(current) && current !== start) {
      reached.add(current);
      continue;
    }
    for (const target of funderTargets.get(current) ?? []) {
      if (!visited.has(target)) queue.push(target);
    }
  }

  return reached;
}

function buildIncludedSubgraph(
  fundingResult: FundingWalkResult,
): {
  includedNodes: Set<string>;
  includedEdges: FundingEdge[];
  descendantHolders: Map<string, Set<string>>;
} {
  const holderAddrs = new Set<string>();
  for (const [address, node] of fundingResult.nodes) {
    if (node.isHolder) holderAddrs.add(address);
  }

  const funderTargets = new Map<string, Set<string>>();
  for (const edge of fundingResult.edges) {
    if (!funderTargets.has(edge.source)) funderTargets.set(edge.source, new Set());
    funderTargets.get(edge.source)!.add(edge.target);
  }

  const descendantHolders = new Map<string, Set<string>>();
  const includedNodes = new Set<string>();
  for (const commonAncestor of fundingResult.commonFunders) {
    const reached = collectDescendantHolders(
      commonAncestor.address,
      holderAddrs,
      funderTargets,
    );
    if (reached.size === 0) continue;
    descendantHolders.set(commonAncestor.address, reached);

    const queue = [commonAncestor.address];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      includedNodes.add(current);
      for (const target of funderTargets.get(current) ?? []) {
        queue.push(target);
      }
    }
  }

  const includedEdges = fundingResult.edges.filter(
    (edge) => includedNodes.has(edge.source) && includedNodes.has(edge.target),
  );

  for (const address of includedNodes) {
    if (!descendantHolders.has(address)) {
      descendantHolders.set(
        address,
        collectDescendantHolders(address, holderAddrs, funderTargets),
      );
    }
  }

  return { includedNodes, includedEdges, descendantHolders };
}

export function appendFundingNodes(
  existingNodes: Node[],
  fundingResult: FundingWalkResult,
): { nodes: Node[]; edges: Edge[] } {
  if (fundingResult.commonFunders.length === 0) {
    return { nodes: existingNodes, edges: [] };
  }

  const { includedNodes, includedEdges, descendantHolders } = buildIncludedSubgraph(
    fundingResult,
  );
  if (includedNodes.size === 0) return { nodes: existingNodes, edges: [] };

  const existingIds = new Set(existingNodes.map((node) => node.id));
  const holderPositions = new Map<string, { x: number; y: number }>();
  let maxHolderDist = 0;
  for (const node of existingNodes) {
    if (node.id === "token-center") continue;
    holderPositions.set(node.id, node.position);
    const dist = Math.sqrt(node.position.x * node.position.x + node.position.y * node.position.y);
    if (dist > maxHolderDist) maxHolderDist = dist;
  }

  const maxDepth = Math.max(
    1,
    ...Array.from(includedNodes).map(
      (address) => fundingResult.nodes.get(address)?.depth ?? 1,
    ),
  );
  const maxFunded = Math.max(
    1,
    ...fundingResult.commonFunders.map((node) => node.holdersFunded),
  );

  const simulationNodes: SimNode[] = [];
  const renderedNodes: Node[] = [];

  for (const address of includedNodes) {
    if (existingIds.has(address)) continue;
    const fundingNode = fundingResult.nodes.get(address);
    if (!fundingNode) continue;

    const reached = descendantHolders.get(address) ?? new Set<string>();
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (const holder of reached) {
      const pos = holderPositions.get(holder);
      if (!pos) continue;
      cx += pos.x;
      cy += pos.y;
      count += 1;
    }

    const angle =
      count > 0
        ? Math.atan2(cy / count, cx / count)
        : (renderedNodes.length / Math.max(includedNodes.size, 1)) * Math.PI * 2;
    const preferredRadius = maxHolderDist + 70 + (fundingNode.depth / maxDepth) * 280;
    const isCommonAncestor = fundingResult.commonFunders.some(
      (node) => node.address === address,
    );
    const size = isCommonAncestor
      ? funderSize(fundingNode.holdersFunded, maxFunded)
      : INTERMEDIATE_SIZE;

    simulationNodes.push({
      id: address,
      radius: size / 2,
      preferredRadius,
      x: Math.cos(angle) * preferredRadius,
      y: Math.sin(angle) * preferredRadius,
    });

    if (isCommonAncestor) {
      renderedNodes.push({
        id: address,
        type: "funderNode",
        position: { x: 0, y: 0 },
        data: {
          address,
          label: fundingNode.label,
          holdersFunded: fundingNode.holdersFunded,
          holdersPctFunded: fundingNode.holdersPctFunded,
          nodeSize: size,
          color: funderColor(fundingNode.holdersFunded, maxFunded),
          isPrimary: fundingNode.holdersFunded >= 3,
        },
      });
    } else {
      renderedNodes.push({
        id: address,
        type: "intermediateNode",
        position: { x: 0, y: 0 },
        data: {
          address,
          label: fundingNode.label,
          nodeSize: size,
          color: "#3a4555",
        },
      });
    }
  }

  if (simulationNodes.length > 0) {
    const sim = forceSimulation<SimNode>(simulationNodes)
      .force(
        "collide",
        forceCollide<SimNode>((node) => node.radius + 14).iterations(4),
      )
      .force(
        "radial",
        forceRadial<SimNode>((node) => node.preferredRadius, 0, 0).strength(0.9),
      );
    sim.stop();
    for (let i = 0; i < 140; i++) sim.tick();

    const positions = new Map(
      simulationNodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
    );
    for (const node of renderedNodes) {
      const pos = positions.get(node.id);
      if (pos) node.position = pos;
    }
  }

  const edges: Edge[] = includedEdges
    .filter((edge) => includedNodes.has(edge.source) && includedNodes.has(edge.target))
    .map((edge, index) => {
      const sourceNode = fundingResult.nodes.get(edge.source);
      const weightBase = sourceNode?.holdersFunded ?? 1;
      return {
        id: `fund-${index}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        type: "fundingEdge",
        data: {
          amount: edge.amount,
          isHighlight: true,
          thickness: 1.2 + Math.min(weightBase / Math.max(maxFunded, 1), 1.4),
          opacity: 0.32 + Math.min(weightBase / Math.max(maxFunded, 1), 0.28),
        },
      };
    });

  return {
    nodes: [...existingNodes, ...renderedNodes],
    edges,
  };
}
