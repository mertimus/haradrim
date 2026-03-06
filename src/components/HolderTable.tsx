import { useState, useMemo, useEffect, useCallback, useRef } from "react";
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
import type { BundleGroup } from "@/lib/bundle-scan";

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
  if (v >= 1) return `${v.toFixed(2)}%`;
  if (v >= 0.01) return `${v.toFixed(2)}%`;
  return "<0.01%";
}

type SortKey = "pct" | "amount" | "slot";
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
    <span className="inline-flex flex-col ml-0.5 leading-none -my-0.5 align-middle">
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

interface ContextMenuState {
  address: string;
  label?: string;
  screenX: number;
  screenY: number;
}

// Bundle color palette — distinct colors for each bundle group
const BUNDLE_COLORS = [
  "#a855f7", // purple
  "#f97316", // orange
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#eab308", // yellow
  "#14b8a6", // teal
  "#f43f5e", // rose
];

interface HolderTableProps {
  holders: TokenHolder[];
  loading: boolean;
  onHoverAddress: (address: string | null) => void;
  firstBuySlots?: Map<string, number>;
  bundleGroups?: BundleGroup[];
}

export function HolderTable({
  holders,
  loading,
  onHoverAddress,
  firstBuySlots,
  bundleGroups,
}: HolderTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === "desc") setSortDir("asc");
      else {
        setSortKey(null);
        setSortDir("desc");
      }
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const filtered = useMemo(() => {
    if (!searchQuery) return holders;
    const q = searchQuery.toLowerCase();
    return holders.filter(
      (h) =>
        h.owner.toLowerCase().includes(q) ||
        (h.label && h.label.toLowerCase().includes(q)),
    );
  }, [holders, searchQuery]);

  // Map address → color for bundle members
  const bundleColorMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!bundleGroups) return map;
    for (let i = 0; i < bundleGroups.length; i++) {
      const color = BUNDLE_COLORS[i % BUNDLE_COLORS.length];
      for (const addr of bundleGroups[i].members) {
        map.set(addr, color);
      }
    }
    return map;
  }, [bundleGroups]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const mul = sortDir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "slot") {
        const va = firstBuySlots?.get(a.owner) ?? Infinity;
        const vb = firstBuySlots?.get(b.owner) ?? Infinity;
        return mul * (va - vb);
      }
      const va = sortKey === "pct" ? a.percentage : a.uiAmount;
      const vb = sortKey === "pct" ? b.percentage : b.uiAmount;
      return mul * (va - vb);
    });
  }, [filtered, sortKey, sortDir, firstBuySlots]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, h: TokenHolder) => {
      e.stopPropagation();
      setContextMenu({
        address: h.owner,
        label: h.label,
        screenX: e.clientX,
        screenY: e.clientY,
      });
    },
    [],
  );

  // Dismiss on Escape, click outside, scroll
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const timer = setTimeout(() => {
      window.addEventListener("click", dismiss);
    }, 0);
    window.addEventListener("keydown", onKey);
    const scrollEl = scrollRef.current;
    scrollEl?.addEventListener("scroll", dismiss);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", dismiss);
      scrollEl?.removeEventListener("scroll", dismiss);
    };
  }, [contextMenu]);

  const menuStyle = contextMenu
    ? (() => {
        const menuW = 180;
        const menuH = 80;
        const x = Math.min(
          contextMenu.screenX,
          window.innerWidth - menuW - 8,
        );
        const y = Math.min(
          contextMenu.screenY,
          window.innerHeight - menuH - 8,
        );
        return { left: x, top: y };
      })()
    : null;

  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-2">
        <div className="space-y-1">
          {Array.from({ length: 20 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto">
      {/* Summary strip */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border flex-none font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
        <span>{holders.length} Holders</span>
        <span className="text-muted-foreground/30">|</span>
        <span>
          Top-10:{" "}
          <span className="text-foreground">
            {holders
              .slice(0, 10)
              .reduce((s, h) => s + h.percentage, 0)
              .toFixed(1)}
            %
          </span>
        </span>
        <span className="text-muted-foreground/30">|</span>
        <span>
          Top-20:{" "}
          <span className="text-foreground">
            {holders
              .slice(0, 20)
              .reduce((s, h) => s + h.percentage, 0)
              .toFixed(1)}
            %
          </span>
        </span>
      </div>
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow className="border-border hover:bg-transparent [&>th]:py-0.5 [&>th]:px-1.5">
            <TableHead className={`${TH} w-6 text-center`}>#</TableHead>
            <TableHead
              className={`${TH} cursor-pointer select-none hover:text-foreground transition-colors`}
              onClick={() => {
                setShowSearch((prev) => {
                  if (prev) setSearchQuery("");
                  return !prev;
                });
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
            >
              {showSearch ? (
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowSearch(false);
                      setSearchQuery("");
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Search..."
                  className="w-full bg-transparent border-b border-primary/30 text-[9px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 py-0"
                  autoFocus
                />
              ) : (
                <>
                  Holder
                  <span className="ml-1 text-muted-foreground/30">
                    &#x1F50D;
                  </span>
                </>
              )}
            </TableHead>
            <TableHead
              className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`}
              onClick={() => handleSort("amount")}
            >
              Amount
              <SortIcon col="amount" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            <TableHead
              className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`}
              onClick={() => handleSort("pct")}
            >
              %
              <SortIcon col="pct" sortKey={sortKey} sortDir={sortDir} />
            </TableHead>
            {firstBuySlots && (
              <TableHead
                className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`}
                onClick={() => handleSort("slot")}
              >
                First Buy
                <SortIcon col="slot" sortKey={sortKey} sortDir={sortDir} />
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((h, i) => {
            const tier = getHolderTier(h.percentage);
            const tierColor = TIER_COLORS[tier];
            return (
              <TableRow
                key={h.owner}
                className="table-row-reveal table-row-hover cursor-pointer border-border [&>td]:py-0.5 [&>td]:px-1.5"
                style={{ animationDelay: `${Math.min(i * 20, 400)}ms` }}
                onClick={(e) => handleContextMenu(e, h)}
                onMouseEnter={() => onHoverAddress(h.owner)}
                onMouseLeave={() => onHoverAddress(null)}
              >
                <TableCell className="text-center font-mono text-[9px] text-muted-foreground/50 tabular-nums">
                  {i + 1}
                </TableCell>
                <TableCell>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-foreground">
                      <span
                        className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tierColor }}
                      />
                      {truncAddr(h.owner)}
                    </div>
                    {h.label && (
                      <div className="font-mono text-[9px] text-primary truncate max-w-[160px] leading-tight ml-3">
                        {h.label}
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-[10px] text-foreground tabular-nums align-top">
                  {fmtAmount(h.uiAmount)}
                </TableCell>
                <TableCell
                  className="text-right font-mono text-[10px] tabular-nums align-top"
                  style={{ color: tierColor }}
                >
                  {fmtPct(h.percentage)}
                </TableCell>
                {firstBuySlots && (
                  <TableCell
                    className="text-right font-mono text-[10px] tabular-nums align-top"
                    style={{
                      color: bundleColorMap.get(h.owner) ?? "#6b7b8d",
                      fontWeight: bundleColorMap.has(h.owner) ? 600 : 400,
                    }}
                  >
                    {firstBuySlots.has(h.owner)
                      ? firstBuySlots.get(h.owner)!.toLocaleString()
                      : "\u2014"}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Context menu */}
      {contextMenu && menuStyle && (
        <div
          style={{
            position: "fixed",
            left: menuStyle.left,
            top: menuStyle.top,
            zIndex: 50,
            background: "rgba(13, 19, 33, 0.95)",
            border: "1px solid #1e2a3a",
            borderRadius: 6,
            padding: "8px 0",
            fontFamily: "var(--font-mono)",
            minWidth: 170,
            boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: "2px 12px 6px" }}>
            <div
              style={{
                fontSize: 10,
                color: "#c8d6e5",
                letterSpacing: "0.03em",
              }}
            >
              {truncAddr(contextMenu.address)}
            </div>
            {contextMenu.label && (
              <div
                style={{
                  fontSize: 11,
                  color: "#00d4ff",
                  fontWeight: 600,
                  marginTop: 1,
                }}
              >
                {contextMenu.label}
              </div>
            )}
          </div>
          <div
            style={{
              height: 1,
              background: "#1e2a3a",
              margin: "0 8px 4px",
            }}
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.address);
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "#c8d6e5",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "rgba(0, 212, 255, 0.08)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            <span style={{ fontSize: 13 }}>&#x2398;</span>
            Copy Address
          </button>
          <button
            onClick={() => {
              window.open(
                `https://solscan.io/account/${contextMenu.address}`,
                "_blank",
              );
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "#c8d6e5",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "rgba(0, 212, 255, 0.08)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            <span style={{ fontSize: 13 }}>&rarr;</span>
            View on Solscan
          </button>
        </div>
      )}
    </div>
  );
}
