import { StatusReadout } from "./StatusReadout";
import { SimControls } from "./SimControls";
import { OperationsPanel } from "./OperationsPanel";
import { MatchTimer } from "./MatchTimer";
import { ConsolePanel } from "./ConsolePanel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { UseHalSimReturn, DsMode } from "@/hooks/useHalSim";
import type { RunStatus, RunConnection } from "@/hooks/useRunChannel";

interface DriverStationProps {
  halSim: UseHalSimReturn;
  runStatus: RunStatus;
  runConnection: RunConnection;
  sessionReady: boolean;
  consoleLines: string[];
  onStartRun: () => void;
  onStopRun: () => void;
}

const MODE_PILL_CLASSES: Record<DsMode, string> = {
  teleop: "bg-blue-600/20 text-blue-400",
  auto: "bg-orange-600/20 text-orange-400",
  test: "bg-purple-600/20 text-purple-400",
};

export function DriverStation({
  halSim,
  runStatus,
  runConnection,
  sessionReady,
  consoleLines,
  onStartRun,
  onStopRun,
}: DriverStationProps) {
  // Enable is only allowed when sim is running and HALSim is connected
  const canEnable =
    halSim.connected && runStatus === "running" && !halSim.eStopped;

  const handleStopRun = () => {
    // Safety: disable before stopping
    if (halSim.enabled) {
      halSim.setEnabled(false);
    }
    onStopRun();
  };

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-border bg-card">
      {/* Controls strip */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
        <StatusReadout
          halSimConnection={halSim.connection}
          runStatus={runStatus}
          runConnection={runConnection}
        />

        <Separator orientation="vertical" className="h-8" />

        <OperationsPanel
          enabled={halSim.enabled}
          mode={halSim.mode}
          eStopped={halSim.eStopped}
          canEnable={canEnable}
          onSetEnabled={halSim.setEnabled}
          onSetMode={halSim.setMode}
          onSetEStop={halSim.setEStop}
        />

        <Separator orientation="vertical" className="h-8" />

        <MatchTimer
          alliance={halSim.alliance}
          onSetAlliance={halSim.setAlliance}
        />

        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant="secondary"
            className={MODE_PILL_CLASSES[halSim.mode]}
          >
            {halSim.enabled ? halSim.mode.toUpperCase() : "DISABLED"}
          </Badge>

          <SimControls
            runStatus={runStatus}
            sessionReady={sessionReady}
            onStart={onStartRun}
            onStop={handleStopRun}
          />
        </div>
      </div>

      {/* Console */}
      <ConsolePanel lines={consoleLines} />
    </section>
  );
}
