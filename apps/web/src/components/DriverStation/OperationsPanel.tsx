import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Power, OctagonAlert } from "lucide-react";
import type { DsMode } from "@/hooks/useHalSim";

interface OperationsPanelProps {
  enabled: boolean;
  mode: DsMode;
  eStopped: boolean;
  canEnable: boolean;
  canChangeMode: boolean;
  onSetEnabled: (value: boolean) => void;
  onSetMode: (mode: DsMode) => void;
  onSetEStop: (value: boolean) => void;
}

const MODE_LABELS: Record<DsMode, string> = {
  teleop: "Teleop",
  auto: "Auto",
  test: "Test",
};

const MODE_ACTIVE_CLASSES: Record<DsMode, string> = {
  teleop: "data-active:border-blue-500/40 data-active:bg-blue-500/20 data-active:text-blue-100",
  auto: "data-active:border-orange-500/40 data-active:bg-orange-500/20 data-active:text-orange-100",
  test: "data-active:border-purple-500/40 data-active:bg-purple-500/20 data-active:text-purple-100",
};

export function OperationsPanel({
  enabled,
  mode,
  eStopped,
  canEnable,
  canChangeMode,
  onSetEnabled,
  onSetMode,
  onSetEStop,
}: OperationsPanelProps) {
  const handleModeChange = (value: string | number) => {
    const newMode = value as DsMode;
    if (newMode === mode) return;
    if (enabled) {
      onSetEnabled(false);
    }
    onSetMode(newMode);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1.5">
        <Button
          onClick={() => onSetEnabled(true)}
          disabled={!canEnable || eStopped || enabled}
          className={cn(
            "h-9 min-w-[92px] gap-2 rounded-md font-semibold transition-all",
            enabled
              ? "border-emerald-500/50 bg-emerald-600 text-white shadow-[inset_0_0_12px_rgba(0,0,0,0.28)] hover:bg-emerald-500"
              : "border-emerald-500/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25",
          )}
        >
          <Power className="size-4" />
          Enable
        </Button>
        <Button
          onClick={() => onSetEnabled(false)}
          variant="outline"
          className={cn(
            "h-9 min-w-[82px] rounded-md font-semibold transition-all",
            !enabled
              ? "border-red-500/40 text-red-200 hover:bg-red-500/15"
              : "border-red-500/50 bg-red-500/15 text-red-100 hover:bg-red-500/25",
          )}
        >
          Disable
        </Button>
      </div>

      <Tabs
        value={mode}
        onValueChange={handleModeChange}
        className="gap-0"
      >
        <TabsList className="h-8 rounded-md bg-muted/60">
        {(["teleop", "auto", "test"] as const).map((m) => (
          <TabsTrigger
            key={m}
            value={m}
            disabled={!canChangeMode}
            className={cn(
              "min-w-[64px] rounded-sm text-xs",
              MODE_ACTIVE_CLASSES[m],
            )}
          >
            {MODE_LABELS[m]}
          </TabsTrigger>
        ))}
        </TabsList>
      </Tabs>

      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          if (!eStopped && enabled) {
            onSetEnabled(false);
          }
          onSetEStop(!eStopped);
        }}
        className={cn(
          "h-8 min-w-[74px] gap-1.5 rounded-md font-bold",
          eStopped && "bg-red-500/25 text-red-100 ring-2 ring-red-400/70",
        )}
      >
        <OctagonAlert className="size-3.5" />
        {eStopped ? "Reset" : "E-Stop"}
      </Button>
    </div>
  );
}
