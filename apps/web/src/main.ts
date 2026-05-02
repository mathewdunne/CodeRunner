import * as monaco from "monaco-editor";
import { setupMonaco } from "./monaco-setup.js";
import { setupTextMate, THEME_NAME } from "./textmate-setup.js";
import { startLanguageClient } from "./lsp-setup.js";
import "./style.css";

setupMonaco();
await setupTextMate();

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

function appendConsole(line: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const node = document.createElement("div");
  node.textContent = `[${ts}] ${line}`;
  consoleNode.appendChild(node);
  consoleNode.scrollTop = consoleNode.scrollHeight;
}

type Status = "idle" | "saving" | "saved" | "building" | "running" | "error" | "lsp-loading";

function setStatus(status: Status): void {
  statusNode.textContent = status;
  statusNode.dataset.status = status;
}

async function loadRobotJava(): Promise<string> {
  const res = await fetch("/file");
  if (!res.ok) {
    throw new Error(`Failed to load Robot.java: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

const initial = await loadRobotJava();

// The model URI must match the path jdtls sees inside the LSP container so
// completions and diagnostics resolve to the right document.
const modelUri = monaco.Uri.parse("file:///workspace/project/src/main/java/frc/robot/Robot.java");
const model = monaco.editor.createModel(initial, "java", modelUri);

const editor = monaco.editor.create(editorEl, {
  model,
  theme: THEME_NAME,
  automaticLayout: true,
  fontSize: 14,
  minimap: { enabled: false },
});

setStatus("lsp-loading");
const languageClient = startLanguageClient();
languageClient.ready
  .then(() => {
    appendConsole("language server ready");
    setStatus("idle");
  })
  .catch((err: unknown) => {
    appendConsole(err instanceof Error ? `language server failed: ${err.message}` : "language server failed");
    setStatus("error");
  });
window.addEventListener("beforeunload", () => {
  void languageClient.dispose();
});

let saveTimer: number | undefined;
let pendingSave: Promise<void> | undefined;
let activeRunSocket: WebSocket | undefined;

async function saveRobotJava(contents: string): Promise<void> {
  setStatus("saving");
  const res = await fetch("/file", {
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
  return `${protocol}//${window.location.host}/run`;
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
// status is left as "lsp-loading" until startLanguageClient resolves, so the
// pill reflects the language server's startup latency rather than flashing
// "idle" while jdtls is still booting.
