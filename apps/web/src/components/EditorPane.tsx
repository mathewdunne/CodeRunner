import type { EditorStatus } from "@/hooks/useEditorReachability";

interface EditorPaneProps {
  editorUrl: string | null;
  editorStatus: EditorStatus;
  errorMessage?: string;
}

export function EditorPane({
  editorUrl,
  errorMessage,
}: EditorPaneProps) {
  if (!editorUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card font-mono text-sm text-muted-foreground">
        {errorMessage ?? "Loading editor..."}
      </div>
    );
  }

  return (
    <iframe
      title="VS Code Editor"
      src={editorUrl}
      allow="clipboard-read; clipboard-write"
      className="h-full w-full border-0"
    />
  );
}
