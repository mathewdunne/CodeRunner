import Fastify from "fastify";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";

const containerName = process.env.SIM_CONTAINER ?? "frc-sim-mvp";
const robotFile = "/workspace/project/src/main/java/frc/robot/Robot.java";
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";

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

class WebSocketTextPeer {
  #socket: Duplex;
  #closed = false;
  #onClose: Array<() => void> = [];

  constructor(socket: Duplex) {
    this.#socket = socket;
    socket.on("data", (data: Buffer) => {
      if (data.length > 0 && ((data[0] ?? 0) & 0x0f) === 0x08) {
        this.close();
      }
    });
    socket.on("error", () => {
      this.markClosed();
    });
    socket.on("end", () => this.markClosed());
    socket.on("close", () => this.markClosed());
  }

  get closed(): boolean {
    return this.#closed || this.#socket.destroyed;
  }

  sendJson(message: RunMessage): void {
    this.sendText(JSON.stringify(message));
  }

  sendText(text: string): void {
    if (this.closed) return;
    const payload = Buffer.from(text, "utf8");
    const header = makeTextFrameHeader(payload.length);
    this.#socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    this.#socket.end(Buffer.from([0x88, 0x00]));
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

function makeTextFrameHeader(length: number): Buffer {
  if (length < 126) {
    return Buffer.from([0x81, length]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function acceptWebSocket(req: IncomingMessage, socket: Duplex): WebSocketTextPeer | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return null;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  return new WebSocketTextPeer(socket);
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
  peer: WebSocketTextPeer,
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
  peer: WebSocketTextPeer,
  streamName: "stdout" | "stderr" | "sim",
): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  return spawnDockerStep(["exec", ...args], peer, streamName);
}

function spawnDockerLogs(
  since: string,
  peer: WebSocketTextPeer,
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

async function handleRun(peer: WebSocketTextPeer): Promise<void> {
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

app.server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/run") {
    socket.destroy();
    return;
  }

  if (head.length > 0) {
    socket.unshift(head);
  }

  const peer = acceptWebSocket(req, socket);
  if (!peer) return;
  void handleRun(peer);
});

try {
  const address = await app.listen({ host, port });
  app.log.info(`MVP backend available at ${address}`);
  app.log.info(`Using sim container ${containerName}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
