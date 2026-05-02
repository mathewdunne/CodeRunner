import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const containerName = process.env.SIM_CONTAINER ?? "frc-sim-mvp";
const imageName = process.env.SIM_IMAGE ?? "frc-sim:mvp";
const projectVolume = process.env.SIM_VOLUME ?? "frc-project";
const lspContainerName = process.env.LSP_CONTAINER ?? "frc-lsp-mvp";
const lspImageName = process.env.LSP_IMAGE ?? "frc-lsp:mvp";
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

async function ensureProjectVolume(): Promise<void> {
  const inspect = await runCommand(
    "docker",
    ["volume", "inspect", projectVolume],
    { allowFailure: true },
  );
  if (inspect.trim().length > 0) {
    return;
  }
  console.log(`[sim] creating volume ${projectVolume}`);
  await runCommand("docker", ["volume", "create", projectVolume]);
}

type EnsureContainerSpec = {
  tag: string; // log prefix, e.g. "sim" / "lsp"
  containerName: string;
  imageName: string;
  runArgs: string[]; // appended after `docker run -d --name <name>`, before image
};

async function ensureContainer(spec: EnsureContainerSpec): Promise<void> {
  const imageId = (await runCommand("docker", ["image", "inspect", "-f", "{{.Id}}", spec.imageName])).trim();
  const inspect = await runCommand(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", spec.containerName],
    { allowFailure: true },
  );
  const state = inspect.trim();

  if (state === "true" || state === "false") {
    const containerImageId = (await runCommand(
      "docker",
      ["inspect", "-f", "{{.Image}}", spec.containerName],
    )).trim();

    if (containerImageId !== imageId) {
      console.log(`[${spec.tag}] replacing ${spec.containerName}; ${spec.imageName} was rebuilt`);
      if (state === "true") {
        await runCommand("docker", ["stop", spec.containerName]);
      }
      // Named volumes referenced in spec.runArgs are intentionally preserved
      // across container replacements so user edits survive image rebuilds.
      await runCommand("docker", ["rm", spec.containerName]);
    } else if (state === "true") {
      console.log(`[${spec.tag}] ${spec.containerName} already running`);
      return;
    } else {
      console.log(`[${spec.tag}] starting existing container ${spec.containerName}`);
      await runCommand("docker", ["start", spec.containerName]);
      return;
    }
  }

  console.log(`[${spec.tag}] creating ${spec.containerName} from ${spec.imageName}`);
  await runCommand("docker", [
    "run",
    "-d",
    "--name",
    spec.containerName,
    ...spec.runArgs,
    spec.imageName,
  ]);
}

async function ensureSimContainer(): Promise<void> {
  await ensureProjectVolume();
  await ensureContainer({
    tag: "sim",
    containerName,
    imageName,
    runArgs: [
      "-p",
      "5810:5810",
      "-v",
      `${projectVolume}:/workspace/project`,
      "--memory=2g",
    ],
  });
}

async function ensureLspContainer(): Promise<void> {
  await ensureContainer({
    tag: "lsp",
    containerName: lspContainerName,
    imageName: lspImageName,
    runArgs: [
      // No port publish: backend reaches jdtls only via `docker exec`.
      "-v",
      `${projectVolume}:/workspace/project`,
      // jdtls's JVM is configured with -Xmx1500m, but Buildship's gradle
      // import + Eclipse's classpath builder need substantial off-heap memory
      // and Metaspace. 2GB triggers the OOM killer mid-import. 4GB gives
      // comfortable headroom for the cold-start path. See decision 007.
      "--memory=4g",
    ],
  });
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

await Promise.all([ensureSimContainer(), ensureLspContainer()]);

const children = [
  startProcess("ascope", [tsxCli, "scripts/serve-ascope-lite.ts"]),
  startProcess("server", [tsxCli, "apps/server/src/main.ts"]),
  startProcess("web", [viteCli], join(repoRoot, "apps", "web")),
];

function shutdown(): void {
  console.log("[dev] stopping host dev processes; sim and lsp containers are left running");
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
