import { forwardRef } from "react";
import type { ScopeStatus } from "@/hooks/useScopeHandshake";

interface ScopePaneProps {
  scopeStatus: ScopeStatus;
}

const scopeLabel = (status: ScopeStatus) =>
  status === "connected"
    ? "Scope connected"
    : status === "timeout"
      ? "Scope timeout"
      : "Scope connecting";

export const ScopePane = forwardRef<HTMLIFrameElement, ScopePaneProps>(
  function ScopePane({ scopeStatus }, ref) {
    return (
      <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card">
        <header className="flex h-[38px] shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-xs font-bold text-muted-foreground">
          <span>AdvantageScope</span>
          <span className="text-[11px] font-medium text-muted-foreground/70">
            {scopeLabel(scopeStatus)}
          </span>
        </header>
        <iframe
          ref={ref}
          title="AdvantageScope Lite"
          src="/scope/?frcEndpoint=postMessage"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </aside>
    );
  },
);
