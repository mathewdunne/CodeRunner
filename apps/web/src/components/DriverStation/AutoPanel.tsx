import { useMemo, useState } from "react";
import { Check, CircleDot, ListTree, Route } from "lucide-react";
import type { AutoChooser, AutoChooserPatch, AutoChoosersResponse, SimRunStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface AutoPanelProps {
  autoStatus: AutoChoosersResponse | null;
  runStatus: SimRunStatus;
  sessionReady: boolean;
  onSelectAuto: (patch: AutoChooserPatch) => void;
}

const DEFAULT_CHOOSER_KEY = "SmartDashboard/Auto Choices";

function preferredChooser(choosers: AutoChooser[], selectedKey: string | null): AutoChooser | null {
  return (
    choosers.find((chooser) => chooser.key === selectedKey) ??
    choosers.find((chooser) => chooser.key === DEFAULT_CHOOSER_KEY) ??
    choosers[0] ??
    null
  );
}

function TileHeader({ label, Icon }: { label: string; Icon: typeof Route }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <Icon className="size-3.5" />
      {label}
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border bg-white/[0.02] px-3 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function AutoPanel({
  autoStatus,
  runStatus,
  sessionReady,
  onSelectAuto,
}: AutoPanelProps) {
  const [selectedChooserKey, setSelectedChooserKey] = useState<string | null>(null);
  const choosers = autoStatus?.choosers ?? [];
  const chooser = useMemo(
    () => preferredChooser(choosers, selectedChooserKey),
    [choosers, selectedChooserKey],
  );
  const canWrite =
    sessionReady &&
    runStatus === "running" &&
    autoStatus?.nt4.connected === true &&
    chooser !== null &&
    chooser.options.length > 0;

  return (
    <div
      className="grid h-full min-h-0 flex-1 overflow-hidden gap-2.5 border-r border-border p-3"
      style={{ gridTemplateColumns: "minmax(220px, 0.9fr) minmax(260px, 1.1fr)" }}
    >
      <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
        <TileHeader label="Chooser" Icon={ListTree} />
        {choosers.length === 0 ? (
          <EmptyState>
            {autoStatus?.nt4.connected
              ? "No auto chooser found."
              : "Start robot code to discover auto choosers."}
          </EmptyState>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
            {choosers.map((candidate) => {
              const active = candidate.key === chooser?.key;
              return (
                <button
                  key={candidate.key}
                  type="button"
                  onClick={() => setSelectedChooserKey(candidate.key)}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                    active
                      ? "border-orange-400/60 bg-orange-500/15 text-orange-100"
                      : "border-border bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                  )}
                >
                  <Route className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                    {candidate.displayKey}
                  </span>
                  {active ? <Check className="size-4 shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
        <TileHeader label="Autonomous Routine" Icon={Route} />
        {!chooser ? (
          <EmptyState>Select a chooser to view routines.</EmptyState>
        ) : chooser.options.length === 0 ? (
          <EmptyState>This chooser has no published routines.</EmptyState>
        ) : (
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-1.5 overflow-y-auto">
            {chooser.options.map((option) => {
              const active = option === (chooser.selected ?? chooser.active);
              const robotActive = option === chooser.active;
              const isDefault = option === chooser.default;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!canWrite || active}
                  onClick={() => onSelectAuto({ key: chooser.key, selected: option })}
                  className={cn(
                    "flex min-h-16 flex-col items-start justify-center gap-1 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed",
                    active
                      ? "border-orange-400/70 bg-orange-500/20 text-orange-50 shadow-[0_0_18px_rgba(249,115,22,0.16)]"
                      : "border-border bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground disabled:hover:bg-white/[0.02] disabled:hover:text-muted-foreground",
                  )}
                >
                  <span className="line-clamp-2 text-sm font-semibold leading-tight">
                    {option}
                  </span>
                  <span className="flex min-h-4 items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {robotActive ? (
                      <>
                        <CircleDot className="size-3 text-emerald-300" />
                        Active
                      </>
                    ) : isDefault ? (
                      "Default"
                    ) : (
                      "\u00a0"
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
