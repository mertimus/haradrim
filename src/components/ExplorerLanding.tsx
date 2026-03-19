import type { CSSProperties, ReactNode } from "react";

type ExplorerLandingMode = "wallet" | "flows" | "trace";

interface ExplorerLandingProps {
  mode: ExplorerLandingMode;
  action: ReactNode;
  error?: ReactNode;
}

interface LandingCopy {
  eyebrow: string;
  title: string;
  description: string;
  steps: [string, string, string];
  footer: [string, string, string];
  previewLabel: string;
  previewHint: string;
}

const LANDING_COPY: Record<ExplorerLandingMode, LandingCopy> = {
  wallet: {
    eyebrow: "Wallet Operator",
    title: "Map the counterparties around one wallet",
    description:
      "Start with a single address to load its profile, relationship graph, and ranked counterparties. This is the fastest way to understand who the wallet actually interacts with.",
    steps: [
      "Paste a wallet address to load the profile strip, graph, and counterparty table together.",
      "Click any node to inspect balances, labels, and direct relationship detail on the right.",
      "Add nodes or overlay more wallets to compare neighborhoods and shared counterparties.",
    ],
    footer: ["Profile + graph", "Ranked counterparties", "Overlay comparisons"],
    previewLabel: "Preview",
    previewHint: "Two wallet hubs with a shared counterparty highlighted between them.",
  },
  flows: {
    eyebrow: "Flow Lanes",
    title: "Read who sent value and who received it",
    description:
      "Flows collapses the wallet graph into directional lanes so you can read movement by side, frequency, and amount without the visual noise of a full topology view.",
    steps: [
      "Paste a wallet address to split counterparties into inflow and outflow lanes.",
      "Select a lane to inspect transaction-level transfer history in the side panel.",
      "Use the graph and time filters after load to isolate the exact movement you care about.",
    ],
    footer: ["Directional lanes", "Transfer history", "Fast triage view"],
    previewLabel: "Preview",
    previewHint: "Outflow and inflow lanes with example transfer rows and amount chips.",
  },
  trace: {
    eyebrow: "Multi-hop Trace",
    title: "Seed a wallet, then grow the graph hop by hop",
    description:
      "Trace is for following movement outward from a seed entity. Start small, inspect one node at a time, and add only the counterparties that matter to build a clean path.",
    steps: [
      "Paste the wallet you want to investigate and start the trace from that seed node.",
      "Click any node to load its direct inflows and outflows in the inspection panel.",
      "Add selected counterparties back onto the graph to extend the path one hop at a time.",
    ],
    footer: ["Node-by-node expansion", "Inflow / outflow drilldown", "Multi-hop path building"],
    previewLabel: "Preview",
    previewHint: "Inline edge labels show amount + tx count.",
  },
};

const EDGE_STYLE: CSSProperties = {
  stroke: "rgba(94, 166, 255, 0.35)",
  strokeWidth: 2,
  fill: "none",
  strokeLinecap: "round",
};

