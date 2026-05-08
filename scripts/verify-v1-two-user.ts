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
    .query(
      "SELECT sim_container, lsp_container FROM container_leases WHERE sim_container IS NOT NULL OR lsp_container IS NOT NULL",
    )
    .all() as Array<{ sim_container: string | null; lsp_container: string | null }>;

  for (const row of rows) {
    for (const name of [row.sim_container, row.lsp_container]) {
      if (!name) {
        continue;
      }
      await runCommand([app.storage.config.dockerPath, "rm", "-f", name]).catch((error) => {
        console.warn(error instanceof Error ? error.message : error);
      });
    }
  }
}

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
  // Bun's WebSocket client accepts a non-standard `headers` option for
  // attaching the auth cookie. Cast through unknown so the standard DOM type
  // doesn't reject it.
  const socket = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(
    wsUrl,
    { headers: { cookie: login.cookie } },
  );
  session.socket = socket;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
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
    // Surface JDT LS lifecycle events so cold-start hangs are debuggable.
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
  if (session.closed) {
    throw new Error("LSP socket is closed");
  }
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
    if (match) {
      return match.diagnostics;
    }
    if (session.closed) {
      throw new Error(`LSP socket closed while waiting for ${uri} diagnostics.`);
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${uri} diagnostics after ${Math.round(timeoutMs / 1000)}s. ` +
      `Inspect the JDT LS container with: docker logs <frc-v1-lsp-...> --tail 200`,
  );
}

async function runLspSmoke(app: ControlApp, baseUrl: string, alice: Login, bob: Login, robotPath: string): Promise<void> {
  console.log("Opening LSP sessions for Alice and Bob...");
  const aliceLsp = await openLspSocket(baseUrl, alice);
  const bobLsp = await openLspSocket(baseUrl, bob);
  try {
    await Promise.all([initializeLspSession(aliceLsp), initializeLspSession(bobLsp)]);

    const aliceContent = await readProjectFile(app, alice, robotPath);
    const bobContent = await readProjectFile(app, bob, robotPath);
    lspNotify(aliceLsp, "textDocument/didOpen", {
      textDocument: { uri: fileUri(alice, robotPath), languageId: "java", version: 1, text: aliceContent },
    });
    lspNotify(bobLsp, "textDocument/didOpen", {
      textDocument: { uri: fileUri(bob, robotPath), languageId: "java", version: 1, text: bobContent },
    });

    console.log("Waiting for diagnostics (cold JDT LS on a WPILib project can take 3-5 minutes)...");
    const aliceDiagnostics = await waitForDiagnostics(aliceLsp, fileUri(alice, robotPath), 300_000);
    const bobDiagnostics = await waitForDiagnostics(bobLsp, fileUri(bob, robotPath), 300_000);
    console.log(`  Alice diagnostics: ${aliceDiagnostics.length}`);
    console.log(`  Bob diagnostics: ${bobDiagnostics.length}`);

    console.log("Checking completion suggestions for Alice...");
    const completion = (await lspRequest(aliceLsp, "textDocument/completion", {
      textDocument: { uri: fileUri(alice, robotPath) },
      position: { line: 0, character: 0 },
    })) as { items?: unknown[] } | unknown[] | null;
    const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
    assert(Array.isArray(items) && items.length > 0, "Expected at least one completion suggestion for Alice.");

    console.log("Breaking Bob's project, confirming Alice is unaffected...");
    const aliceErrorsBefore = aliceDiagnostics.filter((d) => d.severity === 1).length;
    await writeProjectFile(app, bob, robotPath, "package frc.robot;\npublic class Robot {\n");
    lspNotify(bobLsp, "textDocument/didChange", {
      textDocument: { uri: fileUri(bob, robotPath), version: 2 },
      contentChanges: [{ text: "package frc.robot;\npublic class Robot {\n" }],
    });
    const bobBrokenDiagnostics = await waitForBrokenDiagnostics(bobLsp, fileUri(bob, robotPath), 60_000);
    assert(
      bobBrokenDiagnostics.some((d) => d.severity === 1),
      "Expected Bob's broken file to produce error diagnostics.",
    );
    const aliceLatest = aliceLsp.diagnostics.filter((entry) => entry.uri === fileUri(alice, robotPath)).at(-1);
    const aliceErrorsAfter = (aliceLatest?.diagnostics ?? []).filter((d) => d.severity === 1).length;
    assert(aliceErrorsAfter <= aliceErrorsBefore, "Alice's error count grew after Bob's edit.");
    await writeProjectFile(app, bob, robotPath, bobContent);

    console.log("LSP smoke passed.");
  } finally {
    aliceLsp.socket.close();
    bobLsp.socket.close();
  }
}

async function waitForBrokenDiagnostics(
  session: LspSession,
  uri: string,
  timeoutMs: number,
): Promise<Array<{ message: string; severity?: number }>> {
  const startedAt = Date.now();
  let lastSeen = session.diagnostics.length;
  while (Date.now() - startedAt < timeoutMs) {
    if (session.diagnostics.length > lastSeen) {
      const latest = session.diagnostics.filter((entry) => entry.uri === uri).at(-1);
      if (latest && latest.diagnostics.some((d) => d.severity === 1)) {
        return latest.diagnostics;
      }
      lastSeen = session.diagnostics.length;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${uri} error diagnostics after edit.`);
}

if (Bun.env.VERIFY_SKIP_SIM_BUILD !== "1") {
  console.log("Building V1 sim image...");
  await runCommand(["bun", "run", "docker:build:sim"]);
}

const lspSmokeEnabled = Bun.env.VERIFY_SKIP_LSP !== "1";
if (lspSmokeEnabled && Bun.env.VERIFY_SKIP_LSP_BUILD !== "1") {
  console.log("Building V1 LSP image...");
  await runCommand(["bun", "run", "docker:build:lsp"]);
}

const root = await mkdtemp(join(tmpdir(), "frc-v1-two-user-"));
let app: ControlApp | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

try {
  app = await createApp({
    dataDir: join(root, "data"),
    sessionSecret: "verify-v1-two-user-session-secret",
    runConcurrency: 1,
    containerAutoStart: false,
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, instance) => app!.fetch(request, instance),
    websocket: app.websocket,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

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

  if (lspSmokeEnabled) {
    await runLspSmoke(app, baseUrl, alice, bob, robotPath);
  } else {
    console.log("Skipping LSP smoke (VERIFY_SKIP_LSP=1).");
  }

  console.log("V1 two-user smoke passed.");
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
