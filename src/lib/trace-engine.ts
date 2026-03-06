import {
  getDirectionalAssets,
  getDirectionalTransferCount,
  getDirectionalTxCount,
  type TraceAssetFlow,
  type TraceCounterparty,
} from "@/lib/trace-types";
import type { Node, Edge } from "@xyflow/react";

// ---- Types ----

export interface TraceEdgeFlow {
  from: string;       // sender
  to: string;         // receiver
  assets: TraceAssetFlow[];
  txCount: number;
  transferCount: number;
  assetCount: number;
}

export interface TraceNodeData {
  address: string;
  label?: string;
  category?: string;
  column: number;      // x-axis position: negative = left (inflows), positive = right (outflows)
}

export interface TraceState {
  seedAddress: string;
  nodeMap: Map<string, TraceNodeData>;
  edgeMap: Map<string, TraceEdgeFlow>; // key = "from:to"
}

// ---- State management ----

export function createTraceState(
  seedAddress: string,
  label?: string,
  category?: string,
): TraceState {
  const nodeMap = new Map<string, TraceNodeData>();
  nodeMap.set(seedAddress, { address: seedAddress, label, category, column: 0 });
  return { seedAddress, nodeMap, edgeMap: new Map() };
}

/**
 * Add counterparties to the graph.
 * direction = "outflow": cp placed to the RIGHT of source, edge: source → cp
 * direction = "inflow": cp placed to the LEFT of source, edge: cp → source
 */
export function addCounterpartiesToGraph(
  state: TraceState,
  sourceAddr: string,
  cps: TraceCounterparty[],
  direction: "outflow" | "inflow",
): TraceState {
  const sourceNode = state.nodeMap.get(sourceAddr);
  if (!sourceNode) return state;

  const newNodeMap = new Map(state.nodeMap);
  const newEdgeMap = new Map(state.edgeMap);

  const targetColumn = direction === "outflow"
    ? sourceNode.column + 1
    : sourceNode.column - 1;

  for (const cp of cps) {
    // Add node if not already in graph
    if (!newNodeMap.has(cp.address)) {
      newNodeMap.set(cp.address, {
        address: cp.address,
        label: cp.label,
        category: cp.category,
        column: targetColumn,
      });
    }

    // Add directed edge
    if (direction === "outflow") {
      const key = `${sourceAddr}:${cp.address}`;
      if (!newEdgeMap.has(key)) {
        newEdgeMap.set(key, {
          from: sourceAddr,
          to: cp.address,
          assets: getDirectionalAssets(cp, direction),
          txCount: getDirectionalTxCount(cp, direction),
          transferCount: getDirectionalTransferCount(cp, direction),
          assetCount: getDirectionalAssets(cp, direction).length,
        });
      }
    } else {
      const key = `${cp.address}:${sourceAddr}`;
      if (!newEdgeMap.has(key)) {
        newEdgeMap.set(key, {
          from: cp.address,
          to: sourceAddr,
          assets: getDirectionalAssets(cp, direction),
          txCount: getDirectionalTxCount(cp, direction),
          transferCount: getDirectionalTransferCount(cp, direction),
          assetCount: getDirectionalAssets(cp, direction).length,
        });
      }
    }
  }

  return { seedAddress: state.seedAddress, nodeMap: newNodeMap, edgeMap: newEdgeMap };
}

/** Remove a node and all its edges */
export function removeNodeFromGraph(state: TraceState, address: string): TraceState {
  if (address === state.seedAddress) return state;

  const newNodeMap = new Map(state.nodeMap);
  const newEdgeMap = new Map(state.edgeMap);
  newNodeMap.delete(address);

  for (const [key, edge] of newEdgeMap) {
    if (edge.from === address || edge.to === address) newEdgeMap.delete(key);
  }

  return { seedAddress: state.seedAddress, nodeMap: newNodeMap, edgeMap: newEdgeMap };
}

// ---- Graph building: deterministic column layout ----

const COLUMN_WIDTH = 350;
const ROW_HEIGHT = 85;

export function buildTraceGraph(state: TraceState): { nodes: Node[]; edges: Edge[] } {
  const { seedAddress, nodeMap, edgeMap } = state;
  if (nodeMap.size === 0) return { nodes: [], edges: [] };

  // Group nodes by column
  const columns = new Map<number, TraceNodeData[]>();
  for (const [, node] of nodeMap) {
    if (!columns.has(node.column)) columns.set(node.column, []);
    columns.get(node.column)!.push(node);
  }

  // Compute per-node activity summaries for display only
  const nodeTxCount = new Map<string, number>();
  const nodeTransferCount = new Map<string, number>();
  for (const [, edge] of edgeMap) {
    nodeTxCount.set(edge.from, (nodeTxCount.get(edge.from) ?? 0) + edge.txCount);
    nodeTxCount.set(edge.to, (nodeTxCount.get(edge.to) ?? 0) + edge.txCount);
    nodeTransferCount.set(edge.from, (nodeTransferCount.get(edge.from) ?? 0) + edge.transferCount);
    nodeTransferCount.set(edge.to, (nodeTransferCount.get(edge.to) ?? 0) + edge.transferCount);
  }

  // Position: each column centered vertically around y=0
  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, colNodes] of columns) {
    const x = col * COLUMN_WIDTH;
    const totalHeight = (colNodes.length - 1) * ROW_HEIGHT;
    const startY = -totalHeight / 2;
    for (let i = 0; i < colNodes.length; i++) {
      positions.set(colNodes[i].address, { x, y: startY + i * ROW_HEIGHT });
    }
  }

  // Build ReactFlow nodes
  const nodes: Node[] = [];
  for (const [, node] of nodeMap) {
    const isSeed = node.address === seedAddress;
    const txCount = nodeTxCount.get(node.address) ?? 0;
    const transferCount = nodeTransferCount.get(node.address) ?? 0;

    nodes.push({
      id: node.address,
      type: "traceNode",
      draggable: true,
      data: {
        address: node.address,
        label: node.label,
        category: node.category,
        isSeed,
        txCount,
        transferCount,
      },
      position: positions.get(node.address) ?? { x: 0, y: 0 },
    });
  }

  // Build ReactFlow edges
  const edges: Edge[] = [];
  for (const [key, edge] of edgeMap) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    edges.push({
      id: key,
      source: edge.from,
      target: edge.to,
      type: "traceEdge",
      data: {
        assets: edge.assets,
        txCount: edge.txCount,
        transferCount: edge.transferCount,
        assetCount: edge.assetCount,
      },
    });
  }

  return { nodes, edges };
}
