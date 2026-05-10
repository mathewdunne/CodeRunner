import { Button } from "@/components/ui/button";
import type { RunStatus } from "@/hooks/useRunChannel";

interface RunControlsProps {
  runStatus: RunStatus;
  sessionReady: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function RunControls({
  runStatus,
  sessionReady,
  onStart,
  onStop,
}: RunControlsProps) {
  const runBusy = ["building", "running", "stopping"].includes(runStatus);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="default"
        onClick={onStart}
        disabled={runBusy || !sessionReady}
        className="bg-emerald-700 text-white hover:bg-emerald-600"
      >
        Run
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={onStop}
        disabled={!runBusy}
      >
        Stop
      </Button>
    </div>
  );
}
