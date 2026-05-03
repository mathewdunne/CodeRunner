import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { registerDefaultDarkModernTheme } from "./vscode-dark-modern.js";

export function setupMonaco(): void {
  registerDefaultDarkModernTheme();

  self.MonacoEnvironment = {
    getWorker(_moduleId: string, _label: string) {
      return new EditorWorker();
    },
  };
}
