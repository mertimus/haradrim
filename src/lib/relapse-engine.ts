import type { CounterpartyFlow, ParsedTransaction } from "@/lib/parse-transactions";
import type { Edge } from "@xyflow/react";

export interface RelapseFrameStats {
  counterparties: number;
  txCount: number;
  volume: number;
  walletBalance: number;
}

export interface RelapseFrame {
  time: number;
  newNodeIds: string[];
  newEdgeIds: string[];
  durationMs: number;
  stats: RelapseFrameStats;
}

export interface RelapseData {
  frames: RelapseFrame[];
  timeStart: number;
  timeEnd: number;
  finalStats: RelapseFrameStats;
  /** Pre-computed cumulative visible sets for O(1) seeking */
  cumulativeNodeIds: string[][];
  cumulativeEdgeIds: string[][];
}

const TARGET_FRAMES = 300;
const TIME_BUCKETS = 600;
const BASE_DURATION_MS = 33;
const DECEL_FRAMES = 15;
const FINAL_HOLD_MS = 500;
const MAX_NODES_PER_FRAME = 3;
const MIN_ANIMATION_MS = 3000;

/** Resolve an accountKey to its string pubkey */
/**
 * Build all relapse frames from counterparties and raw transactions.
 * Pure function — no React dependency.
 */
