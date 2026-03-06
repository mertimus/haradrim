import type { Node, Edge } from "@xyflow/react";
import {
  forceSimulation,
  forceCollide,
  forceRadial,
  type SimulationNodeDatum,
} from "d3-force";
import type { FundingWalkResult } from "@/lib/funding-walk";

// ---- Sizing ----

const MIN_FUNDER = 50;
const MAX_FUNDER = 130;

function funderSize(holdersFunded: number, maxFunded: number): number {
  if (maxFunded <= 0) return MIN_FUNDER;
  const t = Math.log1p(holdersFunded) / Math.log1p(maxFunded);
  return MIN_FUNDER + t * (MAX_FUNDER - MIN_FUNDER);
}

// ---- Coloring ----

function funderColor(holdersFunded: number, maxFunded: number): string {
  if (maxFunded <= 2) return holdersFunded >= 2 ? "#ff2d2d" : "#ffb800";
  const t = Math.log1p(holdersFunded) / Math.log1p(maxFunded);
  const r = 255;
  const g = Math.round(184 - t * 139);
  const b = Math.round(0 + t * 45);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---- Layout ----

interface SimNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

/**
 * Append funding nodes onto an existing holder graph.
 *
 * Only adds **common funders** (holdersFunded >= 2) — intermediates are skipped.
 * Funders are placed in an outer ring well beyond the holder cluster.
 * Direct edges connect each funder to each holder it funded.
 */
export function appendFundingNodes(
  existingNodes: Node[],
  fundingResult: FundingWalkResult,
): { nodes: Node[]; edges: Edge[] } {
  const { nodes: fnodes, edges: _fedges, commonFunders } = fundingResult;

  if (commonFunders.length === 0) return { nodes: existingNodes, edges: [] };

  const maxFunded = commonFunders[0].holdersFunded;

  // Collect existing holder positions & compute cluster radius
  const holderPositions = new Map<string, { x: number; y: number }>();
  let maxHolderDist = 0;
  for (const node of existingNodes) {
    if (node.id === "token-center") continue;
    const { x, y } = node.position;
    holderPositions.set(node.id, { x, y });
    const d = Math.sqrt(x * x + y * y);
    if (d > maxHolderDist) maxHolderDist = d;
  }

  // Holder addresses in the graph
  const holderAddrs = new Set<string>();
  for (const [addr, fnode] of fnodes) {
    if (fnode.isHolder) holderAddrs.add(addr);
  }

  // Build downward adjacency from walk edges: source → targets
  const funderTargets = new Map<string, Set<string>>();
  for (const e of _fedges) {
    if (!funderTargets.has(e.source)) funderTargets.set(e.source, new Set());
    funderTargets.get(e.source)!.add(e.target);
  }

  // For each common funder, BFS down to find which holders it reaches
  const funderToHolders = new Map<string, Set<string>>();
  for (const cf of commonFunders) {
    const reached = new Set<string>();
    const queue = [cf.address];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      if (holderAddrs.has(cur) && cur !== cf.address) {
        reached.add(cur);
        continue;
      }
      const targets = funderTargets.get(cur);
      if (targets) {
        for (const t of targets) if (!visited.has(t)) queue.push(t);
      }
    }
    funderToHolders.set(cf.address, reached);
  }

  // Place funders in an outer ring
  // Ring radius = holder cluster radius + generous gap
  const ringRadius = maxHolderDist + 350;

  const funderSimNodes: SimNode[] = [];
  const funderRfNodes: Node[] = [];

  for (let i = 0; i < commonFunders.length; i++) {
    const cf = commonFunders[i];
    const size = funderSize(cf.holdersFunded, maxFunded);
    const reached = funderToHolders.get(cf.address) ?? new Set<string>();

    // Compute centroid of funded holders to bias angular placement
    let cx = 0;
    let cy = 0;
    let count = 0;
    for (const h of reached) {
      const pos = holderPositions.get(h);
      if (pos) {
        cx += pos.x;
        cy += pos.y;
        count++;
      }
    }

    let angle: number;
    if (count > 0) {
      cx /= count;
      cy /= count;
      angle = Math.atan2(cy, cx);
    } else {
      // Distribute evenly if no holder positions found
      angle = (i / commonFunders.length) * Math.PI * 2;
    }

    const x = Math.cos(angle) * ringRadius;
    const y = Math.sin(angle) * ringRadius;

    funderSimNodes.push({ id: cf.address, x, y, radius: size / 2 });

    const color = funderColor(cf.holdersFunded, maxFunded);
    funderRfNodes.push({
      id: cf.address,
      type: "funderNode",
      position: { x: 0, y: 0 }, // set after sim
      data: {
        address: cf.address,
        label: cf.label,
        holdersFunded: cf.holdersFunded,
        holdersPctFunded: cf.holdersPctFunded,
        nodeSize: size,
        color,
        isPrimary: cf.holdersFunded >= 3,
      },
    });
  }

  // Collision + radial sim to spread funders around the ring without overlap
  if (funderSimNodes.length > 0) {
    const sim = forceSimulation<SimNode>(funderSimNodes)
      .force(
        "collide",
        forceCollide<SimNode>((d) => d.radius + 20).iterations(4),
      )
      .force(
        "radial",
        forceRadial<SimNode>(ringRadius, 0, 0).strength(0.8),
      );
    sim.stop();
    for (let i = 0; i < 120; i++) sim.tick();

    const simPos = new Map(
      funderSimNodes.map((sn) => [sn.id, { x: sn.x ?? 0, y: sn.y ?? 0 }]),
    );
    for (const node of funderRfNodes) {
      const pos = simPos.get(node.id);
      if (pos) node.position = pos;
    }
  }

  // Build edges: funder → each funded holder
  const edges: Edge[] = [];
  let edgeIdx = 0;
  for (const cf of commonFunders) {
    const reached = funderToHolders.get(cf.address) ?? new Set<string>();
    for (const holderAddr of reached) {
      if (!holderPositions.has(holderAddr)) continue;
      edges.push({
        id: `fund-${edgeIdx++}`,
        source: cf.address,
        target: holderAddr,
        type: "fundingEdge",
        data: {
          amount: 0,
          isHighlight: true,
          thickness: 1.5 + Math.min((cf.holdersFunded / Math.max(maxFunded, 1)) * 1.5, 1.5),
          opacity: 0.35 + Math.min((cf.holdersFunded / Math.max(maxFunded, 1)) * 0.25, 0.25),
        },
      });
    }
  }

  return {
    nodes: [...existingNodes, ...funderRfNodes],
    edges,
  };
}
