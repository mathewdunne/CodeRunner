#!/usr/bin/env bun
/**
 * V2 two-user verification test.
 *
 * Verifies that two concurrent students can independently:
 *   1. Log in and get isolated workspaces
 *   2. Edit files without cross-talk (verified via filesystem)
 *   3. Build/run sims via the run queue
 *   4. Reach sim-running state with NT4 readiness
 *   5. Access their editor proxy
 *
 * Environment:
 *   VERIFY_SKIP_BUILD=1  Skip rebuilding the code image
 *
 * Usage:
 *   bun scripts/verify-v2-two-user.ts
 */

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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

function readProjectFileFromDisk(workspace: WorkspaceRow, relativePath: string): Promise<string> {
  return readFile(join(workspace.project_path, relativePath), "utf-8");
}

async function writeProjectFileToDisk(workspace: WorkspaceRow, relativePath: string, contents: string): Promise<void> {
  await writeFile(join(workspace.project_path, relativePath), contents, "utf-8");
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
  assert(lease?.vscode_container, `Expected ${workspace.slug} to have a code container lease.`);
  await runCommand([
    app.storage.config.dockerPath,
    "exec",
    lease.vscode_container,
    "bash",
    "-lc",
    'test -f "$HOME/sim.pid" && kill -0 "$(cat "$HOME/sim.pid")"',
  ]);
}

async function assertNt4AliveProbe(app: ControlApp, login: Login): Promise<void> {
  const response = await app.fetch(
    new Request(`http://localhost/u/${login.workspace.slug}/sim/alive`, {
      headers: { cookie: login.cookie },
    }),
  );
  assert(response.status === 200, `Expected NT4 alive probe for ${login.workspace.slug} to return 200, got ${response.status}.`);
}

async function assertEditorProxy(app: ControlApp, login: Login): Promise<void> {
  const response = await app.fetch(
    new Request(`http://localhost/u/${login.workspace.slug}/vscode/`, {
      headers: { cookie: login.cookie },
    }),
  );
  assert(response.status === 200, `Expected editor proxy for ${login.workspace.slug} to return 200, got ${response.status}.`);
  const body = await response.text();
  const hasMarker = body.includes("vscode") || body.includes("workbench");
  assert(hasMarker, `Expected editor proxy response to contain vscode marker for ${login.workspace.slug}.`);
}

async function removeManagedContainers(app: ControlApp): Promise<void> {
  const rows = app.storage.db
    .query(
      "SELECT vscode_container FROM container_leases WHERE vscode_container IS NOT NULL",
    )
    .all() as Array<{ vscode_container: string | null }>;

  for (const row of rows) {
    if (!row.vscode_container) continue;
    await runCommand([app.storage.config.dockerPath, "rm", "-f", row.vscode_container]).catch((error) => {
      console.warn(error instanceof Error ? error.message : error);
    });
  }
}

// ─── Main test ──────────────────────────────────────────────────────────

if (Bun.env.VERIFY_SKIP_BUILD !== "1") {
  console.log("Building V2 code image...");
  await runCommand(["bun", "run", "docker:build:code"]);
}

const root = await mkdtemp(join(tmpdir(), "frc-v2-two-user-"));
let app: ControlApp | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

try {
  app = await createApp({
    dataDir: join(root, "data"),
    sessionSecret: "verify-v2-two-user-session-secret",
    runConcurrency: 1,
    containerAutoStart: false,
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, instance) => app!.fetch(request, instance),
    websocket: app.websocket,
  });

  const alice = await login(app, "alice");
  const bob = await login(app, "bob");
  assert(alice.workspace.project_path !== bob.workspace.project_path, "Alice and Bob must have distinct project dirs.");

  // ─── File isolation (filesystem-based) ────────────────────────────────
  console.log("Checking file isolation via filesystem...");
  const robotPath = "src/main/java/frc/robot/Robot.java";
  const aliceOriginal = await readProjectFileFromDisk(alice.workspace, robotPath);
  const bobOriginal = await readProjectFileFromDisk(bob.workspace, robotPath);
  await writeProjectFileToDisk(bob.workspace, robotPath, `${bobOriginal}\n// bob-only smoke marker\n`);
  const aliceAfterBobEdit = await readProjectFileFromDisk(alice.workspace, robotPath);
  assert(!aliceAfterBobEdit.includes("bob-only smoke marker"), "Bob's edit leaked to Alice.");
  console.log("  ✓ File isolation verified");

  // ─── Syntax-error recovery ────────────────────────────────────────────
  console.log("Checking syntax-error recovery...");
  await writeProjectFileToDisk(alice.workspace, robotPath, "package frc.robot;\npublic class Robot {\n");
  const brokenAlice = connectRun(app, alice.workspace);
  app.runs.start(alice.workspace, brokenAlice.connection);
  await waitFor("Alice syntax-error run to fail", () => hasStatus(brokenAlice, "failed"));
  app.runs.disconnect(brokenAlice.connection);
  await writeProjectFileToDisk(alice.workspace, robotPath, aliceOriginal);
  console.log("  ✓ Syntax-error recovery passed");

  // ─── Queued two-user run behavior ─────────────────────────────────────
  console.log("Checking queued two-user run behavior...");
  const aliceRun = connectRun(app, alice.workspace);
  const bobRun = connectRun(app, bob.workspace);
  let aliceRunningAt = 0;
  let bobBuildingAt = 0;
  let bobRunningAt = 0;
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
    if (message.type === "status" && message.status === "running" && bobRunningAt === 0) {
      bobRunningAt = Date.now();
    }
  };

  app.runs.start(alice.workspace, aliceRun.connection);
  app.runs.start(bob.workspace, bobRun.connection);
  await waitFor("Alice to reach running", () => aliceRunningAt > 0);
  assert(bobBuildingAt === 0 || bobBuildingAt >= aliceRunningAt, "Bob started building before Alice reached running.");
  await waitFor("Bob to start after Alice readiness", () => bobBuildingAt > 0);
  assert(lastStatus(bobRun) === "building" || hasStatus(bobRun, "running"), "Expected Bob to leave the queue.");
  await waitFor("Bob to reach running", () => bobRunningAt > 0, 300_000);
  await assertSimProcessAlive(app, alice.workspace);
  await assertSimProcessAlive(app, bob.workspace);
  console.log("  ✓ Queued run behavior verified");

  // ─── NT4 alive probe ──────────────────────────────────────────────────
  console.log("Checking NT4 alive probe for each user...");
  await assertNt4AliveProbe(app, alice);
  await assertNt4AliveProbe(app, bob);
  console.log("  ✓ NT4 alive probes passed");

  // ─── Editor proxy ─────────────────────────────────────────────────────
  console.log("Checking editor proxy for each user...");
  await assertEditorProxy(app, alice);
  await assertEditorProxy(app, bob);
  console.log("  ✓ Editor proxy checks passed");

  // ─── Cleanup runs ─────────────────────────────────────────────────────
  app.runs.stopWorkspace(alice.workspace.id);
  app.runs.stopWorkspace(bob.workspace.id);
  await waitFor("Alice and Bob runs to stop", () =>
    hasStatus(aliceRun, "stopped") && hasStatus(bobRun, "stopped"),
    60_000,
  );
  app.runs.disconnect(aliceRun.connection);
  app.runs.disconnect(bobRun.connection);

  console.log("\n═══ V2 two-user smoke PASSED ═══");
} finally {
  if (server) {
    server.stop(true);
  }
  if (app) {
    await removeManagedContainers(app);
    app.close();
  }
  await rm(root, { recursive: true, force: true });
}
