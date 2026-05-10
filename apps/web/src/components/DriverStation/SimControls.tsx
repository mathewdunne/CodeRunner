import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Play, Square, RotateCcw } from "lucide-react";
import type { RunStatus } from "@/hooks/useRunChannel";

interface SimControlsProps {
  runStatus: RunStatus;
  sessionReady: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function SimControls({ runStatus, sessionReady, onStart, onStop }: SimControlsProps) {
  const runBusy = ["building", "running", "stopping"].includes(runStatus);

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              onClick={onStart}
              disabled={runBusy || !sessionReady}
              className="text-emerald-500 hover:text-emerald-400"
            >
              <Play className="size-4" />
            </Button>
          }
        />
        <TooltipContent>Start Sim</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              onClick={onStop}
              disabled={!runBusy}
              className="text-red-500 hover:text-red-400"
            >
              <Square className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>Stop Sim</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => {
                onStop();
                setTimeout(onStart, 500);
              }}
              disabled={!runBusy || !sessionReady}
              className="text-amber-500 hover:text-amber-400"
            >
              <RotateCcw className="size-4" />
            </Button>
          }
        />
        <TooltipContent>Restart Sim</TooltipContent>
      </Tooltip>
    </div>
  );
}
