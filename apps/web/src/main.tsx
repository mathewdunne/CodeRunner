import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type ContainersStatusResponse,
  isWorkspaceSlug,
  runServerMessageSchema,
  type RunServerMessage,
  type SessionResponse,
} from "@frc-sim/contracts";
import "./style.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: SessionResponse }
  | { status: "error"; message: string };

type RunStatus = "connecting" | "idle" | "queued" | "building" | "running" | "stopping" | "failed" | "stopped" | "error";
type ScopeStatus = "loading" | "configured" | "connected" | "timeout";
type EditorStatus = "loading" | "reachable" | "error";

function workspaceSlugFromLocation(): string | null {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const slug = pathParts[0] === "u" ? pathParts[1] : undefined;
  return slug && isWorkspaceSlug(slug) ? slug : null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText || "request failed"}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Preserve the HTTP status when the server did not return an API error body.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

function App() {
  const workspaceSlug = useMemo(() => workspaceSlugFromLocation(), []);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [containerStatus, setContainerStatus] = useState<ContainersStatusResponse | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("connecting");
  const [scopeStatus, setScopeStatus] = useState<ScopeStatus>("loading");
  const [editorStatus, setEditorStatus] = useState<EditorStatus>("loading");
  const [queueInfo, setQueueInfo] = useState<{ depth: number; position: number } | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>(["Connecting..."]);
  const scopeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const runSocketRef = useRef<WebSocket | null>(null);
  const [scopeWidth, setScopeWidth] = useState(() => Math.round(window.innerWidth * 0.34));
  const [consoleHeight, setConsoleHeight] = useState(180);
  const dragRef = useRef<{ type: "v" | "h"; startCoord: number; startVal: number } | null>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.type === "v") {
        const delta = drag.startCoord - e.clientX;
        setScopeWidth(Math.max(260, Math.min(drag.startVal + delta, window.innerWidth - 340)));
      } else {
        const delta = drag.startCoord - e.clientY;
        setConsoleHeight(Math.max(80, Math.min(drag.startVal + delta, window.innerHeight - 140)));
      }
    };
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.classList.remove("resizing", "resizing-v", "resizing-h");
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const onVHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { type: "v", startCoord: e.clientX, startVal: scopeWidth };
    document.body.classList.add("resizing", "resizing-v");
  }, [scopeWidth]);

  const onHHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { type: "h", startCoord: e.clientY, startVal: consoleHeight };
    document.body.classList.add("resizing", "resizing-h");
  }, [consoleHeight]);

  const editorUrl = workspaceSlug ? `/u/${workspaceSlug}/vscode/?folder=/workspace/project` : null;

  const logLine = useCallback((line: string) => {
    setConsoleLines((current) => [...current.filter((entry) => entry !== "Connecting..."), line].slice(-80));
  }, []);

  const clearConsole = useCallback((line: string) => {
    setConsoleLines([line]);
  }, []);

  // Load session on mount
  useEffect(() => {
    if (!workspaceSlug) {
      setState({ status: "error", message: "Workspace route is invalid." });
      return;
    }

    let cancelled = false;

    async function loadSession() {
      try {
        const session = await fetchJson<SessionResponse>(`/u/${workspaceSlug}/api/session`);
        if (!cancelled) {
          setState({ status: "ready", session });
          setConsoleLines(["Workspace loaded."]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load workspace.";
        if (!cancelled) {
          setState({ status: "error", message });
          setConsoleLines([message]);
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug]);

  // Heartbeat every 60s
  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    const sendHeartbeat = (closing = false) => {
      void fetch(`/u/${workspaceSlug}/api/heartbeat`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ closing }),
        keepalive: true,
      });
    };

    const onPageHide = () => sendHeartbeat(true);

    sendHeartbeat();
    const interval = window.setInterval(() => sendHeartbeat(), 60_000);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [workspaceSlug]);

  // Run WebSocket
  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/u/${workspaceSlug}/ws/run`);
    runSocketRef.current = socket;
    setRunStatus("connecting");

    socket.addEventListener("open", () => {
      setRunStatus("idle");
      logLine("Run channel connected.");
    });
    socket.addEventListener("message", (event) => {
      let message: RunServerMessage;
      try {
        message = runServerMessageSchema.parse(JSON.parse(String(event.data)));
      } catch {
        logLine("Ignored an invalid run message from the server.");
        return;
      }

      if (message.type === "hello") {
        setQueueInfo(message.queueDepth > 0 ? { depth: message.queueDepth, position: 0 } : null);
        return;
      }
      if (message.type === "status") {
        setRunStatus(message.status);
        setQueueInfo(
          message.queueDepth === undefined || message.queuePosition === undefined
            ? null
            : { depth: message.queueDepth, position: message.queuePosition },
        );
        return;
      }
      if (message.type === "queue") {
        setQueueInfo({ depth: message.queueDepth, position: message.queuePosition });
        return;
      }
      if (message.type === "log") {
        logLine(`[${message.stream}] ${message.line}`);
        return;
      }
      if (message.type === "exit") {
        logLine(`Run exited with code ${message.code ?? "none"}${message.signal ? ` (${message.signal})` : ""}.`);
        return;
      }
      setRunStatus("error");
      logLine(message.message);
    });
    socket.addEventListener("close", () => {
      if (runSocketRef.current === socket) {
        runSocketRef.current = null;
      }
      setRunStatus("error");
      logLine("Run channel disconnected.");
    });
    socket.addEventListener("error", () => {
      setRunStatus("error");
    });

    return () => {
      if (runSocketRef.current === socket) {
        runSocketRef.current = null;
      }
      socket.close();
    };
  }, [logLine, workspaceSlug]);

  // Container status polling
  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const status = await fetchJson<ContainersStatusResponse>(`/u/${workspaceSlug}/api/containers/status`);
        if (!cancelled) {
          setContainerStatus(status);
        }
      } catch {
        if (!cancelled) {
          setContainerStatus(null);
        }
      }
    };

    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceSlug]);

  // Editor reachability probe
  useEffect(() => {
    if (!editorUrl) {
      return;
    }

    let cancelled = false;
    const probeEditor = async () => {
      try {
        const response = await fetch(editorUrl, { credentials: "same-origin", method: "GET" });
        if (!cancelled) {
          setEditorStatus(response.status >= 500 ? "error" : "reachable");
        }
      } catch {
        if (!cancelled) {
          setEditorStatus("error");
        }
      }
    };

    void probeEditor();
    const interval = window.setInterval(() => void probeEditor(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [editorUrl]);

  // Scope postMessage handshake
  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    let acknowledged = false;
    const frame = scopeFrameRef.current;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = {
      aliveUrl: `/u/${workspaceSlug}/sim/alive`,
      websocketUrl: `${protocol}//${window.location.host}/u/${workspaceSlug}/sim/nt4`,
    };

    const sendConfig = () => {
      setScopeStatus("configured");
      frame?.contentWindow?.postMessage(
        {
          type: "frc-sim:set-nt4-endpoint",
          endpoint,
        },
        window.location.origin,
      );
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if ((event.data as { type?: unknown } | null)?.type !== "frc-sim:nt4-endpoint-ready") {
        return;
      }
      acknowledged = true;
      setScopeStatus("connected");
    };

    window.addEventListener("message", onMessage);
    frame?.addEventListener("load", sendConfig);
    if (frame?.contentWindow) {
      sendConfig();
    }
    const timeout = window.setTimeout(() => {
      if (!acknowledged) {
        setScopeStatus("timeout");
      }
    }, 10_000);

    return () => {
      window.removeEventListener("message", onMessage);
      frame?.removeEventListener("load", sendConfig);
      window.clearTimeout(timeout);
    };
  }, [workspaceSlug]);

  const startRun = useCallback(() => {
    clearConsole("Starting run...");
    const socket = runSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "start" }));
    }
  }, [clearConsole]);

  const stopRun = useCallback(() => {
    const socket = runSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "stop" }));
      setRunStatus("stopping");
    }
  }, []);

  const displayName = state.status === "ready" ? state.session.user.displayName : "Loading";
  const workspaceLabel = state.status === "ready" ? state.session.workspace.slug : (workspaceSlug ?? "unknown");
  const simLabel = !containerStatus
    ? "Sim pending"
    : containerStatus.code.state === "error"
      ? "Sim error"
      : `Sim ${containerStatus.code.state}`;
  const runBusy = ["queued", "building", "running", "stopping"].includes(runStatus);
  const runLabel =
    runStatus === "queued" && queueInfo
      ? `Run queued ${queueInfo.position + 1}/${queueInfo.depth}`
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
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>FRC Web Simulator</strong>
          <span>{displayName}</span>
        </div>
        <div className="status-strip">
          <span>Workspace {workspaceLabel}</span>
          <span className={editorStatus === "error" ? "pill-error" : undefined}>{editorLabel}</span>
          <span title={containerStatus?.code.error ?? undefined}>{simLabel}</span>
          <span>{runLabel}</span>
          <span>{scopeLabel}</span>
        </div>
        <div className="run-actions">
          <button type="button" onClick={startRun} disabled={runBusy || state.status !== "ready"}>
            Run
          </button>
          <button type="button" onClick={stopRun} disabled={!runBusy}>
            Stop
          </button>
        </div>
        <form method="post" action="/logout">
          <button type="submit">Logout</button>
        </form>
      </header>
      <main
        className="ide-grid"
        style={{
          gridTemplateColumns: `1fr 5px ${scopeWidth}px`,
          gridTemplateRows: `1fr 5px ${consoleHeight}px`,
        }}
      >
        <section className="editor-pane">
          {editorUrl ? (
            <iframe
              title="VS Code Editor"
              src={editorUrl}
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <div className="editor-empty">
              {state.status === "error" ? state.message : "Loading editor..."}
            </div>
          )}
        </section>
        <div className="v-handle" onMouseDown={onVHandleMouseDown} />
        <aside className="scope-pane">
          <header>
            <span>AdvantageScope</span>
            <span>{scopeLabel}</span>
          </header>
          <iframe
            ref={scopeFrameRef}
            title="AdvantageScope Lite"
            src="/scope/?frcEndpoint=postMessage"
          />
        </aside>
        <div className="h-handle" onMouseDown={onHHandleMouseDown} />
        <section className="console-pane">
          <header>Console</header>
          <pre>{consoleLines.join("\n")}</pre>
        </section>
      </main>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
