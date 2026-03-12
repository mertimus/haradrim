import { Suspense, lazy, useEffect, useState } from "react";

function getWalletAddressFromUrl(): string {
  const pathMatch = window.location.pathname.match(/^\/(?:wallet|flows)\/([A-Za-z0-9]+)$/);
  if (pathMatch) return pathMatch[1];
  const params = new URLSearchParams(window.location.search);
  return params.get("address") ?? "";
}

function getBalanceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/balances\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

function getTraceAddressFromUrl(): string {
  const match = window.location.pathname.match(/^\/trace\/([A-Za-z0-9]+)$/);
  return match?.[1] ?? "";
}

export type AppMode = "wallet" | "flows" | "programs" | "trace" | "balances" | "stablecoins";

function setModeInUrl(mode: AppMode, address = ""): void {
  if (mode === "wallet") {
    window.history.pushState({}, "", address ? `/wallet/${address}` : "/");
    return;
  }
  if (mode === "flows") {
    window.history.pushState({}, "", address ? `/flows/${address}` : "/flows");
    return;
  }
  if (mode === "trace") {
    window.history.pushState({}, "", address ? `/trace/${address}` : "/trace");
    return;
  }
  if (mode === "balances") {
    window.history.pushState({}, "", address ? `/balances/${address}` : "/balances");
    return;
  }
  if (mode === "stablecoins") {
    window.history.pushState({}, "", "/stablecoins");
    return;
  }
  window.history.pushState({}, "", `/${mode}`);
}

function isDisabledTokenPath(pathname = window.location.pathname): boolean {
  return pathname === "/tokens" || pathname.startsWith("/token/");
}

function normalizeDisabledTokenRoute(): boolean {
  if (!isDisabledTokenPath()) return false;
  window.history.replaceState({}, "", "/");
  return true;
}

function getModeFromUrl(): AppMode {
  if (window.location.pathname.startsWith("/flows")) return "flows";
  if (window.location.pathname.startsWith("/trace")) return "trace";
  if (window.location.pathname.startsWith("/balances")) return "balances";
  if (window.location.pathname.startsWith("/stablecoins")) return "stablecoins";
  return "wallet";
}

function getCurrentRouteAddress(): string {
  const mode = getModeFromUrl();
  if (mode === "balances") return getBalanceAddressFromUrl();
  if (mode === "trace") return getTraceAddressFromUrl();
  return getWalletAddressFromUrl();
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

const WalletWorkspace = lazy(async () => ({
  default: (await import("@/components/WalletWorkspace")).WalletWorkspace,
}));
const BalanceExplorer = lazy(async () => ({
  default: (await import("@/components/BalanceExplorer")).BalanceExplorer,
}));
const TraceExplorer = lazy(async () => ({
  default: (await import("@/components/TraceExplorer")).TraceExplorer,
}));
const StablecoinDashboard = lazy(async () => ({
  default: (await import("@/components/StablecoinDashboard")).StablecoinDashboard,
}));

export default function App() {
  const [mode, setMode] = useState<AppMode>(getModeFromUrl);

  useEffect(() => {
    normalizeDisabledTokenRoute();
  }, []);

  useEffect(() => {
    function onPop() {
      normalizeDisabledTokenRoute();
      setMode(getModeFromUrl());
    }

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex-none border-b border-border bg-card/80 px-3 py-1">
        <div className="flex items-center gap-3">
          <button
            className="flex cursor-pointer items-center gap-1.5"
            onClick={() => {
              setMode("wallet");
              setModeInUrl("wallet");
            }}
          >
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            <h1 className="font-mono text-xs font-bold tracking-[0.25em] text-primary text-glow-cyan">
              HARADRIM
            </h1>
          </button>
          <div className="h-3 w-px bg-border" />
          <nav className="flex gap-1">
            {(["wallet", "flows", "balances", "trace", "stablecoins"] as const).map((nextMode) => (
              <button
                key={nextMode}
                onClick={() => {
                  setMode(nextMode);
                  setModeInUrl(nextMode, getCurrentRouteAddress());
                }}
                className="cursor-pointer rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition-colors"
                style={{
                  color: mode === nextMode ? "#00d4ff" : "#6b7b8d",
                  background: mode === nextMode ? "rgba(0, 212, 255, 0.08)" : "transparent",
                }}
              >
                {nextMode === "wallet" ? "shared connections" : nextMode}
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          {mode === "balances" && (
            <div className="w-full max-w-md text-right">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary/80">
                All Assets
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                GTFA balance-over-time for SOL and historical token holdings
              </div>
            </div>
          )}
          {mode === "stablecoins" && (
            <div className="w-full max-w-md text-right">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary/80">
                Dollar Index
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                Supply, concentration, and holder analysis for USDC + USDT on Solana
              </div>
            </div>
          )}
        </div>
      </header>

      <Suspense fallback={<RouteSkeleton />}>
        {(mode === "wallet" || mode === "flows") && (
          <WalletWorkspace mode={mode} />
        )}

        {mode === "programs" && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Program Explorer
              </span>
              <span className="font-mono text-[9px] text-muted-foreground/50">
                Coming soon
              </span>
            </div>
          </div>
        )}

        {mode === "trace" && (
          <TraceExplorer
            initialAddress={getTraceAddressFromUrl()}
            onNavigateToWallet={(address) => {
              setMode("wallet");
              setModeInUrl("wallet", address);
            }}
          />
        )}

        {mode === "balances" && (
          <>
            <BalanceExplorer initialAddress={getBalanceAddressFromUrl()} />
            <footer className="flex-none border-t border-border px-3 py-0.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
                  Asset Balance History
                </span>
                <span className="font-mono text-[8px] uppercase tracking-widest text-muted-foreground" />
                <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                  Helius RPC
                </span>
              </div>
            </footer>
          </>
        )}

        {mode === "stablecoins" && <StablecoinDashboard />}
      </Suspense>
    </div>
  );
}
