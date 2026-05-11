import { SimControlsBlock } from "./SimControlsBlock";
import { StatusTileRow } from "./StatusTile";
import { ModeColumn } from "./ModeColumn";
import { EnableDisableRow } from "./EnableDisableRow";
import type { RunStatus } from "@/hooks/useRunChannel";

interface WorkbenchPanelProps {
  runStatus: RunStatus;
  sessionReady: boolean;
  onStartRun: () => void;
  onStopRun: () => void;
  onRestartRun: () => void;
}

export function WorkbenchPanel({
  runStatus,
  sessionReady,
  onStartRun,
  onStopRun,
  onRestartRun,
}: WorkbenchPanelProps) {
  return (
    <div
      className="grid h-full min-h-0 w-[560px] shrink-0 overflow-hidden gap-2.5 border-r border-border p-3"
      style={{
        gridTemplateColumns: "1fr 130px",
        gridTemplateRows: "minmax(86px, 1fr) minmax(92px, 1.35fr) minmax(68px, 1fr)",
      }}
    >
      {/* Row 1, col 1: Sim controls */}
      <div className="min-h-0">
        <SimControlsBlock
          runStatus={runStatus}
          sessionReady={sessionReady}
          onStart={onStartRun}
          onStop={onStopRun}
          onRestart={onRestartRun}
        />
      </div>

      {/* Right column spans rows 1+2: Mode */}
      <div className="row-span-2 min-h-0">
        <ModeColumn />
      </div>

      {/* Row 2, col 1: Status tiles */}
      <div className="min-h-0">
        <StatusTileRow />
      </div>

      {/* Row 3 spans both columns: Enable / Disable */}
      <div className="col-span-2 min-h-0">
        <EnableDisableRow />
      </div>
    </div>
  );
}
