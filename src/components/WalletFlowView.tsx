import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalletIdentity } from "@/api";
import type { CounterpartyFlow, CounterpartyTokenTransfer } from "@/lib/parse-transactions";

export interface TokenMeta {
  symbol?: string;
  name?: string;
  logoUri?: string;
}

interface WalletFlowViewProps {
  address: string;
  identity: WalletIdentity | null;
  counterparties: CounterpartyFlow[];
  loading: boolean;
  selectedAddress: string | null;
  onSelectAddress: (address: string) => void;
  tokenMetadata?: Map<string, TokenMeta>;
  solBalance?: number | null;
}

type FlowSide = "outflow" | "inflow";
type FlowSortKey = "tx" | "volume" | "net" | "date";
const FLOW_ROW_HEIGHT = 96;
const FLOW_ROW_GAP = 8;
const FLOW_ROW_PITCH = FLOW_ROW_HEIGHT + FLOW_ROW_GAP;
const FLOW_OVERSCAN = 4;
const ALL_TOKENS = "__all__";
const SOL_FILTER = "__sol__";

function truncAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function describeWallet(address: string, identity: WalletIdentity | null): string {
  return identity?.label ?? identity?.name ?? truncAddr(address);
}

function describeCounterparty(cp: CounterpartyFlow): string {
  return cp.label ?? cp.tokenSymbol ?? cp.tokenName ?? truncAddr(cp.address);
}

