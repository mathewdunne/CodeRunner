import { Badge } from "@/components/ui/badge";
import type { ContainersStatusResponse } from "@/lib/contracts";
import type { RunConnection, RunStatus } from "@/hooks/useRunChannel";
import type { EditorStatus } from "@/hooks/useEditorReachability";
import type { ScopeStatus } from "@/hooks/useScopeHandshake";

interface StatusStripProps {
  workspaceSlug: string | null;
  editorStatus: EditorStatus;
  containerStatus: ContainersStatusResponse | null;
  runStatus: RunStatus;
  runConnection: RunConnection;
  scopeStatus: ScopeStatus;
}

function pillVariant(
  ok: boolean,
): "default" | "secondary" | "destructive" | "outline" {
  return ok ? "secondary" : "destructive";
}

export function StatusStrip({
  workspaceSlug,
  editorStatus,
  containerStatus,
  runStatus,
  runConnection,
  scopeStatus,
}: StatusStripProps) {
  const simLabel = !containerStatus
    ? "Sim pending"
    : containerStatus.code.state === "error"
      ? "Sim error"
      : `Sim ${containerStatus.code.state}`;

  const runLabel =
    runConnection === "reconnecting"
      ? "Run reconnecting"
      : `Run ${runStatus}`;

  const scopeLabel =
    scopeStatus === "connected"
      ? "Scope connected"
      : scopeStatus === "timeout"
        ? "Scope timeout"
        : "Scope connecting";

  const editorLabel =
    editorStatus === "reachable"
      ? "Editor ready"
      : editorStatus === "error"
        ? "Editor error"
        : "Editor loading";

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <Badge variant="secondary">
        Workspace {workspaceSlug ?? "unknown"}
      </Badge>
      <Badge variant={pillVariant(editorStatus !== "error")}>
        {editorLabel}
      </Badge>
      <Badge
        variant={pillVariant(
          containerStatus?.code.state !== "error",
        )}
      >
        {simLabel}
      </Badge>
      <Badge
        variant={pillVariant(
          runStatus !== "error" && runConnection !== "reconnecting",
        )}
      >
        {runLabel}
      </Badge>
      <Badge variant={pillVariant(scopeStatus !== "timeout")}>
        {scopeLabel}
      </Badge>
    </div>
  );
}
