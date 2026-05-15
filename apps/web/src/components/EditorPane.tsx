import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { EditorStatus } from "@/hooks/useEditorReachability";

interface EditorPaneProps {
  editorUrl: string | null;
  editorStatus: EditorStatus;
  errorMessage?: string;
}

export function EditorPane({
  editorUrl,
  editorStatus,
  errorMessage,
}: EditorPaneProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const editorReachable = editorStatus === "reachable";

  useEffect(() => {
    setIframeLoaded(false);
  }, [editorUrl]);

  const handleLoad = useCallback(() => setIframeLoaded(true), []);

  if (!editorUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card font-mono text-sm text-muted-foreground">
        {errorMessage ?? "Loading editor..."}
      </div>
    );
  }

  const showOverlay = !editorReachable || !iframeLoaded;

  return (
    <div className="relative h-full w-full">
      {editorReachable && (
        <iframe
          title="VS Code Editor"
          data-pane="editor"
          src={editorUrl}
          allow="clipboard-read; clipboard-write"
          className="h-full w-full border-0"
          onLoad={handleLoad}
        />
      )}
      {showOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <span className="font-mono text-sm text-muted-foreground">
            Loading VS Code…
          </span>
        </div>
      )}
    </div>
  );
}
