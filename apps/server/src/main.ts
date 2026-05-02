import Fastify from "fastify";
import fastifyWebsocket, { type WebSocket } from "@fastify/websocket";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const containerName = process.env.SIM_CONTAINER ?? "frc-sim-mvp";
const lspContainerName = process.env.LSP_CONTAINER ?? "frc-lsp-mvp";
const robotFile = "/workspace/project/src/main/java/frc/robot/Robot.java";
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";

// Launches jdtls inside the LSP container. The wildcard in -jar requires shell
// expansion, so this is run via `sh -lc`. -data points at the writable
// workspace dir baked into the image; -configuration must match the host OS
// (linux for this container's base image).
const jdtlsLaunchScript = [
  "exec java",
  "-Declipse.application=org.eclipse.jdt.ls.core.id1",
  "-Dosgi.bundles.defaultStartLevel=4",
  "-Declipse.product=org.eclipse.jdt.ls.core.product",
  "-Dlog.protocol=true",
  "-Dlog.level=ALL",
  "-Xms256m",
  "-Xmx1500m",
  "--add-modules=ALL-SYSTEM",
  "--add-opens java.base/java.util=ALL-UNNAMED",
  "--add-opens java.base/java.lang=ALL-UNNAMED",
  "-jar /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar",
  "-configuration /opt/jdtls/config_linux",
  "-data /workspace/jdtls-data",
].join(" ");

type RunStatus = "building" | "running" | "error";

type RunMessage =
  | { type: "status"; status: RunStatus }
  | { type: "log"; stream: "stdout" | "stderr" | "sim"; line: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; message: string };

type ActiveRun = {
  cancel: () => void;
};

let activeRun: ActiveRun | null = null;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 256 * 1024,
});

app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
  done(null, body);
});

// /run and /lsp are both served via @fastify/websocket. /run was originally
// hand-rolled (decision 004) when adding npm deps was inconvenient; with the
// jdtls work that constraint is gone, and a single plugin handling both
// upgrade routes is simpler than the manual handshake + custom framing.
await app.register(fastifyWebsocket, {
  options: {
    maxPayload: 4 * 1024 * 1024,
  },
});

function docker(args: string[]): ChildProcessWithoutNullStreams {
  return spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function dockerExec(args: string[]): ChildProcessWithoutNullStreams {
  return docker(["exec", ...args]);
}

function collectProcess(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolvePromise(out);
        return;
      }
      const err = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(err.length > 0 ? err : `docker exec exited with code ${code}`));
    });
  });
}

async function readRobotFile(): Promise<string> {
  return collectProcess(dockerExec([containerName, "cat", robotFile]));
}

async function writeRobotFile(contents: string): Promise<void> {
  const child = dockerExec([
    "-i",
    containerName,
    "sh",
    "-lc",
    `cat > ${quoteShell(robotFile)}`,
  ]);

  const result = collectProcess(child).then(() => undefined);
  child.stdin.end(contents);
  await result;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

app.get("/health", async () => ({ ok: true }));

app.get("/file", async (_req, reply) => {
  try {
    reply.type("text/plain; charset=utf-8");
    return await readRobotFile();
  } catch (err) {
    app.log.error(err, "Failed to read Robot.java from sim container");
    return reply.code(500).send("Failed to read Robot.java from sim container");
  }
});

app.post("/file", async (req, reply) => {
  if (typeof req.body !== "string") {
    return reply.code(400).send({ error: "Expected text/plain request body" });
  }

  try {
    await writeRobotFile(req.body);
    return reply.code(204).send();
  } catch (err) {
    app.log.error(err, "Failed to write Robot.java to sim container");
    return reply.code(500).send({ error: "Failed to write Robot.java to sim container" });
  }
});

class RunPeer {
  #socket: WebSocket;
  #closed = false;
  #onClose: Array<() => void> = [];

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("close", () => this.markClosed());
    socket.on("error", () => this.markClosed());
  }

  get closed(): boolean {
    return this.#closed || this.#socket.readyState >= 2; // CLOSING | CLOSED
  }

  sendJson(message: RunMessage): void {
    if (this.closed) return;
    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    try {
      this.#socket.close();
    } catch {
      // ignore — already closing
    }
  }

  onClose(callback: () => void): void {
    this.#onClose.push(callback);
  }

  private markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const callback of this.#onClose) {
      callback();
    }
  }
}

