import { useState } from "react";

interface WalletConnectionsCoachmarkProps {
  comparedCount: number;
  selectedLabel?: string | null;
}

const DISMISS_KEY = "haradrim.walletConnectionsCoachmark.dismissed";

export function WalletConnectionsCoachmark({
  comparedCount,
  selectedLabel,
}: WalletConnectionsCoachmarkProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage failures and dismiss for this session only.
    }
  };

  if (dismissed) return null;

  if (comparedCount > 1) {
    return (
      <div className="absolute bottom-3 left-3 z-20 max-w-[280px] rounded border border-accent/25 bg-card/95 px-3 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.38)]">
        <button
          type="button"
          onClick={handleDismiss}
          className="absolute right-2 top-2 font-mono text-[9px] text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Dismiss wallet connections hint"
        >
          x
        </button>
        <div className="font-mono text-[8px] uppercase tracking-[0.22em] text-accent">
          Mutual Connections Active
        </div>
        <div className="mt-1 font-mono text-[9px] leading-relaxed text-foreground">
          Comparing {comparedCount} wallets. Shared counterparties now show where those wallets overlap.
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-3 left-3 z-20 max-w-[292px] rounded border border-primary/20 bg-card/95 px-3 py-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.38)]">
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute right-2 top-2 font-mono text-[9px] text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Dismiss wallet connections hint"
      >
        x
      </button>
      <div className="font-mono text-[8px] uppercase tracking-[0.22em] text-primary">
        How To Use Wallet Connections
      </div>
      <div className="mt-1.5 space-y-1 font-mono text-[9px] leading-relaxed text-foreground">
        <div>1. Click a node or counterparty row.</div>
        <div>2. Use <span className="text-primary">Add to Compare</span>.</div>
        <div>3. Shared counterparties will appear as mutual connections.</div>
      </div>
      <div className="mt-2 rounded border border-primary/15 bg-primary/5 px-2 py-1 font-mono text-[8px] leading-relaxed text-muted-foreground">
        {selectedLabel
          ? `Selected: ${selectedLabel}. Use Add to Compare in the detail panel on the right.`
          : "Compare a second wallet to reveal who both wallets touch."}
      </div>
    </div>
  );
}
