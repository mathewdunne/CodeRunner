import { useRef, useMemo } from "react";
import { useParams } from "react-router";
import { isWorkspaceSlug } from "@/lib/contracts";
import { useSession } from "@/hooks/useSession";
import { useRunChannel } from "@/hooks/useRunChannel";
import { useSimulationState } from "@/hooks/useSimulationState";
import { useAutoChoosers } from "@/hooks/useAutoChoosers";
import { useEditorReachability } from "@/hooks/useEditorReachability";
import { useScopeHandshake } from "@/hooks/useScopeHandshake";
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
  const scopeStatus = useScopeHandshake(workspaceSlug, scopeFrameRef);

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
          <ScopePane ref={scopeFrameRef} scopeStatus={scopeStatus} />
        }
        driverStation={
          <DriverStation
            simulationStatus={simulation.status}
            runStatus={simulation.runStatus}
            runConnection={runConnection}
            sessionReady={sessionReady}
            consoleLines={consoleLines}
            autoStatus={autoChoosers.status}
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
