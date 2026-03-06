import type { ReactNode } from "react";

interface HudCardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function HudCard({ title, children, className = "" }: HudCardProps) {
  return (
    <div
      className={`corner-bracket scanline relative border border-border bg-card p-2.5 ${className}`}
    >
      <div className="corner-bl" />
      <div className="corner-br" />
      {title && (
        <div className="mb-2 flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
            {title}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}
      {children}
    </div>
  );
}