export function ExplorerLanding({ mode, action, error }: ExplorerLandingProps) {
  const copy = LANDING_COPY[mode];

  return (
    <div className="flex flex-1 overflow-auto px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:items-start lg:gap-x-10 lg:gap-y-8">
        <section className="animate-reveal reveal-delay-1 lg:col-span-2">
          <div className="mx-auto flex w-full justify-center">
            <div className="w-full">
              {action}
            </div>
          </div>
        </section>

        <section className="animate-reveal reveal-delay-2 lg:col-span-2">
          <div className="relative h-px w-full bg-gradient-to-r from-transparent via-primary/30 to-transparent">
            <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/40 bg-background" />
          </div>
        </section>

        <section className="animate-reveal reveal-delay-3 space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.32em] text-primary/80">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
            How It Works
          </div>

          <div className="space-y-2">
            <h2 className="max-w-md font-mono text-xl font-bold uppercase tracking-[0.16em] text-primary text-glow-cyan sm:text-2xl">
              {copy.title}
            </h2>
            <p className="max-w-lg text-sm leading-6 text-foreground/75">
              {copy.description}
            </p>
          </div>

          <div className="grid gap-2.5">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="rounded-xl border border-border/80 bg-card/70 px-4 py-3 backdrop-blur-sm animate-reveal"
                style={{ animationDelay: `${0.12 + index * 0.05}s` }}
              >
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.26em] text-primary/70">
                  Step 0{index + 1}
                </div>
                <p className="text-[13px] leading-6 text-foreground/75">{step}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {copy.footer.map((item) => (
              <div
                key={item}
                className="min-w-0 rounded-xl border border-border/70 bg-background/70 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.18em] leading-5 text-muted-foreground [overflow-wrap:anywhere]"
              >
                {item}
              </div>
            ))}
          </div>

          {error ?? null}
        </section>

        <section className="animate-reveal reveal-delay-4">
          <div className="corner-bracket scanline relative overflow-hidden rounded-[26px] border border-primary/20 bg-card/80 p-4 shadow-[0_0_60px_rgba(0,212,255,0.08)] sm:p-5">
            <div className="corner-bl" />
            <div className="corner-br" />
            <div className="graph-grid-bg absolute inset-0 opacity-55" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(0,212,255,0.16),_transparent_42%),radial-gradient(circle_at_bottom_right,_rgba(0,212,255,0.12),_transparent_36%)]" />

            <div className="relative z-10 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-primary/80">
                    {copy.previewLabel}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {copy.previewHint}
                  </div>
                </div>
                <div className="rounded-full border border-border/70 bg-background/60 px-3 py-1 font-mono text-[8px] uppercase tracking-[0.22em] text-muted-foreground">
                  {mode}
                </div>
              </div>

              {mode === "wallet" && <WalletPreview />}
              {mode === "flows" && <FlowsPreview />}
              {mode === "trace" && <TracePreview />}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function WalletPreview() {
  return (
    <svg className="h-[320px] w-full" viewBox="0 0 720 320" aria-hidden="true">
      <path d="M224 170 C 292 170, 304 146, 360 146" style={EDGE_STYLE} />
      <path d="M496 146 C 548 146, 566 176, 632 176" style={EDGE_STYLE} />

      <rect x={108} y={142} width={116} height={56} rx={6} fill="#0d1321" fillOpacity="0.96" stroke="#35cfff" strokeWidth="2" />
      <text x={124} y={174} fill="#00d4ff" fontFamily="var(--font-mono)" fontSize="11" fontWeight="700">Wallet A</text>
      <text x={124} y={190} fill="#6b7b8d" fontFamily="var(--font-mono)" fontSize="9">Gh5c...uzH3</text>

      <rect x={520} y={148} width={116} height={56} rx={6} fill="#0d1321" fillOpacity="0.95" stroke="#ffb800" strokeWidth="2" />
      <text x={536} y={180} fill="#ffb800" fontFamily="var(--font-mono)" fontSize="11" fontWeight="700">Wallet B</text>
      <text x={536} y={196} fill="#6b7b8d" fontFamily="var(--font-mono)" fontSize="9">9R2k...vN4q</text>

      <rect x={302} y={118} width={194} height={56} rx={6} fill="#0d1321" fillOpacity="0.94" stroke="#314050" strokeWidth="1" />
      <text x={319} y={139} fill="#c8d6e5" fontFamily="var(--font-mono)" fontSize="10" fontWeight="700">Shared counterparty</text>
      <text x={319} y={156} fill="#6b7b8d" fontFamily="var(--font-mono)" fontSize="9">market-maker.sol</text>
      <text x={319} y={170} fill="#9ca8b7" fontFamily="var(--font-mono)" fontSize="9">38 tx overlap</text>
    </svg>
  );
}

