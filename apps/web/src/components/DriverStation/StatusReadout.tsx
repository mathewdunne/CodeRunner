import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { HalSimConnection } from "@/hooks/useHalSim";
import type { RunStatus, RunConnection } from "@/hooks/useRunChannel";

interface StatusReadoutProps {
  halSimConnection: HalSimConnection;
  runStatus: RunStatus;
  runConnection: RunConnection;
}

type LedColor = "green" | "red" | "amber";

function ledColor(ok: boolean, warning = false): LedColor {
  if (ok) return "green";
  if (warning) return "amber";
  return "red";
}

const LED_CLASSES: Record<LedColor, string> = {
  green: "bg-emerald-500 shadow-[0_0_6px_theme(colors.emerald.500/50%)]",
  amber: "bg-amber-500 shadow-[0_0_6px_theme(colors.amber.500/50%)]",
  red: "bg-red-500 shadow-[0_0_6px_theme(colors.red.500/50%)]",
};

function Led({
  color,
  label,
  tooltip,
}: {
  color: LedColor;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted/30 px-2">
            <div className={`size-2.5 rounded-full ${LED_CLASSES[color]}`} />
            <span className="whitespace-nowrap text-xs text-muted-foreground">{label}</span>
          </div>
        }
      />
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function StatusReadout({ halSimConnection, runStatus, runConnection }: StatusReadoutProps) {
  const commsColor = ledColor(
    halSimConnection === "connected" && runConnection === "connected",
    halSimConnection === "reconnecting" || runConnection === "reconnecting",
  );
  const robotCodeColor = ledColor(
    runStatus === "running",
    runStatus === "building" || runStatus === "stopping" || runStatus === "connecting",
  );

  return (
    <div className="grid grid-cols-3 gap-1.5">
      <Led
        color={robotCodeColor}
        label="Robot Code"
        tooltip={`Sim process: ${runStatus}`}
      />
      <Led
        color={commsColor}
        label="Comms"
        tooltip={`HALSim: ${halSimConnection}; run channel: ${runConnection}`}
      />
      <Led
        color="amber"
        label="Joysticks"
        tooltip="No controller connected"
      />
    </div>
  );
}
