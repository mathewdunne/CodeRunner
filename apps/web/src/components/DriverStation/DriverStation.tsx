import { useState } from "react";
import { ConsolePanel } from "./ConsolePanel";
import { IconRail, type RailTab } from "./IconRail";
import { WorkbenchPanel } from "./WorkbenchPanel";
import type { RunStatus } from "@/hooks/useRunChannel";

interface DriverStationProps {
  runStatus: RunStatus;
  sessionReady: boolean;
  consoleLines: string[];
  onStartRun: () => void;
  onStopRun: () => void;
}

export function DriverStation({
  runStatus,
  sessionReady,
  consoleLines,
  onStartRun,
  onStopRun,
}: DriverStationProps) {
  const [railTab, setRailTab] = useState<RailTab>("console");

  const handleRestartRun = () => {
    onStopRun();
    window.setTimeout(onStartRun, 500);
  };

  return (
    <section className="flex h-full min-h-0 overflow-hidden border-t border-border bg-background">
      <IconRail active={railTab} onSelect={setRailTab} />
      <WorkbenchPanel
        runStatus={runStatus}
        sessionReady={sessionReady}
        onStartRun={onStartRun}
        onStopRun={onStopRun}
        onRestartRun={handleRestartRun}
      />
      <ConsolePanel robotLines={consoleLines} />
    </section>
  );
}
