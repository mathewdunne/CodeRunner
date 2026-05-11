import { useState } from "react";
import { cn } from "@/lib/utils";

type Mode = "teleop" | "auto" | "test";

const MODE_LABELS: Record<Mode, string> = {
  teleop: "Teleop",
  auto: "Auto",
  test: "Test",
};

const MODE_CLASSES: Record<Mode, { active: string }> = {
  teleop: {
    active: "border-blue-400/60 bg-blue-500/20 text-blue-100",
  },
  auto: {
    active: "border-orange-400/60 bg-orange-500/20 text-orange-100",
  },
  test: {
    active: "border-purple-400/60 bg-purple-500/20 text-purple-100",
  },
};

export function ModeColumn() {
  // TODO: wire to halSim.setMode(...) and read halSim.mode. Local state is a
  // placeholder so the buttons feel interactive in the meantime.
  const [mode, setMode] = useState<Mode>("teleop");

  const handleSelect = (next: Mode) => {
    setMode(next);
    console.log(`[mode] selected ${next}`);
  };

  return (
    <div className="flex min-h-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-2">
      <span className="px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Mode
      </span>
      {(Object.keys(MODE_LABELS) as Mode[]).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => handleSelect(m)}
            className={cn(
              "flex-1 rounded-md border text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors",
              active
                ? MODE_CLASSES[m].active
                : "border-border bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
