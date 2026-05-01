import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const containerName = process.env.SIM_CONTAINER ?? "frc-sim-mvp";
const imageName = process.env.SIM_IMAGE ?? "frc-sim:mvp";
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = join(repoRoot, "node_modules", "vite", "bin", "vite.js");

function runCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0 || options.allowFailure) {
        resolve(out);
        return;
      }
      const err = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(err.length > 0 ? err : `${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function ensureSimContainer(): Promise<void> {
  const inspect = await runCommand(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", containerName],
    { allowFailure: true },
  );
  const state = inspect.trim();

  if (state === "true") {
    console.log(`[sim] ${containerName} already running`);
    return;
  }

  if (state === "false") {
    console.log(`[sim] starting existing container ${containerName}`);
    await runCommand("docker", ["start", containerName]);
    return;
  }

  console.log(`[sim] creating ${containerName} from ${imageName}`);
  await runCommand("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    "5810:5810",
    "--memory=2g",
    imageName,
  ]);
}

function startProcess(name: string, args: string[], cwd = repoRoot): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd,
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

await ensureSimContainer();

const children = [
  startProcess("ascope", [tsxCli, "scripts/serve-ascope-lite.ts"]),
  startProcess("server", [tsxCli, "apps/server/src/main.ts"]),
  startProcess("web", [viteCli], join(repoRoot, "apps", "web")),
];

function shutdown(): void {
  console.log("[dev] stopping host dev processes; sim container is left running");
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

await new Promise<void>((resolve) => {
  for (const child of children) {
    child.on("exit", () => {
      if (children.some((candidate) => candidate.exitCode === null && !candidate.killed)) {
        return;
      }
      resolve();
    });
  }
});
