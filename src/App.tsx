import { Suspense, lazy, useEffect, useMemo, useState } from "react";

function getTraceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/trace\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

function getCounterpartyAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/(?:counterparties|wallet|flows)\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

type AppMode = "trace" | "counterparties";

function getModeFromUrl(): AppMode {
  if (
    window.location.pathname.startsWith("/counterparties")
    || window.location.pathname.startsWith("/wallet")
    || window.location.pathname.startsWith("/flows")
  ) {
    return "counterparties";
  }
  return "trace";
}

function setModeInUrl(mode: AppMode, address = ""): void {
  if (mode === "counterparties") {
    window.history.pushState({}, "", address ? `/counterparties/${address}` : "/counterparties");
    return;
  }
  window.history.pushState({}, "", address ? `/trace/${address}` : "/trace");
}

function RouteSkeleton() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        Loading
      </div>
    </div>
  );
}

const TraceExplorer = lazy(async () => ({
  default: (await import("@/components/TraceExplorer")).TraceExplorer,
}));

const CounterpartyExplorer = lazy(async () => ({
  default: (await import("@/components/CounterpartyExplorer")).CounterpartyExplorer,
}));

export default function App() {
  const [mode, setMode] = useState<AppMode>(getModeFromUrl);
  const [traceAddress, setTraceAddress] = useState(getTraceAddressFromUrl);
  const [counterpartyAddress, setCounterpartyAddress] = useState(getCounterpartyAddressFromUrl);

  useEffect(() => {
    const handlePopState = () => {
      setMode(getModeFromUrl());
      setTraceAddress(getTraceAddressFromUrl());
      setCounterpartyAddress(getCounterpartyAddressFromUrl());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const activeAddress = useMemo(
    () => (mode === "trace" ? traceAddress : counterpartyAddress),
    [counterpartyAddress, mode, traceAddress],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="flex flex-1 items-center justify-center p-8 text-center md:hidden">
        <div>
          <div className="mx-auto mb-3 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          <h1 className="mb-4 font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">HARADRIM</h1>
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            Not available on mobile yet.<br />Please view on desktop.
          </p>
        </div>
      </div>

      <header className="hidden md:flex flex-none border-b border-border bg-card/80 px-3 py-1">
        <div className="flex w-full items-center gap-4">
          <button
            className="flex cursor-pointer items-center gap-1.5"
            onClick={() => {
              setMode("trace");
              setModeInUrl("trace", traceAddress);
            }}
          >
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">
              HARADRIM
            </h1>
          </button>

          <div className="h-3 w-px bg-border" />

          <nav className="flex gap-1">
            {([
              ["counterparties", "Counterparties"],
              ["trace", "Trace"],
            ] as const).map(([nextMode, label]) => (
              <button
                key={nextMode}
                onClick={() => {
                  const address = nextMode === "trace" ? traceAddress : counterpartyAddress;
                  setMode(nextMode);
                  setModeInUrl(nextMode, address);
                }}
                className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors"
                style={{
                  color: mode === nextMode ? "#00d4ff" : "#6b7b8d",
                  background: mode === nextMode ? "rgba(0, 212, 255, 0.08)" : "transparent",
                }}
              >
                {label}
              </button>
            ))}
          </nav>

          <span className="ml-auto text-right font-mono text-[9px] text-muted-foreground/40">
            Computed at runtime via{" "}
            <a
              href="https://www.helius.dev/docs/rpc/gettransactionsforaddress"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/40 underline underline-offset-2 transition-colors hover:text-primary/70"
            >
              Helius APIs
            </a>
            {" "}— no indexers
          </span>
        </div>
      </header>

      <div className="hidden md:flex flex-1 flex-col overflow-hidden">
        <Suspense fallback={<RouteSkeleton />}>
          {mode === "trace" ? (
            <TraceExplorer
              initialAddress={traceAddress}
              onRouteAddressChange={setTraceAddress}
            />
          ) : (
            <CounterpartyExplorer
              initialAddress={counterpartyAddress}
              onRouteAddressChange={setCounterpartyAddress}
            />
          )}
        </Suspense>
      </div>

      <div className="sr-only">{activeAddress}</div>
    </div>
  );
}
