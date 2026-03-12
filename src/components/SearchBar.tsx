import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

const SOL_DOMAIN_REGEX = /^[^\s]+\.sol$/i;
let walletInputApiPromise: Promise<typeof import("@/api")> | null = null;

function loadWalletInputApi() {
  walletInputApiPromise ??= import("@/api");
  return walletInputApiPromise;
}

interface SearchBarProps {
  onSearch: (address: string) => void | Promise<void>;
  loading?: boolean;
  defaultValue?: string;
  autoFocus?: boolean;
  enableShortcut?: boolean;
  placeholder?: string;
  submitLabel?: string;
}

export function SearchBar({
  onSearch,
  loading,
  defaultValue = "",
  autoFocus = false,
  enableShortcut = false,
  placeholder = "PASTE WALLET ADDRESS...",
  submitLabel,
}: SearchBarProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [previewState, setPreviewState] = useState<{
    status: "idle" | "loading" | "resolved" | "invalid";
    query: string;
    address?: string;
  }>({ status: "idle", query: "" });
  const [hasFocus, setHasFocus] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isBusy = loading || resolving;
  const trimmedValue = value.trim();
  const normalizedValue = trimmedValue.toLowerCase();
  const isSolDomainQuery = SOL_DOMAIN_REGEX.test(trimmedValue);
  const showPreview = hasFocus && isSolDomainQuery && previewState.status !== "idle";

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  useEffect(() => {
    if (!isSolDomainQuery) {
      setPreviewState({ status: "idle", query: "" });
      return;
    }

    const query = normalizedValue;
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      setPreviewState((current) => (
        current.status === "resolved" && current.query === query
          ? current
          : { status: "loading", query }
      ));

      void loadWalletInputApi()
        .then(({ resolveWalletInput }) => resolveWalletInput(query))
        .then((address) => {
          if (cancelled) return;
          setPreviewState({ status: "resolved", query, address });
        })
        .catch(() => {
          if (cancelled) return;
          setPreviewState({ status: "invalid", query });
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isSolDomainQuery, normalizedValue]);

  const focusInput = useEffectEvent(() => {
    const input = inputRef.current;
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
    const cursor = input.value.length;
    input.setSelectionRange(cursor, cursor);
  });

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      focusInput();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!enableShortcut || event.key !== "/") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    focusInput();
  });

  useEffect(() => {
    if (!enableShortcut) return;
    const listener = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enableShortcut]);

  async function submitResolvedInput(resolved: string, rawInput: string) {
    setError("");
    if (SOL_DOMAIN_REGEX.test(rawInput.trim())) {
      const { rememberPreferredSolDomain } = await loadWalletInputApi();
      rememberPreferredSolDomain(resolved, rawInput);
    }
    setResolving(true);
    try {
      await onSearch(resolved);
    } finally {
      setResolving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      if (previewState.status === "resolved" && previewState.query === normalizedValue && previewState.address) {
        await submitResolvedInput(previewState.address, normalizedValue);
        return;
      }

      const { resolveWalletInput } = await loadWalletInputApi();
      const resolved = await resolveWalletInput(value);
      await submitResolvedInput(resolved, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid Solana address or .sol domain");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`relative z-40 w-full ${showPreview ? "pb-36" : ""}`}
    >
      <div ref={wrapperRef} className="relative z-40">
        <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-primary opacity-60">
          {">"}_
        </div>
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          onFocus={() => setHasFocus(true)}
          onBlur={(e) => {
            const nextTarget = e.relatedTarget;
            if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) {
              return;
            }
            setHasFocus(false);
          }}
          disabled={isBusy}
          className={`h-8 border-border bg-background pl-8 font-mono text-xs tracking-wider text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary ${
            submitLabel ? "pr-36 sm:pr-40" : enableShortcut ? "pr-14" : "pr-3"
          }`}
        />
        {(enableShortcut || submitLabel || isBusy) && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
            {submitLabel && (
              <button
                type="submit"
                disabled={isBusy}
                className="rounded bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitLabel}
              </button>
            )}
            {isBusy ? (
              <div className="flex h-5 w-5 items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : enableShortcut ? (
              <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/70 bg-background/80 px-1.5 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            ) : null}
          </div>
        )}

        {showPreview && (
          <div className="absolute left-0 right-0 top-full z-50 mt-3 overflow-hidden rounded-xl border border-border bg-background shadow-[0_18px_48px_rgba(0,0,0,0.55)]">
            {previewState.status === "loading" && (
              <div className="flex items-center gap-3 px-3 py-3">
                <div className="flex h-5 w-5 items-center justify-center">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary/80">
                    Checking domain
                  </div>
                  <div className="mt-1 font-mono text-xs text-foreground/75">{normalizedValue}</div>
                </div>
              </div>
            )}

            {previewState.status === "resolved" && previewState.address && (
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 px-3 py-3 text-left transition-colors hover:bg-primary/6 focus:bg-primary/6 focus:outline-none"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void submitResolvedInput(previewState.address!, previewState.query)}
              >
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary/80">
                    Domain
                  </div>
                  <div className="mt-1 truncate font-mono text-sm text-foreground">{previewState.query}</div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    Resolves to {previewState.address}
                  </div>
                </div>
                <div className="shrink-0 rounded border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-primary">
                  Valid
                </div>
              </button>
            )}

            {previewState.status === "invalid" && (
              <div className="flex items-center justify-between gap-4 px-3 py-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-destructive/90">
                    Domain
                  </div>
                  <div className="mt-1 truncate font-mono text-sm text-foreground">{previewState.query}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    No matching .sol domain found
                  </div>
                </div>
                <div className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-destructive/90">
                  Invalid
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {error && (
        <p className="mt-1 font-mono text-xs text-destructive">{error}</p>
      )}
    </form>
  );
}
