import type { CSSProperties, ReactNode } from "react";

type ExplorerLandingMode = "trace";

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
          <div className="corner-bracket scanline relative overflow-hidden rounded-[26px] border border-primary/20 bg-card/80 p-4 shadow-[0_0_40px_rgba(0,212,255,0.04)] sm:p-5">
            <div className="corner-bl" />
            <div className="corner-br" />
            <div className="graph-grid-bg absolute inset-0 opacity-55" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(0,212,255,0.06),_transparent_42%),radial-gradient(circle_at_bottom_right,_rgba(0,212,255,0.04),_transparent_36%)]" />

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

              {mode === "trace" && <TracePreview />}
            </div>
          </div>
        </section>
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
