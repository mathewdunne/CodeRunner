import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Monaco needs a worker to render and handle editing. Java has no
// language-specific worker — Monarch syntax highlighting runs on the main
// thread — so the default editor worker is sufficient for Task 3.
// Additional workers (json, ts, css, html) can be wired up later if needed.
export function setupMonaco(): void {
  self.MonacoEnvironment = {
    getWorker(_moduleId: string, _label: string) {
      return new EditorWorker();
    },
  };
}
