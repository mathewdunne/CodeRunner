import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DsMode } from "@/hooks/useHalSim";

interface OperationsPanelProps {
  enabled: boolean;
  mode: DsMode;
  eStopped: boolean;
  canEnable: boolean;
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
  teleop: "bg-blue-600 text-white border-blue-500 hover:bg-blue-500",
  auto: "bg-orange-600 text-white border-orange-500 hover:bg-orange-500",
  test: "bg-purple-600 text-white border-purple-500 hover:bg-purple-500",
};

export function OperationsPanel({
  enabled,
  mode,
  eStopped,
  canEnable,
  onSetEnabled,
  onSetMode,
  onSetEStop,
}: OperationsPanelProps) {
  const handleModeChange = (newMode: DsMode) => {
    if (newMode === mode) return;
    // Safety: switching modes while enabled → disable first
    if (enabled) {
      onSetEnabled(false);
    }
    onSetMode(newMode);
  };

  return (
    <div className="flex items-center gap-3">
      {/* Enable / Disable */}
      <div className="flex gap-1.5">
        <Button
          onClick={() => onSetEnabled(true)}
          disabled={!canEnable || eStopped || enabled}
          className={cn(
            "h-10 min-w-[72px] font-semibold transition-all",
            enabled
              ? "bg-emerald-600 text-white hover:bg-emerald-500 shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]"
              : "bg-muted text-foreground hover:bg-muted/80",
          )}
        >
          Enable
        </Button>
        <Button
          onClick={() => onSetEnabled(false)}
          disabled={!enabled && !eStopped}
          className={cn(
            "h-10 min-w-[72px] font-semibold transition-all",
            !enabled
              ? "bg-red-700 text-white hover:bg-red-600 shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]"
              : "bg-muted text-foreground hover:bg-muted/80",
          )}
        >
          Disable
        </Button>
      </div>

      {/* Mode select */}
      <div className="flex gap-1">
        {(["teleop", "auto", "test"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant="outline"
            onClick={() => handleModeChange(m)}
            className={cn(
              "min-w-[60px] text-xs font-medium transition-all",
              mode === m ? MODE_ACTIVE_CLASSES[m] : "",
            )}
          >
            {MODE_LABELS[m]}
          </Button>
        ))}
      </div>

      {/* E-Stop */}
      <Button
        variant="destructive"
        size="sm"
        onClick={() => onSetEStop(!eStopped)}
        className={cn(
          "min-w-[60px] font-bold",
          eStopped && "ring-2 ring-red-400 ring-offset-1 ring-offset-background",
        )}
      >
        {eStopped ? "Reset" : "E-Stop"}
      </Button>
    </div>
  );
}
