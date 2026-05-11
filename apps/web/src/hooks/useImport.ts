import { useCallback, useRef, useState } from "react";
import { importServerMessageSchema } from "@/lib/contracts";
import type { ImportServerMessage, ImportBackupMetadata } from "@/lib/contracts";

export type ImportStatus =
  | "idle"
  | "connecting"
  | "importing"
  | "done"
  | "error";

export interface ImportState {
  status: ImportStatus;
  stage: string;
  detail: string;
  logLines: string[];
  success: boolean | null;
  message: string;
}

interface UseImportReturn {
  state: ImportState;
  startImport: (params: {
    url: string;
    branch?: string;
    subdir?: string;
    backup?: boolean;
  }) => void;
  reset: () => void;
  recentImports: ImportBackupMetadata[];
  loadRecentImports: () => Promise<void>;
  restoreBackup: (archiveFile: string) => Promise<{ ok: boolean; error?: string }>;
}

const MAX_LOG_LINES = 200;

const INITIAL_STATE: ImportState = {
  status: "idle",
  stage: "",
  detail: "",
  logLines: [],
  success: null,
  message: "",
};

export function useImport(workspaceSlug: string | null): UseImportReturn {
  const [state, setState] = useState<ImportState>(INITIAL_STATE);
  const [recentImports, setRecentImports] = useState<ImportBackupMetadata[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  const reset = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      socketRef.current = null;
      socket.close();
    }
    setState(INITIAL_STATE);
  }, []);

  const startImport = useCallback(
    (params: { url: string; branch?: string; subdir?: string; backup?: boolean }) => {
      if (!workspaceSlug) return;

      // Close any existing socket
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }

      setState({
        ...INITIAL_STATE,
        status: "connecting",
        stage: "connecting",
        detail: "Opening import channel…",
      });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/u/${workspaceSlug}/ws/import`,
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setState((prev) => ({
          ...prev,
          status: "importing",
          stage: "starting",
          detail: "Sending import request…",
        }));
        socket.send(
          JSON.stringify({
            url: params.url,
            branch: params.branch || undefined,
            subdir: params.subdir || undefined,
            backup: params.backup ?? true,
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        try {
          const message: ImportServerMessage = importServerMessageSchema.parse(
            JSON.parse(String(event.data)),
          );

          setState((prev) => {
            switch (message.type) {
              case "hello":
                return { ...prev, status: "importing" };
              case "progress":
                return {
                  ...prev,
                  stage: message.stage,
                  detail: message.detail ?? "",
                };
              case "log":
                return {
                  ...prev,
                  logLines: [...prev.logLines, message.line].slice(-MAX_LOG_LINES),
                };
              case "done":
                return {
                  ...prev,
                  status: "done",
                  success: message.success,
                  message: message.message,
                  stage: message.success ? "complete" : "failed",
                  detail: message.message,
                };
              case "error":
                return {
                  ...prev,
                  status: "error",
                  success: false,
                  message: message.message,
                  stage: "error",
                  detail: message.message,
                };
            }
          });
        } catch {
          // Ignore malformed messages
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setState((prev) => {
          if (prev.status === "importing" || prev.status === "connecting") {
            return {
              ...prev,
              status: "error",
              success: false,
              message: "Connection closed unexpectedly.",
              stage: "error",
              detail: "Connection closed unexpectedly.",
            };
          }
          return prev;
        });
      });

      socket.addEventListener("error", () => {
        // The close handler will take care of the state update.
      });
    },
    [workspaceSlug],
  );

  const loadRecentImports = useCallback(async () => {
    if (!workspaceSlug) return;
    try {
      const response = await fetch(`/u/${workspaceSlug}/api/project/recent-imports`);
      if (response.ok) {
        const data = (await response.json()) as { ok: boolean; imports: ImportBackupMetadata[] };
        setRecentImports(data.imports ?? []);
      }
    } catch {
      // Ignore fetch errors
    }
  }, [workspaceSlug]);

  const restoreBackup = useCallback(
    async (archiveFile: string): Promise<{ ok: boolean; error?: string }> => {
      if (!workspaceSlug) return { ok: false, error: "No workspace." };
      try {
        const response = await fetch(`/u/${workspaceSlug}/api/project/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archiveFile }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string; message?: string };
        if (response.ok && data.ok) {
          return { ok: true };
        }
        return { ok: false, error: data.error ?? "Restore failed." };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Restore failed." };
      }
    },
    [workspaceSlug],
  );

  return { state, startImport, reset, recentImports, loadRecentImports, restoreBackup };
}
