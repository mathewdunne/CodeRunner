import { defineConfig } from "vite";

export default defineConfig({
  // `worker.format: 'es'` is required by monaco-languageclient's transitive
  // @codingame/monaco-vscode-api workers (they ship as ES modules).
  worker: {
    format: "es",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  build: {
    target: "esnext",
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/file": "http://127.0.0.1:4000",
      "/health": "http://127.0.0.1:4000",
      "/run": {
        target: "ws://127.0.0.1:4000",
        ws: true,
      },
      "/lsp": {
        target: "ws://127.0.0.1:4000",
        ws: true,
      },
    },
  },
});