class LineSplitter {
  #buffer = "";
  #emit: (line: string) => void;

  constructor(emit: (line: string) => void) {
    this.#emit = emit;
  }

  push(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.#emit(line);
    }
  }

  flush(): void {
    if (this.#buffer.length > 0) {
      this.#emit(this.#buffer);
      this.#buffer = "";
    }
  }
}

function spawnDockerStep(
  args: string[],
  peer: RunPeer,
  streamName: "stdout" | "stderr" | "sim",
  onStdoutLine?: (line: string) => void,
): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = docker(args);
  const stdout = new LineSplitter((line) => {
    peer.sendJson({ type: "log", stream: streamName, line });
    onStdoutLine?.(line);
  });
  const stderr = new LineSplitter((line) => peer.sendJson({ type: "log", stream: "stderr", line }));

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stdout.flush();
      stderr.flush();
      resolvePromise({ code, signal });
    });
  });

  return { child, done };
}

function spawnRunStep(
  args: string[],
  peer: RunPeer,
  streamName: "stdout" | "stderr" | "sim",
): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  return spawnDockerStep(["exec", ...args], peer, streamName);
}

function spawnDockerLogs(
  since: string,
  peer: RunPeer,
  onLine: (line: string) => void,
): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  return spawnDockerStep(["logs", "--follow", "--since", since, containerName], peer, "sim", onLine);
}

function killChild(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 2000).unref();
}

