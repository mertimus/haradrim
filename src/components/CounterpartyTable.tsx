import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CounterpartyFlow, GraphFlowFilter } from "@/lib/parse-transactions";
import { sortCounterparties } from "@/lib/counterparty-sorting";

export interface CounterpartyDisplay extends CounterpartyFlow {
  walletColors?: string[];
}

export interface TimeRange {
  start: number | null;
  end: number | null;
}

type TimePreset = "all" | "7d" | "30d" | "90d" | "1y" | "custom";
export type CounterpartySortKey = "tx" | "vol" | "net" | "last";
export type CounterpartySortDir = "asc" | "desc";

interface CounterpartyTableProps {
  counterparties: CounterpartyDisplay[];
  loading: boolean;
  onNavigate: (address: string) => void;
  onHoverAddress: (address: string | null) => void;
  selectedAddress: string | null;
  onSelectAddress: (address: string) => void;
  graphAddresses: Set<string>;
  onAddNode: (address: string) => void;
  onRemoveNode: (address: string) => void;
  onAddOverlay: (address: string) => void;
  onTimeRangeChange: (range: TimeRange) => void;
  graphFlowFilter: GraphFlowFilter;
  onGraphFlowFilterChange: (filter: GraphFlowFilter) => void;
  sortKey: CounterpartySortKey | null;
  sortDir: CounterpartySortDir;
  onSortChange: (sortKey: CounterpartySortKey | null, sortDir: CounterpartySortDir) => void;
}

