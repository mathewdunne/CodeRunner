import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { useImport } from "@/hooks/useImport";

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importHook: ReturnType<typeof useImport>;
}

type Step = "form" | "confirm" | "progress";

export function ImportDialog({ open, onOpenChange, importHook }: ImportDialogProps) {
  const { state, startImport, reset, recentImports, loadRecentImports, restoreBackup } = importHook;
  const [step, setStep] = useState<Step>("form");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [subdir, setSubdir] = useState("");
  const [backup, setBackup] = useState(true);
  const [urlError, setUrlError] = useState("");
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      void loadRecentImports();
    }
  }, [open, loadRecentImports]);

  // Transition to progress step when import starts
  useEffect(() => {
    if (state.status === "connecting" || state.status === "importing") {
      setStep("progress");
    }
  }, [state.status]);

  const handleClose = useCallback(() => {
    if (state.status === "importing" || state.status === "connecting") {
      return; // Don't close while importing
    }
    setStep("form");
    setUrl("");
    setBranch("");
    setSubdir("");
    setBackup(true);
    setUrlError("");
    setRestoreStatus(null);
    reset();
    onOpenChange(false);
  }, [state.status, reset, onOpenChange]);

  const validateUrl = useCallback((value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setUrlError("URL is required.");
      return false;
    }
    if (/^git@/i.test(trimmed)) {
      setUrlError("SSH URLs are not supported. Use an HTTPS GitHub URL.");
      return false;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname !== "github.com") {
        setUrlError("Only GitHub URLs are supported.");
        return false;
      }
    } catch {
      setUrlError("Invalid URL format.");
      return false;
    }
    setUrlError("");
    return true;
  }, []);

  const handleSubmit = useCallback(() => {
    if (!validateUrl(url)) return;
    setStep("confirm");
  }, [url, validateUrl]);

  const handleConfirm = useCallback(() => {
    startImport({
      url: url.trim(),
      branch: branch.trim() || undefined,
      subdir: subdir.trim() || undefined,
      backup,
    });
  }, [url, branch, subdir, backup, startImport]);

  const handleRestore = useCallback(async (archiveFile: string) => {
    setRestoreStatus("Restoring…");
    const result = await restoreBackup(archiveFile);
    if (result.ok) {
      setRestoreStatus("Restored successfully. Refresh your editor.");
    } else {
      setRestoreStatus(`Restore failed: ${result.error}`);
    }
  }, [restoreBackup]);

  const repoName = (() => {
    try {
      const match = /github\.com\/([^/]+\/[^/]+)/i.exec(url.trim());
      return match ? match[1]?.replace(/\.git$/, "") : url.trim();
    } catch {
      return url.trim();
    }
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={state.status !== "importing"}>
        {step === "form" && (
          <>
            <DialogHeader>
              <DialogTitle>Import from GitHub</DialogTitle>
              <DialogDescription>
                Import a public GitHub repository as a snapshot. This replaces your current project.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 py-2">
              <div>
                <label htmlFor="import-url" className="text-xs font-medium text-muted-foreground">
                  GitHub URL <span className="text-destructive">*</span>
                </label>
                <input
                  id="import-url"
                  type="url"
                  className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="https://github.com/owner/repo"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setUrlError(""); }}
                />
                {urlError && <p className="mt-1 text-xs text-destructive">{urlError}</p>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="import-branch" className="text-xs font-medium text-muted-foreground">
                    Branch
                  </label>
                  <input
                    id="import-branch"
                    type="text"
                    className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="main"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="import-subdir" className="text-xs font-medium text-muted-foreground">
                    Subdirectory
                  </label>
                  <input
                    id="import-subdir"
                    type="text"
                    className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="(root)"
                    value={subdir}
                    onChange={(e) => setSubdir(e.target.value)}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={backup}
                  onChange={(e) => setBackup(e.target.checked)}
                  className="rounded border-input"
                />
                <span className="text-muted-foreground">Back up current project before import</span>
              </label>
            </div>

            {recentImports.length > 0 && (
              <div className="border-t pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Recent imports</p>
                <ScrollArea className="max-h-28">
                  <div className="space-y-1">
                    {recentImports.map((imp) => (
                      <div
                        key={imp.archiveFile}
                        className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-accent"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono">{imp.url.replace("https://github.com/", "")}</p>
                          <p className="text-muted-foreground">
                            {new Date(imp.importedAt).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-2 h-6 shrink-0 text-xs"
                          onClick={() => void handleRestore(imp.archiveFile)}
                        >
                          Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                {restoreStatus && (
                  <p className="mt-1 text-xs text-muted-foreground">{restoreStatus}</p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button type="button" onClick={handleSubmit}>
                Continue
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>Confirm import</DialogTitle>
              <DialogDescription>
                This will replace your current project with <strong>{repoName}</strong>.
                {backup && " Your current project will be backed up."}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md border bg-muted/50 p-3 text-xs">
              <p><span className="text-muted-foreground">Repository:</span> {repoName}</p>
              {branch && <p><span className="text-muted-foreground">Branch:</span> {branch}</p>}
              {subdir && <p><span className="text-muted-foreground">Subdirectory:</span> {subdir}</p>}
              <p className="mt-2 text-muted-foreground">
                This imports a snapshot, not the git history.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Button type="button" onClick={handleConfirm}>
                Import
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "progress" && (
          <>
            <DialogHeader>
              <DialogTitle>
                {state.status === "done"
                  ? state.success
                    ? "Import complete"
                    : "Import failed"
                  : state.status === "error"
                    ? "Import error"
                    : "Importing…"}
              </DialogTitle>
              {state.detail && (
                <DialogDescription>{state.detail}</DialogDescription>
              )}
            </DialogHeader>

            {/* Progress indicator */}
            {(state.status === "connecting" || state.status === "importing") && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full animate-pulse rounded-full bg-primary" style={{ width: "60%" }} />
              </div>
            )}

            {state.logLines.length > 0 && (
              <ScrollArea className="max-h-32 rounded border bg-muted/30 p-2">
                <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {state.logLines.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </ScrollArea>
            )}

            {state.message && (state.status === "done" || state.status === "error") && (
              <p className={`text-sm ${state.success ? "text-green-500" : "text-destructive"}`}>
                {state.message}
              </p>
            )}

            {(state.status === "done" || state.status === "error") && (
              <DialogFooter>
                <Button type="button" onClick={handleClose}>
                  Close
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
