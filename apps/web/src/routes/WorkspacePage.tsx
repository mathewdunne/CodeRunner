import { useRef, useMemo } from "react";
import { useParams } from "react-router";
import { isWorkspaceSlug } from "@/lib/contracts";
import { useSession } from "@/hooks/useSession";
import { useRunChannel } from "@/hooks/useRunChannel";
import { useContainerStatus } from "@/hooks/useContainerStatus";
import { useEditorReachability } from "@/hooks/useEditorReachability";
import { useScopeHandshake } from "@/hooks/useScopeHandshake";
import { useHalSim } from "@/hooks/useHalSim";
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
  const { runStatus, connection, consoleLines, startRun, stopRun } =
    useRunChannel(workspaceSlug);
  const containerStatus = useContainerStatus(workspaceSlug);
  const halSim = useHalSim(workspaceSlug);
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

  const sessionReady = sessionState.status === "ready";
  const errorMessage =
    sessionState.status === "error" ? sessionState.message : undefined;

  return (
    <div className="flex h-screen flex-col bg-background">
      <Topbar
        displayName={displayName}
        workspaceSlug={workspaceSlug}
        editorStatus={editorStatus}
        containerStatus={containerStatus}
        runStatus={runStatus}
        runConnection={connection}
        scopeStatus={scopeStatus}
        halSimConnection={halSim.connection}
        sessionReady={sessionReady}
        onStartRun={startRun}
        onStopRun={stopRun}
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
            halSim={halSim}
            runStatus={runStatus}
            runConnection={connection}
            sessionReady={sessionReady}
            consoleLines={consoleLines}
            onStartRun={startRun}
            onStopRun={stopRun}
          />
        }
      />
    </div>
  );
}
