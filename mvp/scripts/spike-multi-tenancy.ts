import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

type SpikeSession = {
  user: string;
  simContainer: string;
  simPort: number;
  lspContainer: string;
  lspPort: number;
};

type StatsRow = {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
};

const simImage = process.env.SIM_IMAGE ?? "frc-sim:mvp";
const lspImage = process.env.LSP_IMAGE ?? "frc-lsp:mvp";
const sessions: SpikeSession[] = [
  { user: "alice", simContainer: "frc-spike-sim-alice", simPort: 5811, lspContainer: "frc-spike-lsp-alice", lspPort: 30013 },
  { user: "bob", simContainer: "frc-spike-sim-bob", simPort: 5812, lspContainer: "frc-spike-lsp-bob", lspPort: 30023 },
  { user: "charlie", simContainer: "frc-spike-sim-charlie", simPort: 5813, lspContainer: "frc-spike-lsp-charlie", lspPort: 30033 },
];

const command = process.argv[2] ?? "help";

function run(commandName: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  const result = spawnSync(commandName, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
  });

  if (result.status === 0 || options.allowFailure) {
    return result.stdout;
  }

  const stderr = result.stderr.trim();
  throw new Error(stderr.length > 0 ? stderr : `${commandName} ${args.join(" ")} exited ${result.status}`);
}

function containerState(name: string): string | null {
  const out = run("docker", ["inspect", "-f", "{{.State.Running}}", name], { allowFailure: true }).trim();
  return out === "true" || out === "false" ? out : null;
}

function ensureContainer(name: string, image: string, args: string[]): void {
  const state = containerState(name);
  if (state === "true") {
    console.log(`${name} already running`);
    return;
  }
  if (state === "false") {
    console.log(`starting ${name}`);
    run("docker", ["start", name]);
    return;
  }

  console.log(`creating ${name}`);
  run("docker", ["run", "-d", "--name", name, ...args, image]);
}

async function up(): Promise<void> {
  for (const session of sessions) {
    ensureContainer(session.simContainer, simImage, ["-p", `${session.simPort}:5810`, "--memory=2g"]);
    ensureContainer(session.lspContainer, lspImage, ["-p", `${session.lspPort}:30003`, "--memory=2g"]);
  }
  printEnv();
}

function down(): void {
  for (const session of sessions) {
    for (const name of [session.simContainer, session.lspContainer]) {
      if (containerState(name) !== null) {
        console.log(`removing ${name}`);
        run("docker", ["rm", "-f", name], { allowFailure: true });
      }
    }
  }
}

function printEnv(): void {
  console.log("");
  console.log("Backend:");
  console.log(`  SIM_SESSION_CONTAINERS=${sessions.map((session) => `${session.user}=${session.simContainer}`).join(",")}`);
  console.log("Web:");
  console.log(`  VITE_SPIKE_LSP_PORTS=${sessions.map((session) => `${session.user}=${session.lspPort}`).join(",")}`);
  console.log("Router:");
  console.log(`  SPIKE_NT4_SESSIONS=${sessions.map((session) => `${session.user}=127.0.0.1:${session.simPort}`).join(",")}`);
}

function dockerStats(names: string[]): StatsRow[] {
  const out = run("docker", ["stats", "--no-stream", "--format", "json", ...names]);
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StatsRow);
}

function parseMiB(memUsage: string): number {
  const raw = memUsage.split("/", 1)[0]?.trim() ?? "0MiB";
  const match = /^([\d.]+)([KMGT]?i?B)$/.exec(raw);
  if (!match) return 0;

  const value = Number(match[1]);
  const unit = match[2] ?? "MiB";
  const multipliers = new Map<string, number>([
    ["B", 1 / 1024 / 1024],
    ["KiB", 1 / 1024],
    ["MiB", 1],
    ["GiB", 1024],
    ["TiB", 1024 * 1024],
  ]);
  return value * (multipliers.get(unit) ?? 1);
}

async function stats(): Promise<void> {
  const names = sessions.flatMap((session) => [session.simContainer, session.lspContainer]);
  const samples = Number(process.env.SPIKE_STATS_SAMPLES ?? 30);
  const delayMs = Number(process.env.SPIKE_STATS_DELAY_MS ?? 1000);
  const highWater = new Map<string, { memoryMiB: number; cpu: number }>();

  for (let i = 0; i < samples; i += 1) {
    for (const row of dockerStats(names)) {
      const current = highWater.get(row.Name) ?? { memoryMiB: 0, cpu: 0 };
      current.memoryMiB = Math.max(current.memoryMiB, parseMiB(row.MemUsage));
      current.cpu = Math.max(current.cpu, Number(row.CPUPerc.replace("%", "")));
      highWater.set(row.Name, current);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  console.log("| Container | Max CPU % | Max memory MiB |");
  console.log("| --- | ---: | ---: |");
  for (const [name, row] of Array.from(highWater).sort()) {
    console.log(`| ${name} | ${row.cpu.toFixed(2)} | ${row.memoryMiB.toFixed(1)} |`);
  }
}

async function lifecycle(): Promise<void> {
  const name = "frc-spike-lifecycle-sim";
  run("docker", ["rm", "-f", name], { allowFailure: true });

  const start = performance.now();
  run("docker", ["run", "-d", "--name", name, "-p", "5899:5810", "--memory=2g", simImage]);
  const containerCreatedMs = performance.now() - start;

  let ntReadyMs: number | null = null;
  for (let i = 0; i < 120; i += 1) {
    const probe = spawnSync("docker", ["logs", name], { encoding: "utf8", windowsHide: true });
    if (/NT: (?:server: listening|Listening on NT4 port)|Robot program startup complete/.test(probe.stdout + probe.stderr)) {
      ntReadyMs = performance.now() - start;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`sim container created in ${(containerCreatedMs / 1000).toFixed(2)}s`);
  console.log(ntReadyMs === null ? "NT4 readiness not observed within 60s" : `NT4 readiness observed in ${(ntReadyMs / 1000).toFixed(2)}s`);
  run("docker", ["rm", "-f", name], { allowFailure: true });
}

async function main(): Promise<void> {
  switch (command) {
    case "up":
      await up();
      break;
    case "down":
      down();
      break;
    case "stats":
      await stats();
      break;
    case "lifecycle":
      await lifecycle();
      break;
    default:
      console.log("Usage: tsx scripts/spike-multi-tenancy.ts <up|down|stats|lifecycle>");
      break;
  }
}

await main();
