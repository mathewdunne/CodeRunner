import * as monaco from "monaco-editor";
import { setupMonaco } from "./monaco-setup.js";
import "./style.css";

setupMonaco();

const consoleEl = document.getElementById("console");
const editorEl = document.getElementById("editor");
const runEl = document.getElementById("run");

if (!consoleEl || !editorEl || !runEl) {
  throw new Error("Missing required DOM nodes (#console / #editor / #run)");
}

function appendConsole(line: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  const node = document.createElement("div");
  node.textContent = `[${ts}] ${line}`;
  consoleEl!.appendChild(node);
  consoleEl!.scrollTop = consoleEl!.scrollHeight;
}

async function loadRobotJava(): Promise<string> {
  const res = await fetch("/Robot.java");
  if (!res.ok) {
    throw new Error(`Failed to load Robot.java: ${res.status}`);
  }
  return res.text();
}

const initial = await loadRobotJava();

monaco.editor.create(editorEl, {
  value: initial,
  language: "java",
  theme: "vs-dark",
  automaticLayout: true,
  fontSize: 14,
  minimap: { enabled: false },
});

runEl.addEventListener("click", () => {
  appendConsole("clicked");
});

appendConsole("ready");
