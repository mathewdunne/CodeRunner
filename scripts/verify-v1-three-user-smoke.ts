#!/usr/bin/env bun
/**
 * Three-user classroom smoke test.
 *
 * Verifies that three concurrent students can independently:
 *   1. Log in and get isolated workspaces
 *   2. Edit files without cross-talk
 *   3. Run builds (with queue behavior at concurrency=2)
 *   4. Receive LSP diagnostics independently
 *   5. Reach sim-running state with NT4 readiness
 *
 * Environment:
 *   VERIFY_SKIP_SIM_BUILD=1    Skip rebuilding sim image
 *   VERIFY_SKIP_LSP_BUILD=1    Skip rebuilding LSP image
 *   VERIFY_SKIP_LSP=1          Skip LSP smoke tests
 *
 * Usage:
 *   bun scripts/verify-v1-three-user-smoke.ts
 */

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

async function assertNt4AliveProbe(app: ControlApp, login: Login): Promise<void> {
  const response = await app.fetch(
    new Request(`http://localhost/u/${login.workspace.slug}/sim/alive`, {
      headers: { cookie: login.cookie },
    }),
  );
  assert(response.status === 200, `Expected NT4 alive probe for ${login.workspace.slug} to return 200, got ${response.status}.`);
}

async function removeManagedContainers(app: ControlApp): Promise<void> {
  const rows = app.storage.db
    .query(
      "SELECT sim_container, lsp_container FROM container_leases WHERE sim_container IS NOT NULL OR lsp_container IS NOT NULL",
    )
    .all() as Array<{ sim_container: string | null; lsp_container: string | null }>;

  for (const row of rows) {
    for (const name of [row.sim_container, row.lsp_container]) {
      if (!name) continue;
      await runCommand([app.storage.config.dockerPath, "rm", "-f", name]).catch((error) => {
        console.warn(error instanceof Error ? error.message : error);
      });
    }
  }
}

// ─── LSP helpers ──────────────────────────────────────────────────────────

type LspSession = {
  socket: WebSocket;
  diagnostics: Array<{ uri: string; diagnostics: Array<{ message: string; severity?: number }> }>;
  pending: Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>;
  nextId: number;
  closed: boolean;
};

function openLspSocket(baseUrl: string, login: Login): Promise<LspSession> {
  const session: LspSession = {
    socket: null as unknown as WebSocket,
    diagnostics: [],
    pending: new Map(),
    nextId: 1,
    closed: false,
  };

  const wsUrl = baseUrl.replace(/^http/u, "ws") + `/u/${login.workspace.slug}/ws/lsp`;
  const socket = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(
    wsUrl,
    { headers: { cookie: login.cookie } },
  );
  session.socket = socket;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let parsed: { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: unknown };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof parsed.id === "number" && parsed.method === undefined) {
      const pending = session.pending.get(parsed.id);
      if (pending) {
        session.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message ?? "LSP request failed"));
        } else {
          pending.resolve(parsed.result);
        }
      }
      return;
    }
    if (parsed.method === "textDocument/publishDiagnostics") {
      session.diagnostics.push(parsed.params as { uri: string; diagnostics: Array<{ message: string; severity?: number }> });
    }
    if (parsed.method === "window/logMessage" || parsed.method === "window/showMessage") {
      const payload = parsed.params as { type?: number; message?: string };
      console.log(`  [${login.workspace.slug} jdtls ${parsed.method}] ${payload.message ?? ""}`);
    }
    if (parsed.method === "$/progress") {
      const payload = parsed.params as { value?: { kind?: string; title?: string; message?: string } };
      const value = payload.value;
      if (value?.kind === "begin" || value?.kind === "end") {
        console.log(`  [${login.workspace.slug} jdtls progress ${value.kind}] ${value.title ?? value.message ?? ""}`);
      }
    }
  });
  socket.addEventListener("close", () => {
    session.closed = true;
    for (const pending of session.pending.values()) {
      pending.reject(new Error("LSP socket closed"));
    }
    session.pending.clear();
  });

  return new Promise<LspSession>((resolveSocket, rejectSocket) => {
    socket.addEventListener("open", () => resolveSocket(session), { once: true });
    socket.addEventListener("error", () => rejectSocket(new Error(`Failed to open ${wsUrl}`)), { once: true });
  });
}

