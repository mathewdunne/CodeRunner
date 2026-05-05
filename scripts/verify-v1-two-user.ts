import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunServerMessage } from "../packages/contracts/src";
import { createApp, type ControlApp } from "../apps/control/src/app";
import type { RunConnection } from "../apps/control/src/runs";
import type { WorkspaceRow } from "../apps/control/src/storage";

type Login = {
  cookie: string;
  workspace: WorkspaceRow;
};

type RunProbe = {
  messages: RunServerMessage[];
  connection: RunConnection;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCommand(args: string[], options: { env?: Record<string, string> } = {}): Promise<string> {
  const subprocess = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...options.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed with exit ${exitCode}\n${stderr || stdout}`);
  }
  return stdout;
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 180_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function login(app: ControlApp, displayName: string): Promise<Login> {
  const response = await app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ displayName }),
    }),
  );
  assert(response.status === 303, `Expected ${displayName} login to redirect, got ${response.status}.`);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, `Expected ${displayName} login to set a cookie.`);
  const cookie = setCookie.split(";")[0] ?? "";
  const slug = response.headers.get("location")?.match(/^\/u\/([^/]+)\//u)?.[1];
  assert(slug, `Expected ${displayName} login redirect to include a workspace slug.`);
  const workspace = app.storage.findWorkspaceBySlug(slug);
  assert(workspace, `Expected workspace ${slug} to exist.`);
  return { cookie, workspace };
}

async function readProjectFile(app: ControlApp, login: Login, path: string): Promise<string> {
  const response = await app.fetch(
    new Request(`http://localhost/u/${login.workspace.slug}/api/files?path=${encodeURIComponent(path)}`, {
      headers: { cookie: login.cookie },
    }),
  );
  assert(response.ok, `Expected read of ${path} for ${login.workspace.slug} to succeed, got ${response.status}.`);
  const body = (await response.json()) as { contents?: unknown };
  assert(typeof body.contents === "string", `Expected ${path} response to include contents.`);
  return body.contents;
}

async function writeProjectFile(app: ControlApp, login: Login, path: string, contents: string): Promise<void> {
  const response = await app.fetch(
    new Request(`http://localhost/u/${login.workspace.slug}/api/files?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        cookie: login.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ contents }),
    }),
  );
  assert(response.ok, `Expected write of ${path} for ${login.workspace.slug} to succeed, got ${response.status}.`);
}

function connectRun(app: ControlApp, workspace: WorkspaceRow): RunProbe {
  const messages: RunServerMessage[] = [];
  const connection = app.runs.connect(workspace, (message) => messages.push(message));
  return { messages, connection };
}

function hasStatus(probe: RunProbe, status: string): boolean {
  return probe.messages.some((message) => message.type === "status" && message.status === status);
}

function lastStatus(probe: RunProbe): string | null {
  const statuses = probe.messages.filter((message) => message.type === "status");
  const message = statuses.at(-1);
  return message?.type === "status" ? message.status : null;
}

async function assertSimProcessAlive(app: ControlApp, workspace: WorkspaceRow): Promise<void> {
  const lease = app.storage.getContainerLease(workspace.id);
  assert(lease?.sim_container, `Expected ${workspace.slug} to have a sim container lease.`);
  await runCommand([
    app.storage.config.dockerPath,
    "exec",
    lease.sim_container,
    "bash",
    "-lc",
    'test -f "$HOME/sim.pid" && kill -0 "$(cat "$HOME/sim.pid")"',
  ]);
}

async function removeManagedContainers(app: ControlApp): Promise<void> {
  const rows = app.storage.db
    .query("SELECT sim_container FROM container_leases WHERE sim_container IS NOT NULL")
    .all() as Array<{ sim_container: string }>;

  for (const row of rows) {
    await runCommand([app.storage.config.dockerPath, "rm", "-f", row.sim_container]).catch((error) => {
      console.warn(error instanceof Error ? error.message : error);
    });
  }
}

if (Bun.env.VERIFY_SKIP_SIM_BUILD !== "1") {
  console.log("Building V1 sim image...");
  await runCommand(["bun", "run", "docker:build:sim"]);
}

const root = await mkdtemp(join(tmpdir(), "frc-v1-two-user-"));
let app: ControlApp | null = null;

try {
  app = await createApp({
    dataDir: join(root, "data"),
    sessionSecret: "verify-v1-two-user-session-secret",
    runConcurrency: 1,
    containerAutoStart: false,
  });

  const alice = await login(app, "alice");
  const bob = await login(app, "bob");
  assert(alice.workspace.project_path !== bob.workspace.project_path, "Alice and Bob must have distinct project dirs.");

  const robotPath = "src/main/java/frc/robot/Robot.java";
  const aliceOriginal = await readProjectFile(app, alice, robotPath);
  const bobOriginal = await readProjectFile(app, bob, robotPath);
  await writeProjectFile(app, bob, robotPath, `${bobOriginal}\n// bob-only smoke marker\n`);
  assert(!(await readProjectFile(app, alice, robotPath)).includes("bob-only smoke marker"), "Bob edit leaked to Alice.");

  console.log("Checking syntax-error recovery...");
  await writeProjectFile(app, alice, robotPath, "package frc.robot;\npublic class Robot {\n");
  const brokenAlice = connectRun(app, alice.workspace);
  app.runs.start(alice.workspace, brokenAlice.connection);
  await waitFor("Alice syntax-error run to fail", () => hasStatus(brokenAlice, "failed"));
  app.runs.disconnect(brokenAlice.connection);
  await writeProjectFile(app, alice, robotPath, aliceOriginal);

  console.log("Checking queued two-user run behavior...");
  const aliceRun = connectRun(app, alice.workspace);
  const bobRun = connectRun(app, bob.workspace);
  let aliceRunningAt = 0;
  let bobBuildingAt = 0;
  aliceRun.messages.length = 0;
  bobRun.messages.length = 0;
  const aliceOriginalSend = aliceRun.connection.send;
  const bobOriginalSend = bobRun.connection.send;
  aliceRun.connection.send = (message) => {
    aliceOriginalSend(message);
    if (message.type === "status" && message.status === "running" && aliceRunningAt === 0) {
      aliceRunningAt = Date.now();
    }
  };
  bobRun.connection.send = (message) => {
    bobOriginalSend(message);
    if (message.type === "status" && message.status === "building" && bobBuildingAt === 0) {
      bobBuildingAt = Date.now();
    }
  };

  app.runs.start(alice.workspace, aliceRun.connection);
  app.runs.start(bob.workspace, bobRun.connection);
  await waitFor("Alice to reach running", () => aliceRunningAt > 0);
  assert(bobBuildingAt === 0 || bobBuildingAt >= aliceRunningAt, "Bob started building before Alice reached running.");
  await waitFor("Bob to start after Alice readiness", () => bobBuildingAt > 0);
  assert(lastStatus(bobRun) === "building" || hasStatus(bobRun, "running"), "Expected Bob to leave the queue.");
  await assertSimProcessAlive(app, alice.workspace);

  app.runs.stopWorkspace(alice.workspace.id);
  app.runs.stopWorkspace(bob.workspace.id);
  await Bun.sleep(1_000);
  app.runs.disconnect(aliceRun.connection);
  app.runs.disconnect(bobRun.connection);

  console.log("V1 two-user smoke passed.");
} finally {
  if (app) {
    await removeManagedContainers(app);
    app.close();
  }
  await rm(root, { recursive: true, force: true });
}