function formatSolCompact(sol: number): string {
  if (Math.abs(sol) < 0.001) return "<0.001";
  if (Math.abs(sol) >= 1000) {
    return sol.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTokenCompact(amount: number): string {
  if (Math.abs(amount) < 0.01) return "<0.01";
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 10_000) return `${(amount / 1000).toFixed(1)}K`;
  if (Math.abs(amount) >= 1000) return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function getTokenLabel(mint: string, meta?: TokenMeta, tfMeta?: { symbol?: string; name?: string }): string {
  return tfMeta?.symbol ?? tfMeta?.name ?? meta?.symbol ?? meta?.name ?? `${mint.slice(0, 4)}..${mint.slice(-3)}`;
}

function getSideAmount(cp: CounterpartyFlow, side: FlowSide): number {
  return side === "outflow" ? cp.solSent : cp.solReceived;
}

function getTokenSideAmount(tf: CounterpartyTokenTransfer, side: FlowSide): number {
  return side === "outflow" ? tf.sent : tf.received;
}

function hasSideFlow(cp: CounterpartyFlow, side: FlowSide): boolean {
  if (side === "outflow") {
    return cp.solSent > 0 || (cp.tokenTransfers?.some((tf) => tf.sent > 0) ?? false);
  }
  return cp.solReceived > 0 || (cp.tokenTransfers?.some((tf) => tf.received > 0) ?? false);
}

function getDirectionalSortValue(
  cp: CounterpartyFlow,
  side: FlowSide,
  sortKey: FlowSortKey,
): number {
  if (sortKey === "volume") return getSideAmount(cp, side);
  if (sortKey === "net") return side === "outflow" ? Math.max(-cp.solNet, 0) : Math.max(cp.solNet, 0);
  if (sortKey === "date") return cp.lastSeen;
  return cp.txCount;
}

function sortFlowItems(
  items: CounterpartyFlow[],
  side: FlowSide,
  sortKey: FlowSortKey,
): CounterpartyFlow[] {
  return [...items].sort((a, b) => {
    const primary = getDirectionalSortValue(b, side, sortKey) - getDirectionalSortValue(a, side, sortKey);
    if (primary !== 0) return primary;
    const secondary = b.txCount - a.txCount;
    if (secondary !== 0) return secondary;
    return (b.solSent + b.solReceived) - (a.solSent + a.solReceived);
  });
}

function filterFlowItems(items: CounterpartyFlow[], query: string): CounterpartyFlow[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((cp) =>
    cp.address.toLowerCase().includes(q)
      || (cp.label?.toLowerCase().includes(q) ?? false)
      || (cp.tokenName?.toLowerCase().includes(q) ?? false)
      || (cp.tokenSymbol?.toLowerCase().includes(q) ?? false),
  );
}

function filterByToken(
  items: CounterpartyFlow[],
  side: FlowSide,
  tokenMint: string,
  minAmount: number,
): CounterpartyFlow[] {
  if (tokenMint === ALL_TOKENS && minAmount <= 0) return items;

  if (tokenMint === ALL_TOKENS) {
    // Min amount applies to SOL
    return items.filter((cp) => getSideAmount(cp, side) >= minAmount);
  }

  if (tokenMint === SOL_FILTER) {
    return items.filter((cp) => getSideAmount(cp, side) >= Math.max(minAmount, 0.001));
  }

  return items.filter((cp) => {
    const tf = cp.tokenTransfers?.find((t) => t.mint === tokenMint);
    if (!tf) return false;
    return getTokenSideAmount(tf, side) >= (minAmount || 0.01);
  });
}

interface AvailableToken {
  mint: string;
  label: string;
  totalVolume: number;
}

function useViewportHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}

function TokenDropdown({
  value,
  onChange,
  tokens,
  active,
}: {
  value: string;
  onChange: (value: string) => void;
  tokens: AvailableToken[];
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedLabel = value === ALL_TOKENS
    ? "All tokens"
    : value === SOL_FILTER
      ? "SOL"
      : tokens.find((t) => t.mint === value)?.label ?? "Unknown";

  const select = useCallback((v: string) => {
    onChange(v);
    setOpen(false);
  }, [onChange]);

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-6 w-full items-center justify-between gap-1 rounded border px-1.5 font-mono text-[9px] outline-none transition-colors"
        style={{
          borderColor: active ? "rgba(255, 184, 0, 0.4)" : "hsl(var(--border))",
          background: active ? "rgba(255, 184, 0, 0.06)" : "rgba(var(--background), 0.7)",
          color: active ? "#ffb800" : "hsl(var(--foreground))",
        }}
      >
        <span className="truncate">{selectedLabel}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 opacity-50">
          <path d="M1 3l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded border border-border bg-card shadow-lg shadow-black/40"
          style={{ top: "100%" }}
        >
          <DropdownItem
            label="All tokens"
            selected={value === ALL_TOKENS}
            onSelect={() => select(ALL_TOKENS)}
          />
          <DropdownItem
            label="SOL"
            mint={SOL_FILTER}
            selected={value === SOL_FILTER}
            onSelect={() => select(SOL_FILTER)}
          />
          {tokens.map((t) => (
            <DropdownItem
              key={t.mint}
              label={t.label}
              mint={t.mint}
              selected={value === t.mint}
              onSelect={() => select(t.mint)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  label,
  mint,
  selected,
  onSelect,
}: {
  label: string;
  mint?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const showMint = mint && label !== mint && !mint.startsWith("__");
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-[9px] transition-colors hover:bg-primary/10"
      style={{ color: selected ? "#00d4ff" : "hsl(var(--foreground))" }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: selected ? "#00d4ff" : "transparent",
          border: selected ? "none" : "1px solid rgba(255,255,255,0.15)",
        }}
      />
      <span className="truncate">{label}</span>
      {showMint && (
        <span className="ml-auto shrink-0 text-[8px] text-muted-foreground/50">
          {mint.slice(0, 4)}..{mint.slice(-4)}
        </span>
      )}
    </button>
  );
}

function FlowLane({
  counterparty,
  side,
  maxSideAmount,
  selected,
  onSelect,
  tokenMetadata,
  highlightToken,
}: {
  counterparty: CounterpartyFlow;
  side: FlowSide;
  maxSideAmount: number;
  selected: boolean;
  onSelect: (address: string) => void;
  tokenMetadata?: Map<string, TokenMeta>;
  highlightToken?: string;
}) {
  const solAmount = getSideAmount(counterparty, side);
  const pct = maxSideAmount > 0 ? solAmount / maxSideAmount : 0;
  const barWidth = `${20 + pct * 80}%`;
  const color = side === "outflow" ? "#ff4d4d" : "#00ff88";
  const barGlow =
    side === "outflow" ? "rgba(255, 77, 77, 0.35)" : "rgba(0, 255, 136, 0.35)";

  // Get top token transfers for this side, max 2
  const sideTokens = useMemo(() => {
    if (!counterparty.tokenTransfers?.length) return [];
    const filtered = counterparty.tokenTransfers
      .filter((tf) => getTokenSideAmount(tf, side) > 0)
      .sort((a, b) => {
        // If a token is highlighted, put it first
        if (highlightToken && highlightToken !== ALL_TOKENS && highlightToken !== SOL_FILTER) {
          if (a.mint === highlightToken) return -1;
          if (b.mint === highlightToken) return 1;
        }
        return getTokenSideAmount(b, side) - getTokenSideAmount(a, side);
      });
    return filtered.slice(0, 2);
  }, [counterparty.tokenTransfers, side, highlightToken]);

  const card = (
    <button
      type="button"
      data-flow-address={counterparty.address}
      onClick={() => onSelect(counterparty.address)}
      className={`wallet-flow-lane group rounded border px-2 py-1.5 text-left transition-all ${
        selected
          ? "border-primary/50 bg-primary/10 shadow-[0_0_18px_rgba(0,212,255,0.16)]"
          : "border-border bg-card/90 hover:border-primary/30 hover:bg-card"
      }`}
    >
      <div className="truncate font-mono text-[10px] font-bold leading-tight text-foreground">
        {describeCounterparty(counterparty)}
      </div>
      <div className="mt-0.5 font-mono text-[8px] leading-tight text-muted-foreground">
        {truncAddr(counterparty.address)}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[8px]">
        <span style={{ color }}>{formatSolCompact(solAmount)} SOL</span>
        <span className="text-muted-foreground">{counterparty.txCount.toLocaleString()} tx</span>
      </div>
      {sideTokens.length > 0 && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0 font-mono text-[7px]">
          {sideTokens.map((tf) => {
            const label = getTokenLabel(tf.mint, tokenMetadata?.get(tf.mint), tf);
            const amount = getTokenSideAmount(tf, side);
            const isHighlighted = highlightToken === tf.mint;
            return (
              <span
                key={tf.mint}
                style={{
                  color: isHighlighted ? "#ffb800" : "rgba(148, 163, 184, 0.8)",
                }}
              >
                {formatTokenCompact(amount)} {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );

  const bar = (
    <div className="relative h-6">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/60" />
      <div
        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
        style={{
          width: barWidth,
          [side === "outflow" ? "right" : "left"]: 0,
          background: color,
          boxShadow: `0 0 12px ${barGlow}`,
          opacity: 0.9,
        }}
      />
    </div>
  );

  return (
    <div
      style={{ height: FLOW_ROW_HEIGHT }}
      className={`grid items-center gap-2 ${side === "outflow" ? "grid-cols-[180px_minmax(80px,1fr)]" : "grid-cols-[minmax(80px,1fr)_180px]"}`}
    >
      {side === "outflow" ? (
        <>
          {card}
          {bar}
        </>
      ) : (
        <>
          {bar}
          {card}
        </>
      )}
    </div>
  );
}

function VirtualFlowColumn({
  title,
  total,
  items,
  side,
  selectedAddress,
  onSelectAddress,
  searchValue,
  onSearchChange,
  sortKey,
  onSortKeyChange,
  tokenFilter,
  onTokenFilterChange,
  minAmount,
  onMinAmountChange,
  availableTokens,
  tokenMetadata,
  hiddenMessage,
}: {
  title: string;
  total: number;
  items: CounterpartyFlow[];
  side: FlowSide;
  selectedAddress: string | null;
  onSelectAddress: (address: string) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  sortKey: FlowSortKey;
  onSortKeyChange: (sortKey: FlowSortKey) => void;
  tokenFilter: string;
  onTokenFilterChange: (value: string) => void;
  minAmount: string;
  onMinAmountChange: (value: string) => void;
  availableTokens: AvailableToken[];
  tokenMetadata?: Map<string, TokenMeta>;
  hiddenMessage?: string;
}) {
  const { ref: scrollRef, height: viewportHeight } = useViewportHeight<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const previousSelectedAddressRef = useRef<string | null>(null);
  const maxSideAmount = useMemo(
    () => Math.max(...items.map((cp) => getSideAmount(cp, side)), 1),
    [items, side],
  );

  const startIndex = Math.max(0, Math.floor(scrollTop / FLOW_ROW_PITCH) - FLOW_OVERSCAN);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + viewportHeight) / FLOW_ROW_PITCH) + FLOW_OVERSCAN,
  );
  const visibleItems = items.slice(startIndex, endIndex);
  const topPad = startIndex * FLOW_ROW_PITCH;
  const bottomPad = Math.max(0, (items.length - endIndex) * FLOW_ROW_PITCH);

  useEffect(() => {
    const previousSelectedAddress = previousSelectedAddressRef.current;
    previousSelectedAddressRef.current = selectedAddress;
    if (selectedAddress === previousSelectedAddress) return;
    if (!selectedAddress || !scrollRef.current || viewportHeight <= 0) return;
    const index = items.findIndex((cp) => cp.address === selectedAddress);
    if (index < 0) return;
    const rowTop = index * FLOW_ROW_PITCH;
    const rowBottom = rowTop + FLOW_ROW_PITCH;
    const viewTop = scrollRef.current.scrollTop;
    const viewBottom = viewTop + viewportHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) return;
    scrollRef.current.scrollTo({
      top: Math.max(0, rowTop - viewportHeight / 2 + FLOW_ROW_PITCH / 2),
      behavior: "smooth",
    });
  }, [items, selectedAddress, viewportHeight, scrollRef]);

  const hasTokenFilter = tokenFilter !== ALL_TOKENS;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <div
          className="font-mono text-[9px] uppercase tracking-[0.22em]"
          style={{ color: side === "outflow" ? "#ff4d4d" : "#00ff88" }}
        >
          {title}
        </div>
        <div className="font-mono text-[8px] text-muted-foreground">
          {total.toLocaleString()} total
        </div>
      </div>

      {/* Row 1: Search + sort */}
      <div className="mb-1.5 flex items-center gap-1 px-1">
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={`Filter ${title.toLowerCase()}`}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-background/70 px-2 font-mono text-[9px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-primary/40"
        />
        {([
          ["tx", "Txn Count"],
          ["volume", "Volume"],
          ["net", "Net"],
          ["date", "Date"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => onSortKeyChange(key)}
            className="rounded px-1.5 py-1 font-mono text-[8px] uppercase tracking-[0.16em] transition-colors"
            style={{
              background: sortKey === key ? "rgba(0, 212, 255, 0.12)" : "transparent",
              color: sortKey === key ? "#00d4ff" : "#6b7280",
              border: `1px solid ${sortKey === key ? "rgba(0, 212, 255, 0.24)" : "rgba(255,255,255,0.04)"}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Row 2: Token filter + min amount */}
      <div className="mb-2 flex items-center gap-1 px-1">
        <TokenDropdown
          value={tokenFilter}
          onChange={onTokenFilterChange}
          tokens={availableTokens}
          active={hasTokenFilter}
        />
        <input
          type="text"
          inputMode="decimal"
          value={minAmount}
          onChange={(e) => onMinAmountChange(e.target.value)}
          placeholder="Min amt"
          className="h-6 w-16 rounded border border-border bg-background/70 px-1.5 font-mono text-[9px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-primary/40"
          style={{
            border: minAmount ? "1px solid rgba(255, 184, 0, 0.4)" : undefined,
            background: minAmount ? "rgba(255, 184, 0, 0.06)" : undefined,
          }}
        />
      </div>

      {hiddenMessage ? (
        <EmptySide title={`${title} Hidden`} message={hiddenMessage} />
      ) : items.length === 0 ? (
        <EmptySide title={title} message={`No ${title.toLowerCase()} relationships matching filters.`} />
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="flow-scroll-column min-h-0 flex-1 overflow-y-auto pr-2"
        >
          <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
            {visibleItems.map((cp, index) => (
              <div
                key={`${side}:${cp.address}`}
                style={{ marginBottom: index === visibleItems.length - 1 ? 0 : FLOW_ROW_GAP }}
              >
                <FlowLane
                  counterparty={cp}
                  side={side}
                  maxSideAmount={maxSideAmount}
                  selected={selectedAddress === cp.address}
                  onSelect={onSelectAddress}
                  tokenMetadata={tokenMetadata}
                  highlightToken={tokenFilter}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptySide({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded border border-border bg-card/70 px-3 py-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">{title}</div>
      <div className="mt-2 font-mono text-[10px] text-muted-foreground">{message}</div>
    </div>
  );
}

export function WalletFlowView({
  address,
  identity,
  counterparties,
  loading,
  selectedAddress,
  onSelectAddress,
  tokenMetadata,
  solBalance,
}: WalletFlowViewProps) {
  const [inflowQuery, setInflowQuery] = useState("");
  const [outflowQuery, setOutflowQuery] = useState("");
  const [inflowSortKey, setInflowSortKey] = useState<FlowSortKey>("tx");
  const [outflowSortKey, setOutflowSortKey] = useState<FlowSortKey>("tx");
  const [inflowTokenFilter, setInflowTokenFilter] = useState(ALL_TOKENS);
  const [outflowTokenFilter, setOutflowTokenFilter] = useState(ALL_TOKENS);
  const [inflowMinAmount, setInflowMinAmount] = useState("");
  const [outflowMinAmount, setOutflowMinAmount] = useState("");

  // Collect available tokens per side (only tokens with flow in that direction)
  const { inflowTokens, outflowTokens } = useMemo(() => {
    const inflowMap = new Map<string, { mint: string; totalVolume: number; symbol?: string; name?: string }>();
    const outflowMap = new Map<string, { mint: string; totalVolume: number; symbol?: string; name?: string }>();
    for (const cp of counterparties) {
      if (!cp.tokenTransfers) continue;
      for (const tf of cp.tokenTransfers) {
        if (tf.received > 0) {
          const existing = inflowMap.get(tf.mint);
          if (existing) {
            existing.totalVolume += tf.received;
            existing.symbol = existing.symbol ?? tf.symbol;
            existing.name = existing.name ?? tf.name;
          } else {
            inflowMap.set(tf.mint, { mint: tf.mint, totalVolume: tf.received, symbol: tf.symbol, name: tf.name });
          }
        }
        if (tf.sent > 0) {
          const existing = outflowMap.get(tf.mint);
          if (existing) {
            existing.totalVolume += tf.sent;
            existing.symbol = existing.symbol ?? tf.symbol;
            existing.name = existing.name ?? tf.name;
          } else {
            outflowMap.set(tf.mint, { mint: tf.mint, totalVolume: tf.sent, symbol: tf.symbol, name: tf.name });
          }
        }
      }
    }
    const toList = (map: Map<string, { mint: string; totalVolume: number; symbol?: string; name?: string }>) =>
      Array.from(map.values())
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .map((t) => ({
          mint: t.mint,
          label: getTokenLabel(t.mint, tokenMetadata?.get(t.mint), t),
          totalVolume: t.totalVolume,
        }));
    return { inflowTokens: toList(inflowMap), outflowTokens: toList(outflowMap) };
  }, [counterparties, tokenMetadata]);

  const inflowMinNum = Number(inflowMinAmount) || 0;
  const outflowMinNum = Number(outflowMinAmount) || 0;

  const outflows = useMemo(
    () => sortFlowItems(
      filterByToken(
        filterFlowItems(
          counterparties.filter((cp) => hasSideFlow(cp, "outflow")),
          outflowQuery,
        ),
        "outflow",
        outflowTokenFilter,
        outflowMinNum,
      ),
      "outflow",
      outflowSortKey,
    ),
    [counterparties, outflowQuery, outflowSortKey, outflowTokenFilter, outflowMinNum],
  );
  const inflows = useMemo(
    () => sortFlowItems(
      filterByToken(
        filterFlowItems(
          counterparties.filter((cp) => hasSideFlow(cp, "inflow")),
          inflowQuery,
        ),
        "inflow",
        inflowTokenFilter,
        inflowMinNum,
      ),
      "inflow",
      inflowSortKey,
    ),
    [counterparties, inflowQuery, inflowSortKey, inflowTokenFilter, inflowMinNum],
  );

  const walletLabel = describeWallet(address, identity);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center graph-grid-bg">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Scanning Flow Surface...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col graph-grid-bg">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
          Bilateral Flow View
        </div>
        <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted-foreground">
          Independent side sorting
        </div>
      </div>

      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_220px_minmax(0,1fr)] gap-5 px-5 py-4">
        <VirtualFlowColumn
          title="Inflows"
          total={inflows.length}
          items={inflows}
          side="inflow"
          selectedAddress={selectedAddress}
          onSelectAddress={onSelectAddress}
          searchValue={inflowQuery}
          onSearchChange={setInflowQuery}
          sortKey={inflowSortKey}
          onSortKeyChange={setInflowSortKey}
          tokenFilter={inflowTokenFilter}
          onTokenFilterChange={setInflowTokenFilter}
          minAmount={inflowMinAmount}
          onMinAmountChange={setInflowMinAmount}
          availableTokens={inflowTokens}
          tokenMetadata={tokenMetadata}
        />

        <div className="flex items-center justify-center">
          <div className="w-full rounded border border-primary/40 bg-card px-4 py-5 text-center shadow-[0_0_24px_rgba(0,212,255,0.14)]">
            <div className="font-mono text-[8px] uppercase tracking-[0.24em] text-primary/70">Wallet</div>
            <div className="mt-2 truncate font-mono text-[15px] font-bold text-primary">{walletLabel}</div>
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">{truncAddr(address)}</div>
            {solBalance != null && (
              <div className="mt-4 rounded border border-border bg-background/70 px-3 py-1.5 font-mono text-[8px] text-muted-foreground">
                <div className="uppercase tracking-[0.16em]">Balance</div>
                <div className="mt-0.5 text-[11px] text-foreground">
                  {solBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL
                </div>
              </div>
            )}
          </div>
        </div>

        <VirtualFlowColumn
          title="Outflows"
          total={outflows.length}
          items={outflows}
          side="outflow"
          selectedAddress={selectedAddress}
          onSelectAddress={onSelectAddress}
          searchValue={outflowQuery}
          onSearchChange={setOutflowQuery}
          sortKey={outflowSortKey}
          onSortKeyChange={setOutflowSortKey}
          tokenFilter={outflowTokenFilter}
          onTokenFilterChange={setOutflowTokenFilter}
          minAmount={outflowMinAmount}
          onMinAmountChange={setOutflowMinAmount}
          availableTokens={outflowTokens}
          tokenMetadata={tokenMetadata}
        />
      </div>
    </div>
  );
}
