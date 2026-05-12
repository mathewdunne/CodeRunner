import { useRef, useMemo, useEffect, useCallback } from "react";
import { useParams } from "react-router";
import { isWorkspaceSlug } from "@/lib/contracts";
import { useSession } from "@/hooks/useSession";
import { useRunChannel } from "@/hooks/useRunChannel";
import { useSimulationState } from "@/hooks/useSimulationState";
import { useAutoChoosers } from "@/hooks/useAutoChoosers";
import { useEditorReachability } from "@/hooks/useEditorReachability";
import { useScopeHandshake } from "@/hooks/useScopeHandshake";
import { useGamepad, type GamepadInfo } from "@/hooks/useGamepad";
import { useGamepadChannel } from "@/hooks/useGamepadChannel";
import { gamepadFrameToWpilib } from "@/lib/gamepad-mapping";
import { Topbar } from "@/components/Topbar";
import { IDELayout } from "@/components/IDELayout";
import { EditorPane } from "@/components/EditorPane";
import { ScopePane } from "@/components/ScopePane";
import { DriverStation } from "@/components/DriverStation";

export function WorkspacePage() {
  const { slug } = useParams<{ slug: string }>();
  const workspaceSlug = useMemo(
    () => (slug && isWorkspaceSlug(slug) ? slug : null),
    [slug],
  );

  const sessionState = useSession(workspaceSlug);
  const { connection: runConnection, consoleLines } =
    useRunChannel(workspaceSlug);
  const simulation = useSimulationState(workspaceSlug);
  const autoChoosers = useAutoChoosers(workspaceSlug);
  const editorUrl = workspaceSlug
    ? `/u/${workspaceSlug}/vscode/?folder=/workspace/project`
    : null;
  const editorStatus = useEditorReachability(editorUrl);
  const scopeFrameRef = useRef<HTMLIFrameElement>(null);
  useScopeHandshake(workspaceSlug, scopeFrameRef);

  const gamepad = useGamepad();
  const channel = useGamepadChannel(workspaceSlug);

  // Bridge: when a gamepad frame arrives, ship the WPILib-mapped state to
  // the channel. pushState handles its own throttle / heartbeat / diffing,
  // so we can call it on every frame without burning bandwidth.
  useEffect(() => {
    if (!gamepad.frame || gamepad.selectedIndex === null) return;
    channel.pushState(gamepadFrameToWpilib(gamepad.frame));
  }, [gamepad.frame, gamepad.selectedIndex, channel]);

  const onSelectGamepad = useCallback(
    (info: GamepadInfo) => {
      gamepad.selectGamepad(info.index);
      channel.select(info.id, info.label);
    },
    [gamepad, channel],
  );

  const onReleaseGamepad = useCallback(() => {
    gamepad.selectGamepad(null);
    channel.release();
  }, [gamepad, channel]);

  // Safety: if the selected gamepad disappears (useGamepad clears
  // selectedIndex), tell the server to release.
  const lastSelectedRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastSelectedRef.current !== null && gamepad.selectedIndex === null) {
      channel.release();
    }
    lastSelectedRef.current = gamepad.selectedIndex;
  }, [gamepad.selectedIndex, channel]);

  const displayName =
    sessionState.status === "ready"
      ? sessionState.session.user.displayName
      : "Loading";
  const email =
    sessionState.status === "ready" ? sessionState.session.user.email : "";
  const isAdmin =
    sessionState.status === "ready" && sessionState.session.user.role === "admin";

  const sessionReady = sessionState.status === "ready";
  const errorMessage =
    sessionState.status === "error" ? sessionState.message : undefined;

  return (
    <div className="flex h-screen flex-col bg-background">
      <Topbar
        displayName={displayName}
        email={email}
        isAdmin={isAdmin}
        workspaceSlug={workspaceSlug}
      />
      <IDELayout
        editor={
          <EditorPane
            editorUrl={editorUrl}
            editorStatus={editorStatus}
            errorMessage={errorMessage}
          />
        }
        scope={
          <ScopePane ref={scopeFrameRef} />
        }
        driverStation={
          <DriverStation
            simulationStatus={simulation.status}
            runStatus={simulation.runStatus}
            runConnection={runConnection}
            sessionReady={sessionReady}
            consoleLines={consoleLines}
            autoStatus={autoChoosers.status}
            gamepad={{
              available: gamepad.available,
              selectedIndex: gamepad.selectedIndex,
              frame: gamepad.frame,
              channelConnection: channel.connection,
              channelHalsimDisconnected: channel.halsimDisconnected,
              onSelect: onSelectGamepad,
              onRelease: onReleaseGamepad,
            }}
            onStartRun={simulation.startRun}
            onStopRun={simulation.stopRun}
            onRestartRun={simulation.restartRun}
            onSetDriverStation={simulation.setDriverStation}
            onSelectAuto={autoChoosers.selectAuto}
          />
        }
      />
    </div>
  );
}
