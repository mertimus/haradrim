import { Skeleton } from "@/components/ui/skeleton";
import type { GraphPreset, WalletInsight } from "@/lib/wallet-explorer";

export type { WalletInsight } from "@/lib/wallet-explorer";

interface WalletInsightsStripProps {
  insights: WalletInsight[];
  loading: boolean;
  selectedAddress: string | null;
  onSelectAddress: (address: string) => void;
  onGraphPresetChange: (preset: GraphPreset) => void;
}

export function WalletInsightsStrip({
  insights,
  loading,
  selectedAddress,
  onSelectAddress,
  onGraphPresetChange,
}: WalletInsightsStripProps) {
  if (loading && insights.length === 0) {
    return (
      <div className="grid grid-cols-4 gap-px bg-border">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="bg-card px-2 py-1">
            <Skeleton className="h-2 w-18 bg-muted" />
            <Skeleton className="mt-1 h-3 w-full bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-px bg-border">
      {insights.map((insight) => {
        const isSelected = insight.address != null && selectedAddress === insight.address;
        const isInteractive = insight.address != null || insight.preset != null;
        const Element = isInteractive ? "button" : "div";
        return (
          <Element
            key={insight.id}
            type={isInteractive ? "button" : undefined}
            className={`flex min-h-[30px] flex-col gap-1 bg-card px-2 py-1 text-left ${
              isInteractive ? "cursor-pointer transition-colors hover:bg-card/80" : ""
            }`}
            style={{
              boxShadow: isSelected ? `inset 0 0 0 1px ${insight.accentColor}55` : undefined,
              borderTop: `2px solid ${insight.accentColor}55`,
            }}
            onClick={isInteractive ? () => {
              if (insight.preset) onGraphPresetChange(insight.preset);
              if (insight.address) onSelectAddress(insight.address);
            } : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[7px] uppercase tracking-[0.18em] text-muted-foreground">
                {insight.title}
              </span>
              {insight.preset && (
                <span
                  className="shrink-0 rounded px-1 py-px font-mono text-[6px] uppercase tracking-[0.14em]"
                  style={{
                    background: `${insight.accentColor}18`,
                    color: insight.accentColor,
                  }}
                >
                  Graph
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-1 overflow-hidden">
              <div
                className="shrink-0 font-mono text-[10px] font-bold leading-none"
                style={{ color: insight.accentColor }}
              >
                {insight.value}
              </div>
              <div className="min-w-0 truncate font-mono text-[8px] leading-none text-muted-foreground">
                {insight.description}
              </div>
            </div>
          </Element>
        );
      })}
    </div>
  );
}
