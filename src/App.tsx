import { Suspense, lazy, useEffect, useState } from "react";

function getTraceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/trace\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
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

export default function App() {
  const [traceAddress, setTraceAddress] = useState(getTraceAddressFromUrl);

  useEffect(() => {
    const handlePopState = () => {
      setTraceAddress(getTraceAddressFromUrl());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="flex flex-1 items-center justify-center p-8 text-center md:hidden">
        <div>
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary mx-auto mb-3" />
          <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan mb-4">HARADRIM</h1>
          <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
            Not available on mobile yet.<br />Please view on desktop.
          </p>
        </div>
      </div>
      <header className="hidden md:flex flex-none border-b border-border bg-card/80 px-3 py-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">
              HARADRIM
            </h1>
          </div>
          <span className="font-mono text-[9px] text-muted-foreground/40">
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
          <TraceExplorer
            initialAddress={traceAddress}
            onRouteAddressChange={setTraceAddress}
          />
        </Suspense>
      </div>
    </div>
  );
}