function killChildren(children: Set<ChildProcessWithoutNullStreams>): void {
  for (const child of children) {
    killChild(child);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function handleRun(peer: RunPeer): Promise<void> {
  activeRun?.cancel();

  const currentChildren = new Set<ChildProcessWithoutNullStreams>();
  let canceled = false;
  const session: ActiveRun = {
    cancel: () => {
      canceled = true;
      killChildren(currentChildren);
      peer.close();
    },
  };
  activeRun = session;
  peer.onClose(() => {
    canceled = true;
    killChildren(currentChildren);
    if (activeRun === session) {
      activeRun = null;
    }
  });

  const trackChild = (child: ChildProcessWithoutNullStreams): void => {
    currentChildren.add(child);
    child.on("close", () => currentChildren.delete(child));
  };

  const runStep = async (
    args: string[],
    streamName: "stdout" | "stderr" | "sim",
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const { child, done } = spawnRunStep(args, peer, streamName);
    trackChild(child);
    return await done;
  };

  const streamSimLogsUntilExit = async (
    since: string,
    onLine: (line: string) => void,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const logs = spawnDockerLogs(since, peer, onLine);
    const waitForSimExitScript = `
pid="$(cat /workspace/sim.pid 2>/dev/null || true)"
if [ -z "$pid" ]; then
  exit 0
fi

while [ -r "/proc/$pid/stat" ]; do
  state="$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || true)"
  if [ "$state" = "Z" ]; then
    exit 0
  fi
  sleep 0.5
done
`;
    const watcher = spawnRunStep([
      containerName,
      "sh",
      "-lc",
      waitForSimExitScript,
    ], peer, "stderr");

    trackChild(logs.child);
    trackChild(watcher.child);

    const watcherResult = await watcher.done;
    await delay(500);
    killChild(logs.child);
    await logs.done;
    return watcherResult;
  };

  try {
    peer.sendJson({ type: "status", status: "building" });

    await runStep([containerName, "/usr/local/bin/stop-sim.sh"], "stdout");

    const logStart = new Date(Date.now() - 1000).toISOString();
    const start = await runStep([
      containerName,
      "/usr/local/bin/start-sim.sh",
    ], "sim");

    if (start.code !== 0) {
      peer.sendJson({ type: "status", status: "error" });
      peer.sendJson({ type: "exit", code: start.code, signal: start.signal });
      peer.close();
      return;
    }

    let reportedRunning = false;
    let sawBuildFailure = false;
    const sim = await streamSimLogsUntilExit(logStart, (line) => {
      if (/BUILD FAILED/.test(line)) {
        sawBuildFailure = true;
      }
      if (
        !reportedRunning &&
        /Robot program startup complete|NT: (?:server: listening|Listening on NT3 port|Listening on NT4 port)/.test(line)
      ) {
        reportedRunning = true;
        peer.sendJson({ type: "status", status: "running" });
      }
    });

    if (!canceled) {
      peer.sendJson({ type: "exit", code: reportedRunning ? sim.code : 1, signal: sim.signal });
      if (!reportedRunning || sawBuildFailure || sim.code !== 0) peer.sendJson({ type: "status", status: "error" });
      peer.close();
    }
  } catch (err) {
    if (!canceled) {
      app.log.error(err, "Run stream failed");
      peer.sendJson({ type: "status", status: "error" });
      peer.sendJson({
        type: "error",
        message: err instanceof Error ? err.message : "Unknown run error",
      });
      peer.close();
    }
  } finally {
    if (activeRun === session) {
      activeRun = null;
    }
  }
}

app.get("/run", { websocket: true }, (socket: WebSocket) => {
  const peer = new RunPeer(socket);
  void handleRun(peer);
});

class LspFrameParser {
  // Parses Content-Length-prefixed JSON-RPC messages from a byte stream and
  // emits each message body as a UTF-8 string. State machine: read headers
  // until blank line, then read N bytes of body, then loop.
  #buffer: Buffer = Buffer.alloc(0);
  #expectedBodyLength: number | null = null;
  #emit: (body: string) => void;

  constructor(emit: (body: string) => void) {
    this.#emit = emit;
  }

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.tryConsumeOne()) {
      // keep going until we run out of complete messages
    }
  }

  private tryConsumeOne(): boolean {
    if (this.#expectedBodyLength === null) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return false;
      const rawHeaders = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(rawHeaders);
      if (!match) {
        // Malformed: drop the bad headers and resync.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        return true;
      }
      this.#expectedBodyLength = Number(match[1]);
      this.#buffer = this.#buffer.subarray(headerEnd + 4);
    }

    if (this.#buffer.length < this.#expectedBodyLength) return false;
    const body = this.#buffer.subarray(0, this.#expectedBodyLength).toString("utf8");
    this.#buffer = this.#buffer.subarray(this.#expectedBodyLength);
    this.#expectedBodyLength = null;
    this.#emit(body);
    return true;
  }
}

function encodeLspFrame(body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, payload]);
}

