import { StrictMode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isWorkspaceSlug,
  type ProjectTreeNode,
  type ProjectTreeResponse,
  type SessionResponse,
} from "@frc-sim/contracts";
import "./style.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: SessionResponse; tree: ProjectTreeResponse }
  | { status: "error"; message: string };

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
    throw new Error(`${response.status} ${response.statusText || "request failed"}`);
  }
  return (await response.json()) as T;
}

function TreeNodeView({ node, depth = 0 }: { node: ProjectTreeNode; depth?: number }) {
  if (node.path === "") {
    return (
      <ul className="tree-list">
        {(node.children ?? []).map((child) => (
          <TreeNodeView key={child.path} node={child} depth={0} />
        ))}
      </ul>
    );
  }

  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: `${depth * 14 + 10}px` }}>
        <span className="tree-icon" aria-hidden="true">
          {node.kind === "directory" ? "/" : ""}
        </span>
        <span>{node.name}</span>
      </div>
      {node.kind === "directory" && node.children && node.children.length > 0 ? (
        <ul className="tree-list">
          {node.children.map((child) => (
            <TreeNodeView key={child.path} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function App() {
  const workspaceSlug = useMemo(() => workspaceSlugFromLocation(), []);
  const [state, setState] = useState<LoadState>({ status: "loading" });

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
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load workspace.";
        if (!cancelled) {
          setState({ status: "error", message });
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug]);

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

  const displayName = state.status === "ready" ? state.session.user.displayName : "Loading";
  const workspaceLabel = state.status === "ready" ? state.session.workspace.slug : (workspaceSlug ?? "unknown");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>FRC Web Simulator</strong>
          <span>{displayName}</span>
        </div>
        <div className="status-strip">
          <span>Workspace {workspaceLabel}</span>
          <span>Save idle</span>
          <span>LSP pending</span>
          <span>Sim offline</span>
        </div>
        <form method="post" action="/logout">
          <button type="submit">Logout</button>
        </form>
      </header>
      <main className="ide-grid">
        <aside className="file-pane">
          <header>Project</header>
          {state.status === "ready" ? <TreeNodeView node={state.tree.tree} /> : <p>{state.status}</p>}
        </aside>
        <section className="editor-pane">
          <div className="tabbar">
            <button type="button">Robot.java</button>
          </div>
          <div className="editor-placeholder">
            {state.status === "error" ? state.message : "src/main/java/frc/robot/Robot.java"}
          </div>
        </section>
        <aside className="scope-pane">
          <header>AdvantageScope</header>
          <div>Disconnected</div>
        </aside>
        <section className="console-pane">
          <header>Console</header>
          <pre>{state.status === "ready" ? "Workspace loaded." : "Connecting..."}</pre>
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
