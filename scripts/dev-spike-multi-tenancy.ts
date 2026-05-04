import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
const simSessionContainers = "alice=frc-spike-sim-alice,bob=frc-spike-sim-bob,charlie=frc-spike-sim-charlie";
const lspPorts = "alice=30013,bob=30023,charlie=30033";
const nt4Sessions = "alice=127.0.0.1:5811,bob=127.0.0.1:5812,charlie=127.0.0.1:5813";

function startProcess(name: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const prefix = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.length > 0) console.log(`[${name}] ${line}`);
    }
  };

  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code, signal) => {
    console.log(`[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  return child;
}

const children = [
  startProcess("router", [tsxCli, "apps/router/src/main.ts"], {
    env: { SPIKE_NT4_SESSIONS: nt4Sessions },
  }),
  startProcess("ascope", [tsxCli, "scripts/serve-ascope-lite.ts"]),
  startProcess("server", [tsxCli, "apps/server/src/main.ts"], {
    env: { SIM_SESSION_CONTAINERS: simSessionContainers },
  }),
  startProcess("web", [viteCli], {
    cwd: join(repoRoot, "apps", "web"),
    env: {
      VITE_SPIKE_LSP_PORTS: lspPorts,
      VITE_NT4_PROXY_ORIGIN: "http://localhost:4100",
    },
  }),
];

function shutdown(): void {
  console.log("[spike] stopping host dev processes; spike containers are left running");
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.once("SIGINT", () => {
  shutdown();
  process.exit(130);
});

process.once("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

await new Promise<void>((resolvePromise) => {
  for (const child of children) {
    child.on("exit", () => {
      if (children.some((candidate) => candidate.exitCode === null && !candidate.killed)) {
        return;
      }
      resolvePromise();
    });
  }
});
