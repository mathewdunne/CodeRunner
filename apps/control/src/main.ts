import { createApp } from "./app";

function logConfig(app: Awaited<ReturnType<typeof createApp>>): void {
  const c = app.storage.config;
  const simRange = `${c.simPortRange.start}-${c.simPortRange.end}`;
  const lspRange = `${c.lspPortRange.start}-${c.lspPortRange.end}`;
  const maxStudents = Math.min(
    c.simPortRange.end - c.simPortRange.start + 1,
    c.lspPortRange.end - c.lspPortRange.start + 1,
  );
  console.log("─── V1 Configuration ───");
  console.log(`  Data dir:            ${c.dataDir}`);
  console.log(`  Sim image:           ${c.simImage}  (memory: ${c.simMemoryLimit}, ports: ${simRange})`);
  console.log(`  LSP image:           ${c.lspImage}  (memory: ${c.lspMemoryLimit}, ports: ${lspRange})`);
  console.log(`  Run concurrency:     ${c.runConcurrency}`);
  console.log(`  LSP startup conc.:   ${c.lspStartupConcurrency}`);
  console.log(`  Build timeout:       ${c.runBuildTimeoutMs / 1000}s  (sim startup: ${c.simStartupTimeoutMs / 1000}s)`);
  console.log(`  Idle stop:           ${c.idleStopMinutes} min  (check every ${c.idleCheckIntervalMs / 1000}s)`);
  console.log(`  Container user:      ${c.containerUser ?? "(auto)"}`);
  console.log(`  Container auto-start:${c.containerAutoStart ? " yes" : " no"}`);
  console.log(`  Admin auth:          ${c.adminToken ? "bearer token" : "localhost-only"}`);
  console.log(`  Max students (ports): ${maxStudents}`);
  console.log("────────────────────────");
}

const port = Number(Bun.env.PORT ?? 4000);
const app = await createApp();

logConfig(app);

const server = Bun.serve({
  port,
  fetch: (request, server) => app.fetch(request, server),
  websocket: app.websocket,
});

console.log(`V1 control plane listening on http://localhost:${server.port}`);
