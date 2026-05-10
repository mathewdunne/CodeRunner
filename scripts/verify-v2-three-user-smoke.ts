#!/usr/bin/env bun
/**
 * V2 three-user classroom smoke test.
 *
 * Verifies that three concurrent students can independently:
 *   1. Log in and get isolated workspaces
 *   2. Edit files without cross-talk (verified via filesystem)
 *   3. Run builds (with queue behavior at concurrency=2)
 *   4. Reach sim-running state with NT4 readiness
 *   5. Access their editor proxies
 *
 * Environment:
 *   VERIFY_SKIP_BUILD=1  Skip rebuilding the code image
 *
 * Usage:
 *   bun scripts/verify-v2-three-user-smoke.ts
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

const users = ["alice", "bob", "charlie"];

if (Bun.env.VERIFY_SKIP_BUILD !== "1") {
  console.log("Building V2 code image...");
  await runCommand(["bun", "run", "docker:build:code"]);
}

const root = await mkdtemp(join(tmpdir(), "frc-v2-three-user-"));
let app: ControlApp | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

try {
  app = await createApp({
    dataDir: join(root, "data"),
    sessionSecret: "verify-v2-three-user-session-secret",
    runConcurrency: 2,
    containerAutoStart: false,
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, instance) => app!.fetch(request, instance),
    websocket: app.websocket,
  });

  // ─── Phase 1: Login isolation ───────────────────────────────────────
  console.log("\n═══ Phase 1: Login and workspace isolation ═══");

  const logins: Login[] = [];
  for (const name of users) {
    const user = await login(app, name);
    logins.push(user);
    console.log(`  ✓ ${name} → workspace ${user.workspace.slug} (${user.workspace.id})`);
  }

  const projectPaths = new Set(logins.map((l) => l.workspace.project_path));
  assert(projectPaths.size === users.length, `Expected ${users.length} distinct project paths, got ${projectPaths.size}.`);

  // Verify cross-workspace access is rejected
  for (let i = 0; i < logins.length; i++) {
    for (let j = 0; j < logins.length; j++) {
      if (i === j) continue;
      const response = await app.fetch(
        new Request(`http://localhost/u/${logins[j]!.workspace.slug}/api/session`, {
          headers: { cookie: logins[i]!.cookie },
        }),
      );
      assert(response.status === 403, `Expected ${users[i]} to be rejected from ${users[j]}'s workspace, got ${response.status}.`);
    }
  }
  console.log("  ✓ Cross-workspace access correctly rejected");

  // ─── Phase 2: File isolation ────────────────────────────────────────
  console.log("\n═══ Phase 2: File isolation ═══");

  const robotPath = "src/main/java/frc/robot/Robot.java";

  const originals: string[] = [];
  for (const user of logins) {
    originals.push(await readProjectFileFromDisk(user.workspace, robotPath));
  }

  // Each user writes a unique marker
  for (let i = 0; i < logins.length; i++) {
    await writeProjectFileToDisk(logins[i]!.workspace, robotPath, `${originals[i]}\n// ${users[i]}-marker-${Date.now()}\n`);
  }

  // Verify no cross-talk
  for (let i = 0; i < logins.length; i++) {
    const content = await readProjectFileFromDisk(logins[i]!.workspace, robotPath);
    assert(content.includes(`${users[i]}-marker`), `Expected ${users[i]}'s file to contain their marker.`);
    for (let j = 0; j < users.length; j++) {
      if (i === j) continue;
      assert(!content.includes(`${users[j]}-marker`), `${users[i]}'s file contains ${users[j]}'s marker!`);
    }
  }
  console.log("  ✓ File edits are isolated between all 3 users");

  // Restore originals
  for (let i = 0; i < logins.length; i++) {
    await writeProjectFileToDisk(logins[i]!.workspace, robotPath, originals[i]!);
  }

  // ─── Phase 3: Queued runs with concurrency=2 ───────────────────────
  console.log("\n═══ Phase 3: Concurrent builds with queue (concurrency=2) ═══");

  const probes: RunProbe[] = logins.map((l) => connectRun(app!, l.workspace));
  const buildingTimes: number[] = [0, 0, 0];
  const runningTimes: number[] = [0, 0, 0];

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]!;
    const originalSend = probe.connection.send;
    probe.connection.send = (message) => {
      originalSend(message);
      if (message.type === "status") {
        if (message.status === "building" && buildingTimes[i] === 0) buildingTimes[i] = Date.now();
        if (message.status === "running" && runningTimes[i] === 0) runningTimes[i] = Date.now();
      }
    };
  }

  // Start all 3 runs simultaneously
  for (let i = 0; i < logins.length; i++) {
    app.runs.start(logins[i]!.workspace, probes[i]!.connection);
  }

  // With concurrency=2, at most 2 should be building at once; 1 should queue
  await waitFor("at least 2 users building", () => buildingTimes.filter((t) => t > 0).length >= 2);
  const buildingCount = buildingTimes.filter((t) => t > 0).length;
  console.log(`  ${buildingCount} users building concurrently (concurrency limit: 2)`);

  // Wait for at least one to reach running
  await waitFor("at least 1 user running", () => runningTimes.filter((t) => t > 0).length >= 1);

  // Wait for the 3rd user to start building (dequeued after a slot opens)
  await waitFor("all 3 users building or running", () =>
    buildingTimes.every((t) => t > 0) || runningTimes.filter((t) => t > 0).length >= 3
  );

  // Wait for all to reach running
  await waitFor("all 3 users reached running", () => runningTimes.filter((t) => t > 0).length >= 3, 300_000);

  // Verify sim processes alive for all users
  for (let i = 0; i < logins.length; i++) {
    await assertSimProcessAlive(app, logins[i]!.workspace);
    console.log(`  ✓ ${users[i]} sim process alive`);
  }

  // Verify NT4 alive probe for each user
  for (let i = 0; i < logins.length; i++) {
    await assertNt4AliveProbe(app, logins[i]!);
    console.log(`  ✓ ${users[i]} NT4 alive probe passed`);
  }

  // ─── Phase 4: Editor proxy ──────────────────────────────────────────
  console.log("\n═══ Phase 4: Editor proxy ═══");

  for (let i = 0; i < logins.length; i++) {
    await assertEditorProxy(app, logins[i]!);
    console.log(`  ✓ ${users[i]} editor proxy accessible`);
  }

  // ─── Cleanup ────────────────────────────────────────────────────────
  for (let i = 0; i < logins.length; i++) {
    app.runs.stopWorkspace(logins[i]!.workspace.id);
  }
  await waitFor("all 3 users stopped", () => probes.every((probe) => hasStatus(probe, "stopped")), 60_000);
  for (const probe of probes) {
    app.runs.disconnect(probe.connection);
  }

  console.log("\n═══ V2 three-user classroom smoke PASSED ═══");
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
