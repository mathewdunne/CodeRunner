import { useMemo } from "react";
import { StatusReadout } from "./StatusReadout";
import { SimControls } from "./SimControls";
import { OperationsPanel } from "./OperationsPanel";
import { MatchTimer } from "./MatchTimer";
import { ConsolePanel } from "./ConsolePanel";
import { JoystickPanel } from "./JoystickPanel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { UseHalSimReturn, DsMode } from "@/hooks/useHalSim";
import type { RunStatus, RunConnection } from "@/hooks/useRunChannel";

interface DriverStationProps {
  halSim: UseHalSimReturn;
  runStatus: RunStatus;
  runConnection: RunConnection;
  containerRunning: boolean;
  sessionReady: boolean;
  consoleLines: string[];
  onStartRun: () => void;
  onStopRun: () => void;
}

const MODE_PILL_CLASSES: Record<DsMode, string> = {
  teleop: "border-blue-500/30 bg-blue-500/15 text-blue-200",
  auto: "border-orange-500/30 bg-orange-500/15 text-orange-200",
  test: "border-purple-500/30 bg-purple-500/15 text-purple-200",
};

const MODE_LABELS: Record<DsMode, string> = {
  teleop: "TELEOP",
  auto: "AUTO",
  test: "TEST",
};

const ALLIANCE_LABELS: Record<UseHalSimReturn["alliance"], string> = {
  red1: "Red 1",
  red2: "Red 2",
  red3: "Red 3",
  blue1: "Blue 1",
  blue2: "Blue 2",
  blue3: "Blue 3",
};

export function DriverStation({
  halSim,
  runStatus,
  runConnection,
  containerRunning,
  sessionReady,
  consoleLines,
  onStartRun,
  onStopRun,
}: DriverStationProps) {
  const canControl =
    sessionReady &&
    containerRunning &&
    runStatus === "running" &&
    halSim.connected;
  const canEnable = canControl && !halSim.eStopped;
  const canChangeMode = canControl && !halSim.eStopped;

  const handleStopRun = () => {
    if (halSim.enabled) {
      halSim.setEnabled(false);
    }
    onStopRun();
  };

  const handleRestartRun = () => {
    handleStopRun();
    window.setTimeout(onStartRun, 500);
  };

  const driverStateLabel = halSim.eStopped
    ? "E-STOP"
    : halSim.enabled
      ? MODE_LABELS[halSim.mode]
      : "DISABLED";

  const driverStateClass = halSim.eStopped
    ? "border-red-500/40 bg-red-500/20 text-red-100"
    : halSim.enabled
      ? MODE_PILL_CLASSES[halSim.mode]
      : "border-border bg-muted/70 text-muted-foreground";

  const dsLogLines = useMemo(
    () => [
      `Robot Code: ${runStatus}`,
      `HALSim Comms: ${halSim.connection}`,
      `Driver Station: ${driverStateLabel}`,
      `Alliance: ${ALLIANCE_LABELS[halSim.alliance]}`,
      `Run Channel: ${runConnection}`,
    ],
    [
      driverStateLabel,
      halSim.alliance,
      halSim.connection,
      runConnection,
      runStatus,
    ],
  );

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background/35 px-3 py-2">
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
          canChangeMode={canChangeMode}
          onSetEnabled={halSim.setEnabled}
          onSetMode={halSim.setMode}
          onSetEStop={halSim.setEStop}
        />

        <Separator orientation="vertical" className="h-8" />

        <MatchTimer
          alliance={halSim.alliance}
          onSetAlliance={halSim.setAlliance}
        />

        <JoystickPanel />

        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn("h-6 min-w-[86px] rounded-md font-semibold", driverStateClass)}
          >
            {driverStateLabel}
          </Badge>

          <SimControls
            runStatus={runStatus}
            sessionReady={sessionReady}
            onStart={onStartRun}
            onStop={handleStopRun}
            onRestart={handleRestartRun}
          />
        </div>
      </div>

      <ConsolePanel robotLines={consoleLines} dsLines={dsLogLines} />
    </section>
  );
}