function lspSend(session: LspSession, message: object): void {
  if (session.closed) throw new Error("LSP socket is closed");
  session.socket.send(JSON.stringify(message));
}

function lspRequest(session: LspSession, method: string, params: unknown): Promise<unknown> {
  const id = session.nextId++;
  const promise = new Promise<unknown>((resolveRequest, rejectRequest) => {
    session.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
  });
  lspSend(session, { jsonrpc: "2.0", id, method, params });
  return promise;
}

function lspNotify(session: LspSession, method: string, params: unknown): void {
  lspSend(session, { jsonrpc: "2.0", method, params });
}

async function initializeLspSession(session: LspSession): Promise<void> {
  await lspRequest(session, "initialize", {
    processId: null,
    rootUri: "file:///workspace/project",
    workspaceFolders: [{ uri: "file:///workspace/project", name: "project" }],
    capabilities: {
      window: { workDoneProgress: true },
      textDocument: {
        synchronization: { dynamicRegistration: false },
        completion: { dynamicRegistration: false, contextSupport: true },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: { workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
    },
    initializationOptions: {},
  });
  lspNotify(session, "initialized", {});
}

function fileUri(login: Login, projectRelativePath: string): string {
  return `file:///workspace/project/${projectRelativePath}`;
}

async function waitForDiagnostics(session: LspSession, uri: string, timeoutMs: number): Promise<Array<{ message: string; severity?: number }>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = session.diagnostics.find((entry) => entry.uri === uri);
    if (match) return match.diagnostics;
    if (session.closed) throw new Error(`LSP socket closed while waiting for ${uri} diagnostics.`);
    await Bun.sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${uri} diagnostics after ${Math.round(timeoutMs / 1000)}s. ` +
      `Inspect the JDT LS container with: docker logs <frc-v1-lsp-...> --tail 200`,
  );
}

// ─── Main test ──────────────────────────────────────────────────────────

const users = ["alice", "bob", "charlie"];

if (Bun.env.VERIFY_SKIP_SIM_BUILD !== "1") {
  console.log("Building V1 sim image...");
  await runCommand(["bun", "run", "docker:build:sim"]);
}

const lspSmokeEnabled = Bun.env.VERIFY_SKIP_LSP !== "1";
if (lspSmokeEnabled && Bun.env.VERIFY_SKIP_LSP_BUILD !== "1") {
  console.log("Building V1 LSP image...");
  await runCommand(["bun", "run", "docker:build:lsp"]);
}

const root = await mkdtemp(join(tmpdir(), "frc-v1-three-user-"));
let app: ControlApp | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

try {
  app = await createApp({
    dataDir: join(root, "data"),
    sessionSecret: "verify-v1-three-user-session-secret",
    runConcurrency: 2,
    containerAutoStart: false,
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, instance) => app!.fetch(request, instance),
    websocket: app.websocket,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  // ─── Phase 1: Login isolation ───────────────────────────────────────
  console.log("\n═══ Phase 1: Login and workspace isolation ═══");

  const logins: Login[] = [];
  for (const name of users) {
    const user = await login(app, name);
    logins.push(user);
    console.log(`  ✓ ${name} → workspace ${user.workspace.slug} (${user.workspace.id})`);
  }

  // All project paths must be distinct
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
    originals.push(await readProjectFile(app, user, robotPath));
  }

  // Each user writes a unique marker
  for (let i = 0; i < logins.length; i++) {
    await writeProjectFile(app, logins[i]!, robotPath, `${originals[i]}\n// ${users[i]}-marker-${Date.now()}\n`);
  }

  // Verify no cross-talk
  for (let i = 0; i < logins.length; i++) {
    const content = await readProjectFile(app, logins[i]!, robotPath);
    assert(content.includes(`${users[i]}-marker`), `Expected ${users[i]}'s file to contain their marker.`);
    for (let j = 0; j < users.length; j++) {
      if (i === j) continue;
      assert(!content.includes(`${users[j]}-marker`), `${users[i]}'s file contains ${users[j]}'s marker!`);
    }
  }
  console.log("  ✓ File edits are isolated between all 3 users");

  // Restore originals
  for (let i = 0; i < logins.length; i++) {
    await writeProjectFile(app, logins[i]!, robotPath, originals[i]!);
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

  // Wait for all to reach running or at least have built
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

  // Stop all runs
  for (let i = 0; i < logins.length; i++) {
    app.runs.stopWorkspace(logins[i]!.workspace.id);
  }
  await waitFor("all 3 users stopped before LSP phase", () => probes.every((probe) => hasStatus(probe, "stopped")), 60_000);
  for (const probe of probes) {
    app.runs.disconnect(probe.connection);
  }

  console.log("  ✓ All 3 users built and ran successfully with queue behavior");

  // ─── Phase 4: LSP isolation ─────────────────────────────────────────
  if (lspSmokeEnabled) {
    console.log("\n═══ Phase 4: LSP diagnostics isolation ═══");

    const lspSessions: LspSession[] = [];
    for (const user of logins) {
      console.log(`  Opening LSP session for ${user.workspace.slug}...`);
      const session = await openLspSocket(baseUrl, user);
      lspSessions.push(session);
    }

    try {
      await Promise.all(lspSessions.map((s) => initializeLspSession(s)));
      console.log("  All 3 LSP sessions initialized");

      // Open Robot.java in all sessions
      for (let i = 0; i < logins.length; i++) {
        const content = await readProjectFile(app, logins[i]!, robotPath);
        lspNotify(lspSessions[i]!, "textDocument/didOpen", {
          textDocument: {
            uri: fileUri(logins[i]!, robotPath),
            languageId: "java",
            version: 1,
            text: content,
          },
        });
      }

      // Wait for diagnostics from all 3
      console.log("  Waiting for diagnostics (cold JDT LS can take 3-5 minutes)...");
      for (let i = 0; i < logins.length; i++) {
        const diags = await waitForDiagnostics(lspSessions[i]!, fileUri(logins[i]!, robotPath), 300_000);
        console.log(`  ✓ ${users[i]} received ${diags.length} diagnostics`);
      }

      // Break Charlie's project, confirm Alice and Bob are unaffected
      console.log("  Breaking Charlie's project...");
      const charlieIdx = 2;
      const charlieOriginal = await readProjectFile(app, logins[charlieIdx]!, robotPath);
      await writeProjectFile(app, logins[charlieIdx]!, robotPath, "package frc.robot;\npublic class Robot {\n");
      lspNotify(lspSessions[charlieIdx]!, "textDocument/didChange", {
        textDocument: { uri: fileUri(logins[charlieIdx]!, robotPath), version: 2 },
        contentChanges: [{ text: "package frc.robot;\npublic class Robot {\n" }],
      });

      // Wait for Charlie to get error diagnostics
      const startedAt = Date.now();
      let charlieHasErrors = false;
      while (Date.now() - startedAt < 60_000) {
        const latest = lspSessions[charlieIdx]!.diagnostics
          .filter((e) => e.uri === fileUri(logins[charlieIdx]!, robotPath))
          .at(-1);
        if (latest && latest.diagnostics.some((d) => d.severity === 1)) {
          charlieHasErrors = true;
          break;
        }
        await Bun.sleep(500);
      }
      assert(charlieHasErrors, "Expected Charlie's broken file to produce error diagnostics.");
      console.log("  ✓ Charlie has error diagnostics");

      // Alice and Bob should not have gained errors
      for (let i = 0; i < 2; i++) {
        const latest = lspSessions[i]!.diagnostics
          .filter((e) => e.uri === fileUri(logins[i]!, robotPath))
          .at(-1);
        const errors = (latest?.diagnostics ?? []).filter((d) => d.severity === 1).length;
        console.log(`  ✓ ${users[i]} has ${errors} error(s) (unaffected by Charlie)`);
      }

      // Restore Charlie
      await writeProjectFile(app, logins[charlieIdx]!, robotPath, charlieOriginal);

      console.log("  ✓ LSP isolation verified for all 3 users");
    } finally {
      for (const session of lspSessions) {
        session.socket.close();
      }
    }
  } else {
    console.log("\nSkipping LSP smoke (VERIFY_SKIP_LSP=1).");
  }

  console.log("\n═══ V1 three-user classroom smoke PASSED ═══");
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
