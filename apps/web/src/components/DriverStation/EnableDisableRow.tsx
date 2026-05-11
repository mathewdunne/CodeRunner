import { useState } from "react";
import { cn } from "@/lib/utils";

interface BigButtonProps {
  label: string;
  tone: "enable" | "disable";
  active: boolean;
  onClick: () => void;
}

const TONE_ACTIVE: Record<BigButtonProps["tone"], string> = {
  enable:
    "border-emerald-400/60 bg-emerald-500/25 text-emerald-50 shadow-[inset_0_-2px_0_rgba(0,0,0,0.25),0_0_24px_rgba(34,197,94,0.18)]",
  disable:
    "border-red-400/60 bg-red-500/25 text-red-50 shadow-[inset_0_-2px_0_rgba(0,0,0,0.25),0_0_24px_rgba(239,68,68,0.18)]",
};

function BigButton({ label, tone, active, onClick }: BigButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-full w-full rounded-lg border text-[14px] font-semibold uppercase tracking-wide transition-all",
        active
          ? TONE_ACTIVE[tone]
          : "border-border bg-white/[0.03] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function EnableDisableRow() {
  // TODO: wire to halSim.setEnabled(...) and read halSim.enabled. Local state is
  // a placeholder so the buttons feel interactive in the meantime.
  const [enabled, setEnabled] = useState(false);

  const handleEnable = () => {
    setEnabled(true);
    console.log("[enable] true");
  };
  const handleDisable = () => {
    setEnabled(false);
    console.log("[enable] false");
  };

  return (
    <div className="grid h-full min-h-0 gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
      <div className="min-h-0 rounded-lg border border-border bg-card p-2">
        <BigButton
          label="Enable"
          tone="enable"
          active={enabled}
          onClick={handleEnable}
        />
      </div>
      <div className="min-h-0 rounded-lg border border-border bg-card p-2">
        <BigButton
          label={enabled ? "Disable" : "Disabled"}
          tone="disable"
          active={!enabled}
          onClick={handleDisable}
        />
      </div>
    </div>
  );
}
