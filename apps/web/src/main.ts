import * as monaco from "monaco-editor";
import { startJavaLsp } from "./java-lsp.js";
import { setupMonaco } from "./monaco-setup.js";
import { defaultDarkModernThemeName } from "./vscode-dark-modern.js";
import "./style.css";

setupMonaco();

const consoleEl = document.getElementById("console");
const editorEl = document.getElementById("editor");
const runEl = document.getElementById("run");
const statusEl = document.getElementById("status");

if (!(runEl instanceof HTMLButtonElement)) {
  throw new Error("Missing required DOM node (#run button)");
}

if (!consoleEl || !editorEl || !statusEl) {
  throw new Error("Missing required DOM nodes (#console / #editor / #status)");
}

const consoleNode = consoleEl;
const runButton = runEl;
const statusNode = statusEl;
const sessionUser = currentSessionUser();

function appendConsole(line: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const node = document.createElement("div");
  node.textContent = `[${ts}] ${line}`;
  consoleNode.appendChild(node);
  consoleNode.scrollTop = consoleNode.scrollHeight;
}

type Status = "idle" | "saving" | "saved" | "building" | "running" | "error";

function setStatus(status: Status): void {
  statusNode.textContent = status;
  statusNode.dataset.status = status;
}

async function loadRobotJava(): Promise<string> {
  const res = await fetch(sessionPath("/file"));
  if (!res.ok) {
    throw new Error(`Failed to load Robot.java: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

const initial = await loadRobotJava();
const robotFileUri = projectFileUri(sessionUser);

const model = monaco.editor.createModel(
  initial,
  "java",
  monaco.Uri.parse(robotFileUri),
);

const editor = monaco.editor.create(editorEl, {
  model,
  theme: defaultDarkModernThemeName,
  automaticLayout: true,
  "semanticHighlighting.enabled": true,
  bracketPairColorization: { enabled: true },
  fontSize: 14,
  lineHeight: 20,
  minimap: { enabled: false },
  smoothScrolling: true,
});

function javaLanguageServerUrl(): string {
  const configured = envValue("VITE_LSP_URL");
  if (configured) {
    return configured;
  }

  const portMap = parsePortMap(envValue("VITE_SPIKE_LSP_PORTS"));
  const mappedPort = portMap.get(sessionUser);
  if (mappedPort !== undefined) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.hostname}:${mappedPort}/jdtls`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:30003/jdtls`;
}

const scopeFrame = document.getElementById("scope-frame");
if (scopeFrame instanceof HTMLIFrameElement) {
  scopeFrame.src = advantageScopeUrl(sessionUser);
}

void startJavaLsp({
  model,
  url: javaLanguageServerUrl(),
  onStatus: appendConsole,
});

let saveTimer: number | undefined;
let pendingSave: Promise<void> | undefined;
let activeRunSocket: WebSocket | undefined;

async function saveRobotJava(contents: string): Promise<void> {
  setStatus("saving");
  const res = await fetch(sessionPath("/file"), {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: contents,
  });
  if (!res.ok) {
    throw new Error(`Save failed: ${res.status} ${res.statusText}`);
  }
  setStatus("saved");
}

function scheduleSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    pendingSave = saveRobotJava(editor.getValue()).catch((err: unknown) => {
      setStatus("error");
      appendConsole(err instanceof Error ? err.message : "Save failed");
      throw err;
    });
  }, 500);
}

async function flushSave(): Promise<void> {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    pendingSave = saveRobotJava(editor.getValue()).catch((err: unknown) => {
      setStatus("error");
      appendConsole(err instanceof Error ? err.message : "Save failed");
      throw err;
    });
  }
  await pendingSave;
}

type RunMessage =
  | { type: "status"; status: "building" | "running" | "error" }
  | { type: "log"; stream: "stdout" | "stderr" | "sim"; line: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };

function parseRunMessage(raw: string): RunMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed as RunMessage;
  } catch {
    return null;
  }
}

function handleRunMessage(message: RunMessage): void {
  switch (message.type) {
    case "status":
      setStatus(message.status);
      if (message.status === "running" || message.status === "error") {
        runButton.disabled = false;
      }
      appendConsole(`status: ${message.status}`);
      break;
    case "log":
      appendConsole(message.line);
      break;
    case "exit":
      appendConsole(`process exited: code=${message.code ?? "null"} signal=${message.signal ?? "null"}`);
      break;
    case "error":
      setStatus("error");
      appendConsole(message.message);
      break;
  }
}

function runWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${sessionPath("/run")}`;
}

editor.onDidChangeModelContent(() => {
  scheduleSave();
});

runButton.addEventListener("click", () => {
  void (async () => {
    runButton.disabled = true;
    try {
      await flushSave();
    } catch {
      runButton.disabled = false;
      return;
    }

    activeRunSocket?.close();
    appendConsole("run requested");

    const socket = new WebSocket(runWebSocketUrl());
    activeRunSocket = socket;

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = parseRunMessage(event.data);
      if (message) {
        handleRunMessage(message);
      } else {
        appendConsole(event.data);
      }
    });

    socket.addEventListener("error", () => {
      setStatus("error");
      appendConsole("run websocket error");
    });

    socket.addEventListener("close", () => {
      if (activeRunSocket === socket) {
        activeRunSocket = undefined;
      }
      runButton.disabled = false;
    });
  })();
});

appendConsole("ready");
appendConsole(`session: ${sessionUser}`);
setStatus("idle");

function currentSessionUser(): string {
  const user = new URLSearchParams(window.location.search).get("user")?.trim();
  return user && /^[a-zA-Z0-9_-]{1,32}$/.test(user) ? user : "default";
}

function sessionPath(path: string): string {
  const params = new URLSearchParams();
  if (sessionUser !== "default") {
    params.set("user", sessionUser);
  }
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function envValue(name: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const value = env?.[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parsePortMap(value: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!value) return map;

  for (const entry of value.split(",")) {
    const [rawUser, rawPort] = entry.split("=", 2);
    const user = rawUser?.trim();
    const port = Number(rawPort?.trim());
    if (user && Number.isInteger(port) && port > 0) {
      map.set(user, port);
    }
  }

  return map;
}

function projectFileUri(user: string): string {
  const projectRootMap = parseStringMap(envValue("VITE_SPIKE_PROJECT_ROOTS"));
  const root = projectRootMap.get(user) ?? "/workspace/project";
  return `file://${root}/src/main/java/frc/robot/Robot.java`;
}

function parseStringMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;

  for (const entry of value.split(",")) {
    const [rawUser, rawValue] = entry.split("=", 2);
    const user = rawUser?.trim();
    const mapped = rawValue?.trim();
    if (user && mapped) {
      map.set(user, mapped);
    }
  }

  return map;
}

function advantageScopeUrl(user: string): string {
  const baseUrl = envValue("VITE_ASCOPE_URL") ?? "http://localhost:8080";
  const nt4ProxyOrigin = envValue("VITE_NT4_PROXY_ORIGIN");
  if (!nt4ProxyOrigin || user === "default") {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("nt4Origin", nt4ProxyOrigin);
  url.searchParams.set("nt4Path", `/sim/${encodeURIComponent(user)}/nt4`);
  return url.toString();
}