function FlowsPreview() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]" aria-hidden="true">
      <div className="space-y-3">
        <FlowLane
          title="Outflow lane"
          tone="rgba(255, 45, 45, 0.24)"
          accent="#ff6b6b"
          rows={[
            ["Exchange desk", "41.2 SOL", "12 tx"],
            ["Router cluster", "9.6 SOL", "4 tx"],
            ["Cold storage", "3.1 SOL", "2 tx"],
          ]}
        />
        <FlowLane
          title="Inflow lane"
          tone="rgba(0, 255, 136, 0.18)"
          accent="#00ff88"
          rows={[
            ["Funding wallet", "27.4 SOL", "8 tx"],
            ["OTC peer", "11.8 SOL", "3 tx"],
            ["Fee rebate", "0.8 SOL", "6 tx"],
          ]}
        />
      </div>

      <div className="rounded-2xl border border-border/80 bg-background/70 p-3">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground">
          Selected lane
        </div>
        <div className="mt-3 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
            Exchange desk
          </div>
          <div className="mt-1 font-mono text-[9px] text-muted-foreground">
            12 transfers · 41.2 SOL net outflow
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {[
            "2026-03-08 · 12.0 SOL · swap funding",
            "2026-03-06 · 8.2 SOL · exchange withdrawal",
            "2026-03-01 · 4.1 SOL · route rebalance",
          ].map((row) => (
            <div
              key={row}
              className="rounded-lg border border-border/70 bg-card/70 px-3 py-2 font-mono text-[9px] text-foreground/75"
            >
              {row}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TracePreview() {
  return (
    <svg className="h-[320px] w-full" viewBox="0 0 720 320" aria-hidden="true">
      <defs>
        <filter id="trace-preview-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="0" stdDeviation="14" floodColor="#00d4ff" floodOpacity="0.4" />
          <feDropShadow dx="0" dy="0" stdDeviation="28" floodColor="#00d4ff" floodOpacity="0.14" />
        </filter>
      </defs>

      <path d="M224 257 C 252 257, 264 214, 286 182" style={EDGE_STYLE} />
      <path d="M496 182 C 546 182, 548 126, 576 96" style={EDGE_STYLE} />

      <SvgTraceNode
        x={54}
        y={232}
        width={170}
        height={50}
        title="7mYt...RDzD"
        stats="226 tx • 226 moves"
      />
      <SvgTraceNode
        x={286}
        y={146}
        width={210}
        height={72}
        title="devrugged.sol"
        address="8cRr...cs2Y"
        stats="289 tx • 289 moves"
        isSeed
      />
      <SvgTraceNode
        x={576}
        y={72}
        width={118}
        height={48}
        title="H3vj...Cm1N"
        stats="63 tx • 63 moves"
      />

      <SvgTraceEdgeChip x={258} y={204} width={170} label="11.4k BERN +2 • 226 tx" />
      <SvgTraceEdgeChip x={542} y={128} width={126} label="1.6k SOL • 63 tx" />
    </svg>
  );
}

function FlowLane({
  title,
  tone,
  accent,
  rows,
}: {
  title: string;
  tone: string;
  accent: string;
  rows: Array<[string, string, string]>;
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-background/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="font-mono text-[8px] uppercase tracking-[0.24em]" style={{ color: accent }}>
          {title}
        </div>
        <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted-foreground">
          Preview rows
        </div>
      </div>
      <div className="space-y-2">
        {rows.map(([label, amount, tx]) => (
          <div
            key={label}
            className="rounded-xl border px-3 py-2"
            style={{ borderColor: tone, background: `linear-gradient(90deg, ${tone}, rgba(10, 14, 23, 0.2))` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] font-bold text-foreground/80">{label}</span>
              <span className="font-mono text-[9px]" style={{ color: accent }}>
                {amount}
              </span>
            </div>
            <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.18em] text-muted-foreground">
              {tx}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SvgTraceNode({
  x,
  y,
  width,
  height,
  title,
  address,
  stats,
  isSeed = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  address?: string;
  stats: string;
  isSeed?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {isSeed ? (
        <g filter="url(#trace-preview-glow)">
          <rect width={width} height={height} rx={6} fill="#0d1321" fillOpacity="0.96" stroke="#35cfff" strokeWidth="2" />
        </g>
      ) : (
        <rect width={width} height={height} rx={4} fill="#0d1321" fillOpacity="0.95" stroke="#4a5a6a" strokeWidth="1" />
      )}
      <circle cx={0} cy={height / 2} r={4} fill="#5c6b7a" />
      <circle cx={width} cy={height / 2} r={4} fill="#5c6b7a" />
      <text x={16} y={22} fill={isSeed ? "#00d4ff" : "#c8d6e5"} fontFamily="var(--font-mono)" fontSize="10" fontWeight="700">
        {title}
      </text>
      {address ? (
        <text x={16} y={40} fill="#6b7b8d" fontFamily="var(--font-mono)" fontSize="9">
          {address}
        </text>
      ) : null}
      <text x={16} y={address ? 60 : 38} fill="#c8d6e5" fillOpacity="0.72" fontFamily="var(--font-mono)" fontSize="9">
        {stats}
      </text>
    </g>
  );
}

function SvgTraceEdgeChip({ x, y, width, label }: { x: number; y: number; width: number; label: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-width / 2} y={-12} width={width} height={24} rx={4} fill="#0d1321" fillOpacity="0.92" stroke="#1e2a3a" />
      <text x={0} y={4} fill="#c8d6e5" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle">
        {label}
      </text>
    </g>
  );
}