interface TableContextMenuState {
  address: string;
  label?: string;
  screenX: number;
  screenY: number;
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 3)}...${addr.slice(-3)}`;
}

function fmtSol(sol: number): string {
  if (Math.abs(sol) < 0.001) return "<.001";
  if (Math.abs(sol) >= 1000)
    return sol.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(!sameYear && { year: "2-digit" }),
  });
}

const TH =
  "font-mono text-[8px] uppercase tracking-wider text-muted-foreground";

function SortIcon({
  col,
  sortKey,
  sortDir,
}: {
  col: CounterpartySortKey;
  sortKey: CounterpartySortKey | null;
  sortDir: CounterpartySortDir;
}) {
  const active = sortKey === col;
  return (
    <span className="inline-flex flex-col ml-0.5 leading-none -my-0.5 align-middle">
      <span className={`text-[6px] leading-[7px] ${active && sortDir === "asc" ? "text-primary" : "text-muted-foreground/30"}`}>{"\u25B2"}</span>
      <span className={`text-[6px] leading-[7px] ${active && sortDir === "desc" ? "text-primary" : "text-muted-foreground/30"}`}>{"\u25BC"}</span>
    </span>
  );
}

export function CounterpartyTable({
  counterparties,
  loading,
  onNavigate,
  onHoverAddress,
  selectedAddress,
  onSelectAddress,
  graphAddresses,
  onAddNode,
  onRemoveNode,
  onAddOverlay,
  onTimeRangeChange,
  graphFlowFilter,
  onGraphFlowFilterChange,
  sortKey,
  sortDir,
  onSortChange,
}: CounterpartyTableProps) {
  const [contextMenu, setContextMenu] = useState<TableContextMenuState | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Time range filter state
  const [activePreset, setActivePreset] = useState<TimePreset>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const handlePresetClick = useCallback((preset: TimePreset) => {
    setActivePreset(preset);
    if (preset === "custom") return;
    setCustomStart("");
    setCustomEnd("");
    if (preset === "all") {
      onTimeRangeChange({ start: null, end: null });
    } else {
      const now = Math.floor(Date.now() / 1000);
      const days = preset === "7d" ? 7 : preset === "30d" ? 30 : preset === "90d" ? 90 : 365;
      onTimeRangeChange({ start: now - days * 86400, end: null });
    }
  }, [onTimeRangeChange]);

  const handleCustomDateChange = useCallback((start: string, end: string) => {
    const startTs = start ? Math.floor(new Date(start + "T00:00:00").getTime() / 1000) : null;
    const endTs = end ? Math.floor(new Date(end + "T23:59:59").getTime() / 1000) : null;
    if (startTs != null || endTs != null) {
      onTimeRangeChange({ start: startTs, end: endTs });
    }
  }, [onTimeRangeChange]);

  const handleSort = (key: CounterpartySortKey) => {
    if (sortKey === key) {
      if (sortDir === "desc") onSortChange(key, "asc");
      else onSortChange(null, "desc");
    } else {
      onSortChange(key, "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = counterparties;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((cp) =>
        cp.address.toLowerCase().includes(q) ||
        (cp.label && cp.label.toLowerCase().includes(q)) ||
        (cp.tokenName && cp.tokenName.toLowerCase().includes(q)) ||
        (cp.tokenSymbol && cp.tokenSymbol.toLowerCase().includes(q))
      );
    }
    return result;
  }, [counterparties, searchQuery]);

  const sorted = useMemo(
    () => sortCounterparties(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  const graphFlowCounts = useMemo(() => ({
    all: counterparties.length,
    inflow: counterparties.filter((cp) => cp.solReceived > 0).length,
    outflow: counterparties.filter((cp) => cp.solSent > 0).length,
  }), [counterparties]);

  const handleContextMenu = useCallback((e: React.MouseEvent, cp: CounterpartyDisplay) => {
    e.stopPropagation();
    setContextMenu({
      address: cp.address,
      label: cp.label,
      screenX: e.clientX,
      screenY: e.clientY,
    });
  }, []);

  // Dismiss on Escape, click outside, scroll
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    // Delay adding click listener so the opening click doesn't immediately dismiss
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
        const menuW = 190;
        const menuH = 130;
        const x = Math.min(contextMenu.screenX, window.innerWidth - menuW - 8);
        const y = Math.min(contextMenu.screenY, window.innerHeight - menuH - 8);
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

  const graphFlowPills: { key: GraphFlowFilter; label: string; count: number; color: string }[] = [
    { key: "all", label: "All", count: graphFlowCounts.all, color: "#c8d6e5" },
    { key: "inflow", label: "Inflows", count: graphFlowCounts.inflow, color: "#00ff88" },
    { key: "outflow", label: "Outflows", count: graphFlowCounts.outflow, color: "#ff2d2d" },
  ];

  return (
    <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 px-2 py-0.5 border-b border-border flex-none overflow-x-auto whitespace-nowrap">
        <div className="flex items-center gap-1 shrink-0">
          {graphFlowPills.map((pill) => (
            <button
              key={pill.key}
              onClick={() => onGraphFlowFilterChange(pill.key)}
              className="font-mono text-[8px] uppercase tracking-wider px-1 py-0.5 rounded transition-colors cursor-pointer"
              style={{
                background: graphFlowFilter === pill.key ? `${pill.color}20` : "transparent",
                color: graphFlowFilter === pill.key ? pill.color : "#6b7280",
                border: `1px solid ${graphFlowFilter === pill.key ? `${pill.color}40` : "transparent"}`,
              }}
            >
              {pill.label}
              <span className="ml-1 opacity-60">{pill.count}</span>
            </button>
          ))}
        </div>
        <div className="h-4 w-px bg-border/80 shrink-0" />
        <div className="flex items-center gap-1 shrink-0">
          {(["all", "7d", "30d", "1y", "custom"] as TimePreset[]).map(p => (
            <button
              key={p}
              onClick={() => handlePresetClick(p)}
              className="font-mono text-[8px] uppercase tracking-wider px-1 py-0.5 rounded transition-colors cursor-pointer"
              style={{
                background: activePreset === p ? "rgba(0, 212, 255, 0.12)" : "transparent",
                color: activePreset === p ? "#00d4ff" : "#6b7280",
                border: `1px solid ${activePreset === p ? "rgba(0, 212, 255, 0.25)" : "transparent"}`,
              }}
            >
              {p === "all" ? "All" : p === "custom" ? "Custom" : p.toUpperCase()}
            </button>
          ))}
          {activePreset === "custom" && (
            <div className="flex items-center gap-1 ml-1">
              <input
                type="date"
                value={customStart}
                onChange={e => {
                  setCustomStart(e.target.value);
                  handleCustomDateChange(e.target.value, customEnd);
                }}
                className="font-mono text-[8px] bg-transparent border border-border rounded px-1 py-0.5 text-foreground outline-none focus:border-primary/50"
                style={{ colorScheme: "dark" }}
              />
              <span className="text-muted-foreground/50 text-[8px]">&ndash;</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => {
                  setCustomEnd(e.target.value);
                  handleCustomDateChange(customStart, e.target.value);
                }}
                className="font-mono text-[8px] bg-transparent border border-border rounded px-1 py-0.5 text-foreground outline-none focus:border-primary/50"
                style={{ colorScheme: "dark" }}
              />
            </div>
          )}
        </div>
      </div>
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow className="border-border hover:bg-transparent [&>th]:py-0.5 [&>th]:px-1.5">
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
                    if (e.key === "Escape") { setShowSearch(false); setSearchQuery(""); }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Search..."
                  className="w-full bg-transparent border-b border-primary/30 text-[9px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 py-0"
                  autoFocus
                />
              ) : (
                <>Counterparty<span className="ml-1 text-muted-foreground/30">&#x1F50D;</span></>
              )}
            </TableHead>
            <TableHead className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`} onClick={() => handleSort("tx")}>Tx<SortIcon col="tx" sortKey={sortKey} sortDir={sortDir} /></TableHead>
            <TableHead className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`} onClick={() => handleSort("vol")} title="SOL volume">Vol SOL<SortIcon col="vol" sortKey={sortKey} sortDir={sortDir} /></TableHead>
            <TableHead className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`} onClick={() => handleSort("net")} title="Net SOL flow">Net SOL<SortIcon col="net" sortKey={sortKey} sortDir={sortDir} /></TableHead>
            <TableHead className={`${TH} text-right cursor-pointer select-none hover:text-foreground transition-colors`} onClick={() => handleSort("last")}>Last<SortIcon col="last" sortKey={sortKey} sortDir={sortDir} /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((cp, i) => (
            <TableRow
              key={cp.address}
              className={`table-row-reveal table-row-hover cursor-pointer border-border [&>td]:py-0.5 [&>td]:px-1.5 ${
                selectedAddress === cp.address ? "table-row-selected" : ""
              }`}
              style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
              onClick={() => {
                onSelectAddress(cp.address);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                handleContextMenu(e, cp);
              }}
              onMouseEnter={() => onHoverAddress(cp.address)}
              onMouseLeave={() => onHoverAddress(null)}
            >
              <TableCell>
                <div className="min-w-0">
                  <div className="flex items-center gap-1 font-mono text-[10px] text-foreground">
                    {cp.walletColors && cp.walletColors.length > 0 && (
                      <span className="flex gap-0.5 flex-none">
                        {cp.walletColors.map((c, ci) => (
                          <span
                            key={ci}
                            className="h-1.5 w-1.5 rounded-full inline-block"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </span>
                    )}
                    {truncAddr(cp.address)}
                    {cp.accountType && cp.accountType !== "wallet" && (
                      <span
                        className="ml-1 rounded px-1 py-px text-[7px] uppercase leading-tight"
                        style={{
                          background:
                            cp.accountType === "token" ? "rgba(255, 184, 0, 0.15)" :
                            cp.accountType === "program" ? "rgba(168, 85, 247, 0.15)" :
                            "rgba(255, 255, 255, 0.07)",
                          color:
                            cp.accountType === "token" ? "#ffb800" :
                            cp.accountType === "program" ? "#a855f7" :
                            "#6b7280",
                        }}
                      >
                        {cp.accountType === "token"
                          ? (cp.tokenSymbol ?? cp.tokenName ?? "tkn")
                          : cp.accountType === "program" ? "pgm"
                          : cp.accountType === "unknown" ? "closed" : "pgm owned"}
                      </span>
                    )}
                  </div>
                  {cp.label && (
                    <div className="font-mono text-[9px] text-primary truncate max-w-[160px] leading-tight">
                      {cp.label}
                    </div>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono text-[10px] text-foreground tabular-nums align-top">
                {cp.txCount}
              </TableCell>
              <TableCell className="text-right font-mono text-[10px] text-foreground tabular-nums align-top">
                {fmtSol(cp.solSent + cp.solReceived)}
              </TableCell>
              <TableCell
                className={`text-right font-mono text-[10px] tabular-nums align-top ${
                  cp.solNet >= 0 ? "text-[#00ff88]" : "text-destructive"
                }`}
              >
                {cp.solNet >= 0 ? "+" : ""}
                {fmtSol(cp.solNet)}
              </TableCell>
              <TableCell className="text-right font-mono text-[9px] text-muted-foreground tabular-nums align-top">
                {fmtDate(cp.lastSeen)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Right-click context menu */}
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
            minWidth: 180,
            boxShadow: "0 4px 24px rgba(0, 0, 0, 0.5)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ padding: "2px 12px 6px" }}>
            <div style={{ fontSize: 10, color: "#c8d6e5", letterSpacing: "0.03em" }}>
              {truncAddr(contextMenu.address)}
            </div>
            {contextMenu.label && (
              <div style={{ fontSize: 11, color: "#00d4ff", fontWeight: 600, marginTop: 1 }}>
                {contextMenu.label}
              </div>
            )}
          </div>
          <div style={{ height: 1, background: "#1e2a3a", margin: "0 8px 4px" }} />

          {/* Copy Address */}
          <button
            onClick={() => { navigator.clipboard.writeText(contextMenu.address); setContextMenu(null); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "6px 12px", background: "none", border: "none",
              color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <span style={{ fontSize: 13 }}>&#x2398;</span>
            Copy Address
          </button>

          {/* Navigate */}
          <button
            onClick={() => { onNavigate(contextMenu.address); setContextMenu(null); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "6px 12px", background: "none", border: "none",
              color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <span style={{ fontSize: 13 }}>&rarr;</span>
            Navigate
          </button>

          {/* Add as Node / Remove from Graph */}
          {graphAddresses.has(contextMenu.address) ? (
            <button
              onClick={() => { onRemoveNode(contextMenu.address); setContextMenu(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 12px", background: "none", border: "none",
                color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
                cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255, 45, 45, 0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <span style={{ fontSize: 13, color: "#ff2d2d" }}>&times;</span>
              Remove from Graph
            </button>
          ) : (
            <button
              onClick={() => { onAddNode(contextMenu.address); setContextMenu(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 12px", background: "none", border: "none",
                color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
                cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <span style={{ fontSize: 13 }}>+</span>
              Add as Node
            </button>
          )}

          {/* Add as Full Graph */}
          <button
            onClick={() => { onAddOverlay(contextMenu.address); setContextMenu(null); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "6px 12px", background: "none", border: "none",
              color: "#c8d6e5", fontSize: 11, fontFamily: "var(--font-mono)",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0, 212, 255, 0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <span style={{ fontSize: 13 }}>&loz;</span>
            Add as Full Graph
          </button>
        </div>
      )}
    </div>
  );
}
