import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const controlPlane = "http://localhost:4000"
const proxyOpts = { target: controlPlane, ws: true, changeOrigin: true }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": proxyOpts,
      "/healthz": controlPlane,
      "/metrics": controlPlane,
      "/scope": controlPlane,
      "/coderunner-icon.png": controlPlane,
      "/favicon.ico": controlPlane,
      "^/admin/(assets|allowlist|audit-log|users|containers|workspaces|config|status)(/.*)?$": proxyOpts,
      "^/u/[^/]+/(api|ws|sim|vscode|assets|coderunner-icon\\.png|favicon\\.ico)(/.*)?$": proxyOpts,
    },
  },
})
