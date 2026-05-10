import { Button } from "@/components/ui/button";
import { StatusStrip } from "@/components/StatusStrip";
import { RunControls } from "@/components/RunControls";
import type { ContainersStatusResponse } from "@/lib/contracts";
import type { RunConnection, RunStatus } from "@/hooks/useRunChannel";
import type { EditorStatus } from "@/hooks/useEditorReachability";
import type { ScopeStatus } from "@/hooks/useScopeHandshake";

interface TopbarProps {
  displayName: string;
  workspaceSlug: string | null;
  editorStatus: EditorStatus;
  containerStatus: ContainersStatusResponse | null;
  runStatus: RunStatus;
  runConnection: RunConnection;
  scopeStatus: ScopeStatus;
  sessionReady: boolean;
  onStartRun: () => void;
  onStopRun: () => void;
}

export function Topbar({
  displayName,
  workspaceSlug,
  editorStatus,
  containerStatus,
  runStatus,
  runConnection,
  scopeStatus,
  sessionReady,
  onStartRun,
  onStopRun,
}: TopbarProps) {
  return (
    <header className="flex h-[52px] items-center gap-3 border-b border-border px-3.5">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <strong className="whitespace-nowrap text-sm font-semibold">
          FRC Web Simulator
        </strong>
        <span className="truncate text-xs text-muted-foreground">
          {displayName}
        </span>
      </div>

      <StatusStrip
        workspaceSlug={workspaceSlug}
        editorStatus={editorStatus}
        containerStatus={containerStatus}
        runStatus={runStatus}
        runConnection={runConnection}
        scopeStatus={scopeStatus}
      />

      <div className="ml-auto flex items-center gap-2">
        <RunControls
          runStatus={runStatus}
          sessionReady={sessionReady}
          onStart={onStartRun}
          onStop={onStopRun}
        />
        <form method="post" action="/logout">
          <Button type="submit" variant="outline" size="sm">
            Logout
          </Button>
        </form>
      </div>
    </header>
  );
}
