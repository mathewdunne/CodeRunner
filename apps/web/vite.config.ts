import { defineConfig } from "vite";

export default defineConfig({
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
    },
  },
});
