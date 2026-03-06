import { useState } from "react";
import { Input } from "@/components/ui/input";

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface SearchBarProps {
  onSearch: (address: string) => void;
  loading?: boolean;
}

export function SearchBar({ onSearch, loading }: SearchBarProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!BASE58_REGEX.test(trimmed)) {
      setError("Invalid Solana address");
      return;
    }
    setError("");
    onSearch(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="relative">
        <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-primary opacity-60">
          {">"}_
        </div>
        <Input
          type="text"
          placeholder="PASTE WALLET ADDRESS..."
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          disabled={loading}
          className="h-8 border-border bg-card pl-8 font-mono text-xs tracking-wider text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>
      {error && (
        <p className="mt-1 font-mono text-xs text-destructive">{error}</p>
      )}
    </form>
  );
}
