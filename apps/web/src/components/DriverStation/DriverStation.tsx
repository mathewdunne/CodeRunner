import { useState } from "react";
import { AutoPanel } from "./AutoPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ControlsPanel } from "./ControlsPanel";
import { IconRail, type RailTab } from "./IconRail";
import { WorkbenchPanel } from "./WorkbenchPanel";
import type { RunConnection } from "@/hooks/useRunChannel";
import type { GamepadFrame, GamepadInfo } from "@/hooks/useGamepad";
import type { GamepadChannelConnection } from "@/hooks/useGamepadChannel";
import type { AutoChooserPatch, AutoChoosersResponse, DriverStationPatch, SimRunStatus, SimStatusResponse } from "@/lib/contracts";

interface DriverStationProps {
  simulationStatus: SimStatusResponse | null;
  runStatus: SimRunStatus;
  runConnection: RunConnection;
  sessionReady: boolean;
  consoleLines: string[];
  autoStatus: AutoChoosersResponse | null;
  gamepad: {
    available: GamepadInfo[];
    selectedIndex: number | null;
    frame: GamepadFrame | null;
    channelConnection: GamepadChannelConnection;
    channelHalsimDisconnected: boolean;
    onSelect: (info: GamepadInfo) => void;
    onRelease: () => void;
  };
  onStartRun: () => void;
  onStopRun: () => void;
  onRestartRun: () => void;
  onSetDriverStation: (patch: DriverStationPatch) => void;
  onSelectAuto: (patch: AutoChooserPatch) => void;
}

export function DriverStation({
  simulationStatus,
  runStatus,
  runConnection,
  sessionReady,
  consoleLines,
  autoStatus,
  gamepad,
  onStartRun,
  onStopRun,
  onRestartRun,
  onSetDriverStation,
  onSelectAuto,
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
      {railTab === "auto" ? (
        <AutoPanel
          autoStatus={autoStatus}
          runStatus={runStatus}
          sessionReady={sessionReady}
          onSelectAuto={onSelectAuto}
        />
      ) : railTab === "controls" ? (
        <ControlsPanel
          available={gamepad.available}
          selectedIndex={gamepad.selectedIndex}
          frame={gamepad.frame}
          runStatus={runStatus}
          simulationStatus={simulationStatus}
          channelConnection={gamepad.channelConnection}
          channelHalsimDisconnected={gamepad.channelHalsimDisconnected}
          onSelect={gamepad.onSelect}
          onRelease={gamepad.onRelease}
        />
      ) : (
        <ConsolePanel robotLines={consoleLines} runStatus={runStatus} />
      )}
    </section>
  );
}
