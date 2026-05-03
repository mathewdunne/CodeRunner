import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

export function setupMonaco(): void {
  self.MonacoEnvironment = {
    getWorker(_moduleId: string, _label: string) {
      return new EditorWorker();
    },
  };
}