export function buildRelapseData(
  counterparties: CounterpartyFlow[],
  rawTxs: ParsedTransaction[],
  edges: Edge[],
): RelapseData {
  if (counterparties.length === 0) {
    return {
      frames: [],
      timeStart: 0,
      timeEnd: 0,
      finalStats: { counterparties: 0, txCount: 0, volume: 0, walletBalance: 0 },
      cumulativeNodeIds: [],
      cumulativeEdgeIds: [],
    };
  }

  // Sort counterparties by firstSeen ascending
  const sortedCps = [...counterparties].sort((a, b) => a.firstSeen - b.firstSeen);

  // Sort raw txs by blockTime ascending
  const sortedTxs = [...rawTxs]
    .filter((tx) => tx.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const timeStart = Math.min(
    sortedCps[0].firstSeen,
    sortedTxs.length > 0 ? sortedTxs[0].timestamp : Infinity,
  );
  const timeEnd = Math.max(
    sortedCps[sortedCps.length - 1].lastSeen,
    sortedTxs.length > 0 ? sortedTxs[sortedTxs.length - 1].timestamp : 0,
  );

  // Build edge lookup: counterparty address → edge IDs
  const edgeByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const target = edge.target;
    const existing = edgeByTarget.get(target);
    if (existing) {
      existing.push(edge.id);
    } else {
      edgeByTarget.set(target, [edge.id]);
    }
  }

  // Compute final wallet balance + total volume from all txs (for stats)
  let finalTxCount = 0;
  let finalVolume = 0;
  const finalBalance = sortedTxs.length > 0 ? sortedTxs[sortedTxs.length - 1].walletBalanceAfter : 0;
  for (const tx of sortedTxs) {
    finalTxCount++;
    finalVolume += Math.abs(tx.solChange);
  }

  // ---- Build raw frames from time-bucketed distribution ----

  let rawFrames: RelapseFrame[];

  const singleTimestamp = timeEnd <= timeStart;

  if (singleTimestamp) {
    // All events at same time — create one raw frame with everything
    rawFrames = [{
      time: timeStart,
      newNodeIds: sortedCps.map((cp) => cp.address),
      newEdgeIds: [],
      durationMs: BASE_DURATION_MS,
      stats: {
        counterparties: sortedCps.length,
        txCount: finalTxCount,
        volume: Math.round(finalVolume * 100) / 100,
        walletBalance: Math.round(finalBalance * 100) / 100,
      },
    }];
    // Assign edges to last node in each frame (done after splitting)
  } else {
    const timeSpan = timeEnd - timeStart;
    const bucketDuration = timeSpan / TIME_BUCKETS;
    const txsPerBucket = new Array<number>(TIME_BUCKETS).fill(0);

      for (const tx of sortedTxs) {
      const bt = tx.timestamp;
      let bucket = Math.floor((bt - timeStart) / bucketDuration);
      if (bucket >= TIME_BUCKETS) bucket = TIME_BUCKETS - 1;
      if (bucket < 0) bucket = 0;
      txsPerBucket[bucket]++;
    }

    // Adaptive frame distribution
    const totalTxs = sortedTxs.length;
    const txsPerFrame = Math.max(totalTxs / TARGET_FRAMES, 1);
    const frameBoundaries: Array<{ startBucket: number; endBucket: number }> = [];

    let currentStart = 0;
    let accum = 0;

    for (let b = 0; b < TIME_BUCKETS; b++) {
      accum += txsPerBucket[b];
      if (accum >= txsPerFrame || b === TIME_BUCKETS - 1) {
        frameBoundaries.push({ startBucket: currentStart, endBucket: b });
        currentStart = b + 1;
        accum = 0;
      }
    }

    if (frameBoundaries.length > TARGET_FRAMES) {
      frameBoundaries.length = TARGET_FRAMES;
      frameBoundaries[frameBoundaries.length - 1].endBucket = TIME_BUCKETS - 1;
    }
    if (frameBoundaries.length === 0) {
      frameBoundaries.push({ startBucket: 0, endBucket: TIME_BUCKETS - 1 });
    }

    const numFrames = frameBoundaries.length;

    // Assign counterparties to frames
    const frameNewNodes: string[][] = Array.from({ length: numFrames }, () => []);
    let cpIdx = 0;

    for (let fi = 0; fi < numFrames; fi++) {
      const frameTimeEnd = timeStart + (frameBoundaries[fi].endBucket + 1) * bucketDuration;
      while (cpIdx < sortedCps.length && sortedCps[cpIdx].firstSeen <= frameTimeEnd) {
        frameNewNodes[fi].push(sortedCps[cpIdx].address);
        cpIdx++;
      }
    }
    while (cpIdx < sortedCps.length) {
      frameNewNodes[numFrames - 1].push(sortedCps[cpIdx].address);
      cpIdx++;
    }

    // Build frames with running stats
    let txPointer = 0;
    let cumulativeTxCount = 0;
    let cumulativeVolume = 0;
    let walletBalance = sortedTxs.length > 0 ? sortedTxs[0].walletBalanceAfter - sortedTxs[0].solChange : 0;
    let cumulativeCpCount = 0;

    rawFrames = [];

    for (let fi = 0; fi < numFrames; fi++) {
      const frameTimeEnd = timeStart + (frameBoundaries[fi].endBucket + 1) * bucketDuration;

      // Advance tx pointer
      while (txPointer < sortedTxs.length) {
        const tx = sortedTxs[txPointer];
        const bt = tx.timestamp;
        if (bt > frameTimeEnd) break;

        cumulativeTxCount++;
        cumulativeVolume += Math.abs(tx.solChange);
        walletBalance = tx.walletBalanceAfter;
        txPointer++;
      }

      cumulativeCpCount += frameNewNodes[fi].length;

      // Assign edges for nodes in this frame
      const frameEdgeIds: string[] = [];
      for (const addr of frameNewNodes[fi]) {
        const eids = edgeByTarget.get(addr);
        if (eids) frameEdgeIds.push(...eids);
      }

      rawFrames.push({
        time: frameTimeEnd,
        newNodeIds: frameNewNodes[fi],
        newEdgeIds: frameEdgeIds,
        durationMs: BASE_DURATION_MS,
        stats: {
          counterparties: cumulativeCpCount,
          txCount: cumulativeTxCount,
          volume: Math.round(cumulativeVolume * 100) / 100,
          walletBalance: Math.round(walletBalance * 100) / 100,
        },
      });
    }
  }

  // ---- Post-process: split dense frames so max N nodes per frame ----
  const spreadFrames: RelapseFrame[] = [];

  for (const frame of rawFrames) {
    if (frame.newNodeIds.length <= MAX_NODES_PER_FRAME) {
      spreadFrames.push(frame);
      continue;
    }

    // Split into sub-frames
    const numSub = Math.ceil(frame.newNodeIds.length / MAX_NODES_PER_FRAME);
    const nodesPerSub = Math.ceil(frame.newNodeIds.length / numSub);

    // Build edge map for this frame's nodes
    const nodeEdgeMap = new Map<string, string[]>();
    for (const nodeId of frame.newNodeIds) {
      const eids = edgeByTarget.get(nodeId);
      if (eids) nodeEdgeMap.set(nodeId, eids);
    }

    let cumulativeCpSoFar = frame.stats.counterparties - frame.newNodeIds.length;

    for (let s = 0; s < numSub; s++) {
      const start = s * nodesPerSub;
      const end = Math.min(start + nodesPerSub, frame.newNodeIds.length);
      const subNodes = frame.newNodeIds.slice(start, end);
      const subEdges: string[] = [];
      for (const nid of subNodes) {
        const eids = nodeEdgeMap.get(nid);
        if (eids) subEdges.push(...eids);
      }

      cumulativeCpSoFar += subNodes.length;
      const isLast = s === numSub - 1;

      spreadFrames.push({
        time: frame.time,
        newNodeIds: subNodes,
        newEdgeIds: subEdges,
        durationMs: BASE_DURATION_MS,
        stats: isLast ? frame.stats : {
          ...frame.stats,
          counterparties: cumulativeCpSoFar,
        },
      });
    }
  }

  // ---- Apply deceleration curve to final frames ----
  const totalFrames = spreadFrames.length;
  for (let fi = 0; fi < totalFrames; fi++) {
    const framesFromEnd = totalFrames - 1 - fi;
    if (framesFromEnd < DECEL_FRAMES && totalFrames > DECEL_FRAMES) {
      const progress = 1 - framesFromEnd / DECEL_FRAMES;
      spreadFrames[fi].durationMs = BASE_DURATION_MS * (1 + progress * 3);
    }
    if (fi === totalFrames - 1) {
      spreadFrames[fi].durationMs = FINAL_HOLD_MS;
    }
  }

  // ---- Ensure minimum total animation time ----
  const totalDuration = spreadFrames.reduce((sum, f) => sum + f.durationMs, 0);
  if (totalDuration < MIN_ANIMATION_MS && spreadFrames.length > 1) {
    const scale = MIN_ANIMATION_MS / totalDuration;
    for (const f of spreadFrames) {
      f.durationMs *= scale;
    }
  }

  // ---- Pre-compute cumulative visible sets for O(1) seeking ----
  const cumulativeNodeIds: string[][] = [];
  const cumulativeEdgeIds: string[][] = [];
  let allNodes: string[] = [];
  let allEdges: string[] = [];

  for (let fi = 0; fi < spreadFrames.length; fi++) {
    allNodes = [...allNodes, ...spreadFrames[fi].newNodeIds];
    allEdges = [...allEdges, ...spreadFrames[fi].newEdgeIds];
    cumulativeNodeIds.push([...allNodes]);
    cumulativeEdgeIds.push([...allEdges]);
  }

  const finalStats = spreadFrames.length > 0 ? spreadFrames[spreadFrames.length - 1].stats : {
    counterparties: 0, txCount: 0, volume: 0, walletBalance: 0,
  };

  return {
    frames: spreadFrames,
    timeStart,
    timeEnd: Math.max(timeEnd, timeStart),
    finalStats,
    cumulativeNodeIds,
    cumulativeEdgeIds,
  };
}