async function execInLsp(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", lspContainerName, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({
      code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

// jdtls writes a workspace lock file that survives crashes. If the previous
// session was killed mid-import (e.g. browser closed during the cold start),
// the next jdtls process tries to resume and silently never finishes. We can't
// reliably detect this from the LSP protocol — the symptom is "no
// language/status: ServiceReady ever arrives". Periodically resetting the
// workspace on suspect signals is the cheapest mitigation.
async function resetJdtlsWorkspaceIfStale(): Promise<void> {
  // Workspace is "stale" if a .metadata/.lock file exists but no jdtls process
  // is currently using it. We check for a running java process inside the LSP
  // container; if none, any stale lock means a previous crash.
  const psResult = await execInLsp(["pgrep", "-f", "org.eclipse.jdt.ls"]);
  if (psResult.code === 0 && psResult.stdout.trim().length > 0) {
    return; // jdtls is running, leave the workspace alone
  }
  const lockResult = await execInLsp(["test", "-e", "/workspace/jdtls-data/.metadata/.lock"]);
  if (lockResult.code !== 0) return; // no lock file, nothing to reset

  app.log.warn("[lsp] stale jdtls-data lock detected with no live jdtls process; clearing workspace");
  await execInLsp(["sh", "-lc", "rm -rf /workspace/jdtls-data && mkdir -p /workspace/jdtls-data"]);
}

async function handleLsp(socket: WebSocket): Promise<void> {
  app.log.info("[lsp] WS connected; spawning jdtls");

  // Register the inbound message handler IMMEDIATELY, before any await. Faster
  // language clients (monaco-languageclient) send `initialize` within
  // milliseconds of WS open, and if the listener is registered after
  // `await resetJdtlsWorkspaceIfStale()` plus the docker spawn the message
  // fires into a void and jdtls hangs forever waiting for initialize. Buffer
  // messages until the child's stdin is writable, then drain.
  const inboundQueue: string[] = [];
  let drainToStdin: ((body: string) => void) | undefined;
  socket.on("message", (data: Buffer | string) => {
    const body = typeof data === "string" ? data : data.toString("utf8");
    if (drainToStdin) {
      drainToStdin(body);
    } else {
      inboundQueue.push(body);
    }
  });

  try {
    await resetJdtlsWorkspaceIfStale();
  } catch (err) {
    app.log.warn(err, "[lsp] failed to check workspace state; continuing anyway");
  }

  const child = spawn("docker", ["exec", "-i", lspContainerName, "sh", "-lc", jdtlsLaunchScript], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let closed = false;
  let cleanShutdownStarted = false;

  const closeAll = (): void => {
    if (closed) return;
    closed = true;
    killChild(child);
    try {
      socket.close();
    } catch {
      // already closing
    }
  };

  // Graceful LSP shutdown: send `shutdown` then `exit` over stdin and wait
  // briefly for jdtls to flush its workspace state. Falling back to SIGTERM if
  // jdtls doesn't exit on its own. Without this, killing jdtls mid-Gradle-
  // import corrupts /workspace/jdtls-data and the next session hangs forever.
  const beginCleanShutdown = (): void => {
    if (cleanShutdownStarted || closed) return;
    cleanShutdownStarted = true;
    if (!child.stdin.writable) {
      closeAll();
      return;
    }
    try {
      child.stdin.write(encodeLspFrame(JSON.stringify({
        jsonrpc: "2.0", id: 999_999, method: "shutdown",
      })));
      child.stdin.write(encodeLspFrame(JSON.stringify({
        jsonrpc: "2.0", method: "exit",
      })));
      child.stdin.end();
    } catch (err) {
      app.log.warn(err, "[lsp] clean shutdown failed; falling back to SIGTERM");
      closeAll();
      return;
    }
    // Give jdtls up to 5s to write its workspace state and exit cleanly.
    setTimeout(() => {
      if (!closed) {
        app.log.warn("[lsp] jdtls did not exit within 5s of clean shutdown; killing");
        closeAll();
      }
    }, 5000).unref();
  };

  const parser = new LspFrameParser((body) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(body);
    }
  });

  child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));

  // jdtls's stderr is the first place we'll see startup failures (missing jar,
  // wrong config dir, permissions). Log at info so it shows under the default
  // log level. It's noisy once jdtls is healthy; flip back to debug after MVP
  // shakeout.
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trimEnd();
    if (text.length > 0) app.log.info({ jdtls: text });
  });

  child.on("error", (err) => {
    app.log.error(err, "[lsp] failed to spawn jdtls");
    closeAll();
  });
  child.on("close", (code, signal) => {
    app.log.info(`[lsp] jdtls exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    closeAll();
  });

  // Wire the inbound drain now that child.stdin exists, then flush anything
  // buffered between WS open and process spawn.
  drainToStdin = (body) => {
    if (!child.stdin.writable) return;
    child.stdin.write(encodeLspFrame(body));
  };
  while (inboundQueue.length > 0) {
    const body = inboundQueue.shift();
    if (body !== undefined) drainToStdin(body);
  }
  socket.on("close", beginCleanShutdown);
  socket.on("error", () => {
    // Socket errors usually mean the connection is already gone; skip the
    // graceful path because writing to stdin would just throw.
    closeAll();
  });
}

app.get("/lsp", { websocket: true }, (socket: WebSocket) => {
  void handleLsp(socket);
});

try {
  const address = await app.listen({ host, port });
  app.log.info(`MVP backend available at ${address}`);
  app.log.info(`Using sim container ${containerName}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
