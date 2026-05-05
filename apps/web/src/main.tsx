import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  type ContainersStatusResponse,
  isWorkspaceSlug,
  type FileMutationResponse,
  type ProjectFileResponse,
  type ProjectPathAccess,
  type ProjectTreeNode,
  type ProjectTreeResponse,
  runServerMessageSchema,
  type RunServerMessage,
  type SessionResponse,
} from "@frc-sim/contracts";
import { runFlushBlockers } from "./save-before-run";
import "./style.css";

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: SessionResponse; tree: ProjectTreeResponse }
  | { status: "error"; message: string };

type OpenFile = {
  path: string;
  access: "editable" | "readonly";
  dirty: boolean;
  saving: boolean;
  error: string | null;
};

type ModelState = {
  model: monaco.editor.ITextModel;
  saveTimer: number | null;
  subscription: monaco.IDisposable;
};

type RunStatus = "connecting" | "idle" | "queued" | "building" | "running" | "stopping" | "failed" | "stopped" | "error";
type ScopeStatus = "loading" | "configured" | "connected" | "timeout";

function workspaceSlugFromLocation(): string | null {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const slug = pathParts[0] === "u" ? pathParts[1] : undefined;
  return slug && isWorkspaceSlug(slug) ? slug : null;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function languageFor(path: string): string {
  if (path.endsWith(".java")) {
    return "java";
  }
  if (path.endsWith(".json")) {
    return "json";
  }
  if (path.endsWith(".gradle") || fileName(path) === "gradle.properties") {
    return "properties";
  }
  return "plaintext";
}

function modelUriFor(path: string): monaco.Uri {
  return monaco.Uri.parse(`file:///workspace/project/${path}`);
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

function canOpen(access: ProjectPathAccess | "root"): access is "editable" | "readonly" {
  return access === "editable" || access === "readonly";
}

function setTree(state: LoadState, tree: ProjectTreeResponse): LoadState {
  return state.status === "ready" ? { ...state, tree } : state;
}

function TreeNodeView({
  node,
  activePath,
  selectedPath,
  onOpen,
  onSelect,
  depth = 0,
}: {
  node: ProjectTreeNode;
  activePath: string | null;
  selectedPath: string | null;
  onOpen(path: string): void;
  onSelect(path: string): void;
  depth?: number;
}) {
  if (node.path === "") {
    return (
      <ul className="tree-list">
        {(node.children ?? []).map((child) => (
          <TreeNodeView
            key={child.path}
            node={child}
            activePath={activePath}
            selectedPath={selectedPath}
            onOpen={onOpen}
            onSelect={onSelect}
            depth={0}
          />
        ))}
      </ul>
    );
  }

  const isFile = node.kind === "file";
  const isOpenable = isFile && canOpen(node.access);

  return (
    <li>
      <button
        type="button"
        className={`tree-row ${activePath === node.path ? "active" : ""} ${selectedPath === node.path ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        disabled={isFile && !isOpenable}
        onClick={() => {
          onSelect(node.path);
          if (isOpenable) {
            onOpen(node.path);
          }
        }}
      >
        <span className="tree-icon" aria-hidden="true">
          {node.kind === "directory" ? "/" : ""}
        </span>
        <span>{node.name}</span>
      </button>
      {node.kind === "directory" && node.children && node.children.length > 0 ? (
        <ul className="tree-list">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              activePath={activePath}
              selectedPath={selectedPath}
              onOpen={onOpen}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function App() {
  const workspaceSlug = useMemo(() => workspaceSlugFromLocation(), []);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [containerStatus, setContainerStatus] = useState<ContainersStatusResponse | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("connecting");
  const [scopeStatus, setScopeStatus] = useState<ScopeStatus>("loading");
  const [queueInfo, setQueueInfo] = useState<{ depth: number; position: number } | null>(null);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>(["Connecting..."]);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const scopeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const runSocketRef = useRef<WebSocket | null>(null);
  const modelStatesRef = useRef(new Map<string, ModelState>());
  const openFilesRef = useRef(openFiles);
  const saveFileRef = useRef<(path: string) => void>(() => {});
  const defaultOpenedRef = useRef(false);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const apiUrl = useCallback(
    (suffix: string) => {
      if (!workspaceSlug) {
        throw new Error("Workspace route is invalid.");
      }
      return `/u/${workspaceSlug}/api${suffix}`;
    },
    [workspaceSlug],
  );

  const logLine = useCallback((line: string) => {
    setConsoleLines((current) => [...current.filter((entry) => entry !== "Connecting..."), line].slice(-80));
  }, []);

  const clearConsole = useCallback((line: string) => {
    setConsoleLines([line]);
  }, []);

  const updateOpenFile = useCallback((path: string, patch: Partial<OpenFile>) => {
    setOpenFiles((current) => current.map((file) => (file.path === path ? { ...file, ...patch } : file)));
  }, []);

  const applyTree = useCallback((tree: ProjectTreeResponse) => {
    setState((current) => setTree(current, tree));
  }, []);

  const scheduleSave = useCallback((path: string) => {
    const modelState = modelStatesRef.current.get(path);
    if (!modelState) {
      return;
    }
    if (modelState.saveTimer !== null) {
      window.clearTimeout(modelState.saveTimer);
    }
    modelState.saveTimer = window.setTimeout(() => saveFileRef.current(path), 500);
  }, []);

  const saveFile = useCallback(
    async (path: string): Promise<boolean> => {
      const modelState = modelStatesRef.current.get(path);
      const openFile = openFilesRef.current.find((file) => file.path === path);
      if (!modelState || !openFile || openFile.access !== "editable") {
        return true;
      }

      if (modelState.saveTimer !== null) {
        window.clearTimeout(modelState.saveTimer);
        modelState.saveTimer = null;
      }

      const contents = modelState.model.getValue();
      updateOpenFile(path, { saving: true, error: null });
      try {
        const response = await fetchJson<FileMutationResponse>(
          apiUrl(`/files?path=${encodeURIComponent(path)}`),
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents }),
          },
        );
        applyTree(response.tree);
        const changedDuringSave = modelState.model.getValue() !== contents;
        updateOpenFile(path, {
          dirty: changedDuringSave,
          saving: false,
          error: null,
        });
        if (changedDuringSave) {
          scheduleSave(path);
        }
        return !changedDuringSave;
      } catch (error) {
        updateOpenFile(path, {
          dirty: true,
          saving: false,
          error: error instanceof Error ? error.message : "Save failed.",
        });
        return false;
      }
    },
    [apiUrl, applyTree, scheduleSave, updateOpenFile],
  );

  useEffect(() => {
    saveFileRef.current = (path: string) => {
      void saveFile(path);
    };
  }, [saveFile]);

  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) {
      return;
    }

    editorRef.current = monaco.editor.create(editorHostRef.current, {
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: "vs-dark",
    });

    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const modelState of modelStatesRef.current.values()) {
        if (modelState.saveTimer !== null) {
          window.clearTimeout(modelState.saveTimer);
        }
        modelState.subscription.dispose();
        modelState.model.dispose();
      }
      modelStatesRef.current.clear();
    };
  }, []);

  const openProjectFile = useCallback(
    async (path: string) => {
      const existing = modelStatesRef.current.get(path);
      if (existing) {
        editorRef.current?.setModel(existing.model);
        setActivePath(path);
        return;
      }

      try {
        const file = await fetchJson<ProjectFileResponse>(apiUrl(`/files?path=${encodeURIComponent(path)}`));
        const model = monaco.editor.createModel(file.contents, languageFor(file.path), modelUriFor(file.path));
        const subscription = model.onDidChangeContent(() => {
          const openFile = openFilesRef.current.find((entry) => entry.path === file.path);
          if (!openFile || openFile.access !== "editable") {
            return;
          }
          updateOpenFile(file.path, { dirty: true, error: null });
          scheduleSave(file.path);
        });

        modelStatesRef.current.set(file.path, { model, saveTimer: null, subscription });
        setOpenFiles((current) =>
          current.some((entry) => entry.path === file.path)
            ? current
            : [...current, { path: file.path, access: file.access, dirty: false, saving: false, error: null }],
        );
        editorRef.current?.setModel(model);
        editorRef.current?.updateOptions({ readOnly: file.access === "readonly" });
        setActivePath(file.path);
        setSelectedPath(file.path);
        logLine(`Opened ${file.path}`);
      } catch (error) {
        logLine(error instanceof Error ? error.message : `Unable to open ${path}`);
      }
    },
    [apiUrl, logLine, scheduleSave, updateOpenFile],
  );

  useEffect(() => {
    if (!workspaceSlug) {
      setState({ status: "error", message: "Workspace route is invalid." });
      return;
    }

    let cancelled = false;

    async function loadWorkspace() {
      try {
        const [session, tree] = await Promise.all([
          fetchJson<SessionResponse>(`/u/${workspaceSlug}/api/session`),
          fetchJson<ProjectTreeResponse>(`/u/${workspaceSlug}/api/project/tree`),
        ]);
        if (!cancelled) {
          setState({ status: "ready", session, tree });
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

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug]);

  useEffect(() => {
    if (state.status !== "ready" || defaultOpenedRef.current) {
      return;
    }
    defaultOpenedRef.current = true;
    void openProjectFile("src/main/java/frc/robot/Robot.java");
  }, [openProjectFile, state.status]);

  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    const sendHeartbeat = () => {
      void fetch(`/u/${workspaceSlug}/api/heartbeat`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    };

    sendHeartbeat();
    const interval = window.setInterval(sendHeartbeat, 30_000);
    return () => window.clearInterval(interval);
  }, [workspaceSlug]);

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

  useEffect(() => {
    const warnOnDirtyFiles = (event: BeforeUnloadEvent) => {
      if (!openFilesRef.current.some((file) => file.dirty || file.saving)) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("beforeunload", warnOnDirtyFiles);
    return () => window.removeEventListener("beforeunload", warnOnDirtyFiles);
  }, []);

  useEffect(() => {
    const activeModel = activePath ? modelStatesRef.current.get(activePath)?.model : null;
    const activeFile = activePath ? openFiles.find((file) => file.path === activePath) : null;
    if (activeModel) {
      editorRef.current?.setModel(activeModel);
      editorRef.current?.updateOptions({ readOnly: activeFile?.access === "readonly" });
    }
  }, [activePath, openFiles]);

  const createEntry = useCallback(
    async (kind: "file" | "directory") => {
      const base = selectedPath ? (selectedPath.includes(".") ? parentPath(selectedPath) : selectedPath) : "";
      const suggestion =
        kind === "file"
          ? `${base ? `${base}/` : "src/main/java/frc/robot/"}NewClass.java`
          : `${base ? `${base}/` : "src/main/java/frc/robot/"}newfolder`;
      const path = window.prompt(`New ${kind} path`, suggestion);
      if (!path) {
        return;
      }

      try {
        const response = await fetchJson<FileMutationResponse>(apiUrl("/files"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(kind === "file" ? { kind, path, contents: "" } : { kind, path }),
        });
        applyTree(response.tree);
        setSelectedPath(path);
        if (kind === "file") {
          await openProjectFile(path);
        }
        logLine(`Created ${path}`);
      } catch (error) {
        logLine(error instanceof Error ? error.message : `Unable to create ${path}`);
      }
    },
    [apiUrl, applyTree, logLine, openProjectFile, selectedPath],
  );

  const renameEntry = useCallback(async () => {
    if (!selectedPath) {
      return;
    }
    const to = window.prompt("Rename path", selectedPath);
    if (!to || to === selectedPath) {
      return;
    }

    try {
      const response = await fetchJson<FileMutationResponse>(apiUrl("/files/rename"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: selectedPath, to }),
      });
      applyTree(response.tree);

      setOpenFiles((current) =>
        current.map((file) => {
          if (file.path === selectedPath || file.path.startsWith(`${selectedPath}/`)) {
            return { ...file, path: `${to}${file.path.slice(selectedPath.length)}` };
          }
          return file;
        }),
      );

      for (const [path, modelState] of [...modelStatesRef.current.entries()]) {
        if (path !== selectedPath && !path.startsWith(`${selectedPath}/`)) {
          continue;
        }
        const nextPath = `${to}${path.slice(selectedPath.length)}`;
        const nextModel = monaco.editor.createModel(modelState.model.getValue(), languageFor(nextPath), modelUriFor(nextPath));
        const subscription = nextModel.onDidChangeContent(() => {
          const openFile = openFilesRef.current.find((entry) => entry.path === nextPath);
          if (!openFile || openFile.access !== "editable") {
            return;
          }
          updateOpenFile(nextPath, { dirty: true, error: null });
          scheduleSave(nextPath);
        });
        if (modelState.saveTimer !== null) {
          window.clearTimeout(modelState.saveTimer);
        }
        modelState.subscription.dispose();
        modelState.model.dispose();
        modelStatesRef.current.delete(path);
        modelStatesRef.current.set(nextPath, { model: nextModel, saveTimer: null, subscription });
      }

      setSelectedPath(to);
      setActivePath((current) =>
        current && (current === selectedPath || current.startsWith(`${selectedPath}/`))
          ? `${to}${current.slice(selectedPath.length)}`
          : current,
      );
      logLine(`Renamed ${selectedPath} to ${to}`);
    } catch (error) {
      logLine(error instanceof Error ? error.message : `Unable to rename ${selectedPath}`);
    }
  }, [apiUrl, applyTree, logLine, scheduleSave, selectedPath, updateOpenFile]);

  const deleteEntry = useCallback(async () => {
    if (!selectedPath || !window.confirm(`Delete ${selectedPath}?`)) {
      return;
    }

    try {
      const response = await fetchJson<FileMutationResponse>(apiUrl(`/files?path=${encodeURIComponent(selectedPath)}`), {
        method: "DELETE",
      });
      applyTree(response.tree);
      const removedPaths = [...modelStatesRef.current.keys()].filter(
        (path) => path === selectedPath || path.startsWith(`${selectedPath}/`),
      );
      for (const path of removedPaths) {
        const modelState = modelStatesRef.current.get(path);
        if (!modelState) {
          continue;
        }
        if (modelState.saveTimer !== null) {
          window.clearTimeout(modelState.saveTimer);
        }
        modelState.subscription.dispose();
        modelState.model.dispose();
        modelStatesRef.current.delete(path);
      }
      setOpenFiles((current) => current.filter((file) => !removedPaths.includes(file.path)));
      setActivePath((current) => (current && removedPaths.includes(current) ? null : current));
      setSelectedPath(null);
      logLine(`Deleted ${selectedPath}`);
    } catch (error) {
      logLine(error instanceof Error ? error.message : `Unable to delete ${selectedPath}`);
    }
  }, [apiUrl, applyTree, logLine, selectedPath]);

  const closeFile = useCallback(
    (path: string) => {
      const openFile = openFilesRef.current.find((file) => file.path === path);
      if (openFile && (openFile.dirty || openFile.saving) && !window.confirm(`Close ${path} with unsaved changes?`)) {
        return;
      }
      const modelState = modelStatesRef.current.get(path);
      if (modelState) {
        if (modelState.saveTimer !== null) {
          window.clearTimeout(modelState.saveTimer);
        }
        modelState.subscription.dispose();
        modelState.model.dispose();
        modelStatesRef.current.delete(path);
      }
      setOpenFiles((current) => current.filter((file) => file.path !== path));
      setActivePath((current) => {
        if (current !== path) {
          return current;
        }
        const remaining = openFilesRef.current.filter((file) => file.path !== path);
        return remaining[0]?.path ?? null;
      });
    },
    [],
  );

  const startRun = useCallback(async () => {
    clearConsole("Starting run...");
    const dirtyEditableFiles = openFilesRef.current.filter((file) => file.access === "editable" && (file.dirty || file.saving));
    const saveResults = await Promise.all(dirtyEditableFiles.map((file) => saveFile(file.path)));
    const blockers = runFlushBlockers(openFilesRef.current);
    if (saveResults.some((ok) => !ok) || blockers.length > 0) {
      setRunStatus("error");
      logLine(
        blockers[0]
          ? `Run blocked until ${blockers[0].path} saves successfully.`
          : "Run blocked until pending saves complete.",
      );
      return;
    }

    const socket = runSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "start" }));
      return;
    }

    try {
      await fetchJson(apiUrl("/run"), { method: "POST" });
      setRunStatus("queued");
      logLine("Run queued. Reconnect the run channel to stream logs.");
    } catch (error) {
      setRunStatus("error");
      logLine(error instanceof Error ? error.message : "Unable to start run.");
    }
  }, [apiUrl, clearConsole, logLine, saveFile]);

  const stopRun = useCallback(async () => {
    const socket = runSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "stop" }));
      setRunStatus("stopping");
      return;
    }

    try {
      await fetchJson(apiUrl("/run/stop"), { method: "POST" });
      setRunStatus("stopping");
    } catch (error) {
      setRunStatus("error");
      logLine(error instanceof Error ? error.message : "Unable to stop run.");
    }
  }, [apiUrl, logLine]);

  const displayName = state.status === "ready" ? state.session.user.displayName : "Loading";
  const workspaceLabel = state.status === "ready" ? state.session.workspace.slug : (workspaceSlug ?? "unknown");
  const activeFile = activePath ? openFiles.find((file) => file.path === activePath) : null;
  const dirtyCount = openFiles.filter((file) => file.dirty || file.saving).length;
  const saveLabel =
    dirtyCount === 0 ? "Save idle" : openFiles.some((file) => file.saving) ? "Saving" : `${dirtyCount} unsaved`;
  const simLabel = !containerStatus
    ? "Sim pending"
    : containerStatus.sim.state === "error"
      ? "Sim error"
      : `Sim ${containerStatus.sim.state}`;
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>FRC Web Simulator</strong>
          <span>{displayName}</span>
        </div>
        <div className="status-strip">
          <span>Workspace {workspaceLabel}</span>
          <span>{saveLabel}</span>
          <span>LSP pending</span>
          <span title={containerStatus?.sim.error ?? undefined}>{simLabel}</span>
          <span>{runLabel}</span>
          <span>{scopeLabel}</span>
        </div>
        <div className="run-actions">
          <button type="button" onClick={() => void startRun()} disabled={runBusy || state.status !== "ready"}>
            Run
          </button>
          <button type="button" onClick={() => void stopRun()} disabled={!runBusy}>
            Stop
          </button>
        </div>
        <form method="post" action="/logout">
          <button type="submit">Logout</button>
        </form>
      </header>
      <main className="ide-grid">
        <aside className="file-pane">
          <header>
            <span>Project</span>
            <div className="file-actions">
              <button type="button" onClick={() => void createEntry("file")} title="Create file">
                +F
              </button>
              <button type="button" onClick={() => void createEntry("directory")} title="Create directory">
                +D
              </button>
              <button type="button" onClick={() => void renameEntry()} disabled={!selectedPath} title="Rename">
                Ren
              </button>
              <button type="button" onClick={() => void deleteEntry()} disabled={!selectedPath} title="Delete">
                Del
              </button>
            </div>
          </header>
          {state.status === "ready" ? (
            <TreeNodeView
              node={state.tree.tree}
              activePath={activePath}
              selectedPath={selectedPath}
              onOpen={(path) => void openProjectFile(path)}
              onSelect={setSelectedPath}
            />
          ) : (
            <p>{state.status}</p>
          )}
        </aside>
        <section className="editor-pane">
          <div className="tabbar">
            {openFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                className={file.path === activePath ? "active" : ""}
                title={file.path}
                onClick={() => setActivePath(file.path)}
              >
                <span>{fileName(file.path)}</span>
                <span className="tab-state">{file.saving ? "save" : file.dirty ? "*" : file.access === "readonly" ? "ro" : ""}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeFile(file.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      closeFile(file.path);
                    }
                  }}
                >
                  x
                </span>
              </button>
            ))}
          </div>
          <div className="editor-host" ref={editorHostRef}>
            {state.status === "error" || openFiles.length === 0 ? (
              <div className="editor-empty">
                {state.status === "error" ? state.message : "Open a project file"}
              </div>
            ) : null}
          </div>
          {activeFile?.error ? <div className="save-error">{activeFile.error}</div> : null}
        </section>
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
