import { useState } from "react";
import { ConsolePanel } from "./ConsolePanel";
import { IconRail, type RailTab } from "./IconRail";
import { WorkbenchPanel } from "./WorkbenchPanel";
import type { RunConnection } from "@/hooks/useRunChannel";
import type { DriverStationPatch, SimRunStatus, SimStatusResponse } from "@/lib/contracts";

interface DriverStationProps {
  simulationStatus: SimStatusResponse | null;
  runStatus: SimRunStatus;
  runConnection: RunConnection;
  sessionReady: boolean;
  consoleLines: string[];
  onStartRun: () => void;
  onStopRun: () => void;
  onRestartRun: () => void;
  onSetDriverStation: (patch: DriverStationPatch) => void;
}

export function DriverStation({
  simulationStatus,
  runStatus,
  runConnection,
  sessionReady,
  consoleLines,
  onStartRun,
  onStopRun,
  onRestartRun,
  onSetDriverStation,
}: DriverStationProps) {
  const [railTab, setRailTab] = useState<RailTab>("console");

  return (
    <section className="flex h-full min-h-0 overflow-hidden border-t border-border bg-background">
      <IconRail active={railTab} onSelect={setRailTab} />
      <WorkbenchPanel
        runStatus={runStatus}
        sessionReady={sessionReady}
        simulationStatus={simulationStatus}
        runConnection={runConnection}
        onStartRun={onStartRun}
        onStopRun={onStopRun}
        onRestartRun={onRestartRun}
        onSetDriverStation={onSetDriverStation}
      />
      <ConsolePanel robotLines={consoleLines} runStatus={runStatus} />
    </section>
  );
}
