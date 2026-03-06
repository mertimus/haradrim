import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { Edge } from "@xyflow/react";
import type { CounterpartyFlow, ParsedTransaction } from "@/lib/parse-transactions";
import { buildRelapseData } from "@/lib/relapse-engine";
import type { RelapseData } from "@/lib/relapse-engine";

interface TimeRelapseProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  counterparties: CounterpartyFlow[];
  rawTxs: ParsedTransaction[];
  edges: Edge[];
  centerAddress: string;
}

type PlaybackState = "idle" | "starting" | "playing" | "paused" | "done";
type Speed = 1 | 2 | 4;

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatSol(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

export function TimeRelapse({
  containerRef,
  counterparties,
  rawTxs,
  edges,
  centerAddress,
}: TimeRelapseProps) {
  const [state, setState] = useState<PlaybackState>("idle");
  const [frameIndex, setFrameIndex] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);

  const relapseDataRef = useRef<RelapseData | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const speedRef = useRef<Speed>(1);
  const stateRef = useRef<PlaybackState>("idle");
  const advanceRef = useRef<(frameIndex: number) => void>(() => {});

  // Pre-compute relapse data when inputs change
  const relapseData = useMemo(() => {
    if (counterparties.length === 0) return null;
    return buildRelapseData(counterparties, rawTxs, edges);
  }, [counterparties, rawTxs, edges]);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    relapseDataRef.current = relapseData;
  }, [relapseData]);

  const cleanup = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.classList.remove("relapse-active");

    const visibleNodes = container.querySelectorAll(".react-flow__node.relapse-visible");
    for (const el of visibleNodes) el.classList.remove("relapse-visible");

    const visibleEdges = container.querySelectorAll(".react-flow__edge.relapse-visible");
    for (const el of visibleEdges) el.classList.remove("relapse-visible");

    const centerNodes = container.querySelectorAll(".react-flow__node.relapse-center");
    for (const el of centerNodes) el.classList.remove("relapse-center");
  }, [containerRef]);

  const abort = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    for (const t of startupTimeoutsRef.current) clearTimeout(t);
    startupTimeoutsRef.current = [];
    cleanup();
    setState("idle");
    setFrameIndex(0);
  }, [cleanup]);

  // Cleanup on unmount or when new wallet loads
  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort, centerAddress]);

  // If counterparties change while playing (new wallet loaded), abort
  const counterpartiesRef = useRef(counterparties);
  useEffect(() => {
    if (counterpartiesRef.current !== counterparties) {
      counterpartiesRef.current = counterparties;
      if (stateRef.current !== "idle") {
        const timeoutId = setTimeout(() => {
          abort();
        }, 0);
        return () => clearTimeout(timeoutId);
      }
    }
  }, [counterparties, abort]);

  const applyFrame = useCallback((fi: number) => {
    const container = containerRef.current;
    const data = relapseDataRef.current;
    if (!container || !data || fi < 0 || fi >= data.frames.length) return;

    const frame = data.frames[fi];

    // Add relapse-visible to new nodes
    for (const nodeId of frame.newNodeIds) {
      const el = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
      );
      if (el) el.classList.add("relapse-visible");
    }

    // Add relapse-visible to new edges
    for (const edgeId of frame.newEdgeIds) {
      const el = container.querySelector(
        `.react-flow__edge[data-id="${CSS.escape(edgeId)}"]`,
      );
      if (el) el.classList.add("relapse-visible");
    }
  }, [containerRef]);

  const seekTo = useCallback((targetFrame: number) => {
    const container = containerRef.current;
    const data = relapseDataRef.current;
    if (!container || !data) return;

    // Clear all visibility
    const visibleNodes = container.querySelectorAll(".react-flow__node.relapse-visible");
    for (const el of visibleNodes) el.classList.remove("relapse-visible");
    const visibleEdges = container.querySelectorAll(".react-flow__edge.relapse-visible");
    for (const el of visibleEdges) el.classList.remove("relapse-visible");

    if (targetFrame < 0) return;

    // Use pre-computed cumulative sets for O(1) seeking
    const clampedFrame = Math.min(targetFrame, data.frames.length - 1);
    const nodeIds = data.cumulativeNodeIds[clampedFrame];
    const edgeIds = data.cumulativeEdgeIds[clampedFrame];

    for (const nodeId of nodeIds) {
      const el = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
      );
      if (el) el.classList.add("relapse-visible");
    }
    for (const edgeId of edgeIds) {
      const el = container.querySelector(
        `.react-flow__edge[data-id="${CSS.escape(edgeId)}"]`,
      );
      if (el) el.classList.add("relapse-visible");
    }
  }, [containerRef]);

  const advance = useCallback((fi: number) => {
    const data = relapseDataRef.current;
    if (!data || fi >= data.frames.length) {
      setState("done");
      return;
    }

    applyFrame(fi);
    setFrameIndex(fi);

    const nextFi = fi + 1;
    if (nextFi >= data.frames.length) {
      setState("done");
      return;
    }

    const frameDuration = data.frames[fi].durationMs / speedRef.current;
    timeoutRef.current = setTimeout(() => advanceRef.current(nextFi), frameDuration);
  }, [applyFrame]);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  const startPlayback = useCallback(() => {
    const container = containerRef.current;
    const data = relapseDataRef.current;
    if (!container || !data || data.frames.length === 0) return;

    setState("starting");
    setFrameIndex(0);

    // Clear any previous startup timeouts
    for (const t of startupTimeoutsRef.current) clearTimeout(t);
    startupTimeoutsRef.current = [];

    // Phase 1: Hide everything
    container.classList.add("relapse-active");

    // Phase 2: After 500ms, bloom center node
    const t1 = setTimeout(() => {
      if (stateRef.current === "idle") return; // aborted
      const centerEl = container.querySelector(
        `.react-flow__node[data-id="${CSS.escape(centerAddress)}"]`,
      );
      if (centerEl) centerEl.classList.add("relapse-center");

      // Phase 3: After 1.5s total (1s more), start playback
      const t2 = setTimeout(() => {
        if (stateRef.current === "idle") return; // aborted
        setState("playing");
        advance(0);
      }, 1000);
      startupTimeoutsRef.current.push(t2);
    }, 500);
    startupTimeoutsRef.current.push(t1);
  }, [containerRef, centerAddress, advance]);

  const togglePause = useCallback(() => {
    if (state === "playing") {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState("paused");
    } else if (state === "paused") {
      setState("playing");
      advance(frameIndex + 1);
    }
  }, [state, frameIndex, advance]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const target = Number(e.target.value);
    setFrameIndex(target);
    seekTo(target);

    // If was playing, pause
    if (state === "playing" && timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      setState("paused");
    }
    // If was done, mark paused
    if (state === "done") {
      setState("paused");
    }
  }, [state, seekTo]);

  const handleClose = useCallback(() => {
    abort();
  }, [abort]);

  const handleSpeedChange = useCallback((s: Speed) => {
    setSpeed(s);
  }, []);

  // Current frame stats
  const currentFrame = relapseData && frameIndex < relapseData.frames.length
    ? relapseData.frames[frameIndex]
    : null;

  const isActive = state !== "idle";
  const showButton = !isActive && counterparties.length > 0;

  return (
    <>
      {/* Trigger button */}
      {showButton && (
        <button
          onClick={startPlayback}
          style={{
            position: "absolute",
            bottom: 40,
            left: 8,
            zIndex: 10,
            background: "rgba(13, 19, 33, 0.85)",
            border: "1px solid #1e2a3a",
            borderRadius: 4,
            padding: "5px 10px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "#6b7b8d",
            cursor: "pointer",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "#00d4ff";
            e.currentTarget.style.color = "#00d4ff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "#1e2a3a";
            e.currentTarget.style.color = "#6b7b8d";
          }}
        >
          {/* Play triangle */}
          <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor">
            <polygon points="0,0 8,5 0,10" />
          </svg>
          <span style={{ letterSpacing: "0.15em", textTransform: "uppercase" }}>
            Relapse
          </span>
        </button>
      )}

      {/* HUD overlay */}
      {isActive && relapseData && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            background: "rgba(13, 19, 33, 0.92)",
            borderTop: "1px solid #1e2a3a",
            padding: "8px 16px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          {/* Top row: date, balance, stats, controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 6 }}>
            {/* Date */}
            <span style={{ color: "#00d4ff", fontWeight: 700, fontSize: 11, minWidth: 120 }}>
              {currentFrame ? formatDate(currentFrame.time) : "—"}
            </span>

            {/* Wallet balance */}
            <span style={{ color: "#c8d6e5", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#6b7b8d" }}>◎</span>
              <span style={{ fontWeight: 600, fontSize: 11 }}>
                {currentFrame ? formatSol(currentFrame.stats.walletBalance) : "0"}
              </span>
              <span style={{ color: "#6b7b8d", fontSize: 9 }}>SOL</span>
            </span>

            <div style={{ flex: 1 }} />

            {/* Stats */}
            <span style={{ color: "#c8d6e5" }}>
              {currentFrame ? formatNumber(currentFrame.stats.counterparties) : "0"}
              <span style={{ color: "#6b7b8d" }}> peers</span>
              {" · "}
              {currentFrame ? formatNumber(currentFrame.stats.txCount) : "0"}
              <span style={{ color: "#6b7b8d" }}> tx</span>
            </span>

            {/* Speed pills */}
            <div style={{ display: "flex", gap: 2 }}>
              {([1, 2, 4] as Speed[]).map((s) => (
                <button
                  key={s}
                  onClick={() => handleSpeedChange(s)}
                  style={{
                    padding: "1px 6px",
                    borderRadius: 3,
                    border: "1px solid",
                    borderColor: speed === s ? "#00d4ff" : "#1e2a3a",
                    background: speed === s ? "rgba(0, 212, 255, 0.12)" : "transparent",
                    color: speed === s ? "#00d4ff" : "#6b7b8d",
                    fontSize: 9,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {s}x
                </button>
              ))}
            </div>

            {/* Pause/play */}
            {(state === "playing" || state === "paused" || state === "done") && (
              <button
                onClick={state === "done" ? () => { seekTo(0); setFrameIndex(0); setState("paused"); } : togglePause}
                style={{
                  padding: "1px 6px",
                  borderRadius: 3,
                  border: "1px solid #1e2a3a",
                  background: "transparent",
                  color: "#c8d6e5",
                  fontSize: 9,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {state === "playing" ? "⏸" : "▶"}
              </button>
            )}

            {/* Close */}
            <button
              onClick={handleClose}
              style={{
                padding: "1px 6px",
                borderRadius: 3,
                border: "1px solid #1e2a3a",
                background: "transparent",
                color: "#6b7b8d",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>

          {/* Timeline scrubber */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min={0}
              max={relapseData.frames.length - 1}
              value={frameIndex}
              onChange={handleSeek}
              style={{
                flex: 1,
                height: 3,
                accentColor: "#00d4ff",
                cursor: "pointer",
              }}
              className="volume-slider"
            />
          </div>
        </div>
      )}
    </>
  );
}
