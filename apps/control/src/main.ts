import { createApp } from "./app";

function logConfig(app: Awaited<ReturnType<typeof createApp>>): void {
  const c = app.storage.config;
  const simRange = `${c.simPortRange.start}-${c.simPortRange.end}`;
  const vscodeRange = `${c.vscodePortRange.start}-${c.vscodePortRange.end}`;
  const maxStudents = Math.min(
    c.simPortRange.end - c.simPortRange.start + 1,
    c.vscodePortRange.end - c.vscodePortRange.start + 1,
  );
  console.log("─── V2 Configuration ───");
  console.log(`  Data dir:            ${c.dataDir}`);
  console.log(`  Code image:          ${c.codeImage}  (memory: ${c.codeMemoryLimit})`);
  console.log(`  Sim ports:           ${simRange}`);
  console.log(`  VSCode ports:        ${vscodeRange}`);
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

console.log(`V2 control plane listening on http://localhost:${server.port}`);
