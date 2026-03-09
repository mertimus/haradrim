import { useEffect, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { TokenHolder } from "@/birdeye-api";
import { getHolderTier, TIER_COLORS } from "@/lib/parse-holders";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function fmtAmount(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(4);
}

function fmtPct(v: number): string {
  if (v >= 0.01) return `${v.toFixed(2)}%`;
  return "<0.01%";
}

type SortKey = "amount" | "pct";
type SortDir = "asc" | "desc";

const TH =
  "font-mono text-[8px] uppercase tracking-wider text-muted-foreground";

function SortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: SortKey;
  sortKey: SortKey | null;
  sortDir: SortDir;
}) {
  const active = sortKey === col;
  return (
    <span className="ml-0.5 inline-flex flex-col leading-none align-middle">
      <span
        className={`text-[6px] leading-[7px] ${active && sortDir === "asc" ? "text-primary" : "text-muted-foreground/30"}`}
      >
        {"\u25B2"}
      </span>
      <span
        className={`text-[6px] leading-[7px] ${active && sortDir === "desc" ? "text-primary" : "text-muted-foreground/30"}`}
      >
        {"\u25BC"}
      </span>
    </span>
  );
}

interface HolderTableProps {
  holders: TokenHolder[];
  loading: boolean;
  onHoverAddress: (address: string | null) => void;
  analysisScope?: Set<string> | null;
  highlightedAddresses?: Set<string> | null;
}

export function HolderTable({
  holders,
  loading,
  onHoverAddress,
  analysisScope = null,
  highlightedAddresses = null,
}: HolderTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAnalyzedOnly, setShowAnalyzedOnly] = useState(false);

  useEffect(() => {
    if (!analysisScope) {
      setShowAnalyzedOnly(false);
    }
  }, [analysisScope]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setSortDir("desc");
  };

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const scoped = showAnalyzedOnly && analysisScope
      ? holders.filter((holder) => analysisScope.has(holder.owner))
      : holders;
    if (!query) return scoped;
    return scoped.filter(
      (holder) =>
        holder.owner.toLowerCase().includes(query)
        || holder.label?.toLowerCase().includes(query),
    );
  }, [analysisScope, holders, searchQuery, showAnalyzedOnly]);

  const rankMap = useMemo(
    () => new Map(holders.map((holder, index) => [holder.owner, index + 1])),
    [holders],
  );

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const direction = sortDir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const aValue = sortKey === "pct" ? a.percentage : a.uiAmount;
      const bValue = sortKey === "pct" ? b.percentage : b.uiAmount;
      return direction * (aValue - bValue);
    });
  }, [filtered, sortDir, sortKey]);

  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-2">
        <div className="space-y-1">
          {Array.from({ length: 20 }).map((_, index) => (
            <Skeleton key={index} className="h-5 w-full bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {holders.length.toLocaleString()} holders
          </span>
          {analysisScope && (
            <>
              <span className="font-mono text-[9px] text-muted-foreground">
                analyzed {analysisScope.size}
              </span>
              <button
                type="button"
                onClick={() => setShowAnalyzedOnly((current) => !current)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider transition-colors ${
                  showAnalyzedOnly
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-primary"
                }`}
              >
                Analyzed only
              </button>
            </>
          )}
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search holder..."
          className="h-7 w-40 rounded border border-border bg-card px-2 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="border-border hover:bg-transparent [&>th]:px-1.5 [&>th]:py-1">
              <TableHead className={`${TH} w-8 text-center`}>Rank</TableHead>
              <TableHead className={TH}>Holder</TableHead>
              <TableHead
                className={`${TH} cursor-pointer select-none text-right hover:text-foreground transition-colors`}
                onClick={() => handleSort("amount")}
              >
                Amount
                <SortIcon col="amount" sortKey={sortKey} sortDir={sortDir} />
              </TableHead>
              <TableHead
                className={`${TH} cursor-pointer select-none text-right hover:text-foreground transition-colors`}
                onClick={() => handleSort("pct")}
              >
                %
                <SortIcon col="pct" sortKey={sortKey} sortDir={sortDir} />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((holder, index) => {
              const tier = getHolderTier(holder.percentage);
              const tierColor = TIER_COLORS[tier];
              const inScope = !analysisScope || analysisScope.has(holder.owner);
              const highlighted = !highlightedAddresses || highlightedAddresses.has(holder.owner);

              return (
                <TableRow
                  key={holder.owner}
                  className="table-row-reveal table-row-hover border-border [&>td]:px-1.5 [&>td]:py-0.5"
                  style={{
                    animationDelay: `${Math.min(index * 20, 400)}ms`,
                    opacity: inScope ? (highlighted ? 1 : 0.55) : 0.4,
                    backgroundColor: highlightedAddresses && highlighted
                      ? "rgba(0, 212, 255, 0.05)"
                      : undefined,
                  }}
                  onMouseEnter={() => onHoverAddress(holder.owner)}
                  onMouseLeave={() => onHoverAddress(null)}
                >
                  <TableCell className="text-center font-mono text-[9px] text-muted-foreground/50 tabular-nums">
                    {rankMap.get(holder.owner) ?? index + 1}
                  </TableCell>
                  <TableCell>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-foreground">
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: tierColor }}
                        />
                        {truncAddr(holder.owner)}
                      </div>
                      {holder.label && (
                        <div className="ml-3 max-w-[160px] truncate font-mono text-[9px] leading-tight text-primary">
                          {holder.label}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[10px] text-foreground tabular-nums">
                    {fmtAmount(holder.uiAmount)}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-[10px] tabular-nums"
                    style={{ color: tierColor }}
                  >
                    {fmtPct(holder.percentage)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
