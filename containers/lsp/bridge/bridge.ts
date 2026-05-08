import { readdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(Bun.env.PORT ?? 30003);
const host = Bun.env.HOST ?? "0.0.0.0";
const lspPath = Bun.env.LSP_PATH ?? "/jdtls";
const jdtLsHome = Bun.env.JDTLS_HOME ?? "/opt/jdtls";
const jdtLsConfig = Bun.env.JDTLS_CONFIG ?? `${jdtLsHome}/config_linux`;
const jdtLsData = Bun.env.JDTLS_DATA ?? "/workspace/jdtls-data";
const jdtLsHeapMax = Bun.env.JDTLS_HEAP_MAX ?? "1G";
const logMessages = Bun.env.LSP_LOG_MESSAGES === "1";
// Time to wait on first connection after bridge boot, in case a stale JDT LS
// from before the bridge restart is still releasing /workspace/jdtls-data.
const firstConnectionWarmupMs = Number(Bun.env.LSP_FIRST_CONNECTION_WARMUP_MS ?? 2_000);

function findLauncherJar(): string {
  const explicit = Bun.env.JDTLS_LAUNCHER;
  if (explicit) {
    return explicit;
  }
  const pluginsDir = join(jdtLsHome, "plugins");
  const entries = readdirSync(pluginsDir);
  const launcher = entries.find(
    (entry) => entry.startsWith("org.eclipse.equinox.launcher_") && entry.endsWith(".jar"),
  );
  if (!launcher) {
    throw new Error(`No equinox launcher jar found in ${pluginsDir}.`);
  }
  return join(pluginsDir, launcher);
}

let cachedLauncherJar: string | null = null;
function jdtLsLauncher(): string {
  if (cachedLauncherJar === null) {
    cachedLauncherJar = findLauncherJar();
  }
  return cachedLauncherJar;
}

type Subprocess = ReturnType<typeof Bun.spawn>;

type LspSocketData = {
  process: Subprocess;
  pumpStdout: Promise<void> | null;
  pumpStderr: Promise<void> | null;
  closed: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Module-level serialization. JDT LS holds a lock on $JDTLS_DATA/.metadata/.lock,
// so two concurrent JDT LS instances pointing at the same data dir conflict.
// Each new connection awaits the previous JDT LS subprocess's exit before spawning.
let previousProcessExit: Promise<unknown> = Promise.resolve();
let hasSpawnedAtLeastOnce = false;

export type SpawnFn = (args: string[], env: Record<string, string | undefined>) => Subprocess;

const defaultSpawn: SpawnFn = (args, env) =>
  Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

function jdtLsArgs(): string[] {
  return [
    "java",
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dlog.level=ALL",
    `-Xmx${jdtLsHeapMax}`,
    "--add-modules=ALL-SYSTEM",
    "--add-opens",
    "java.base/java.util=ALL-UNNAMED",
    "--add-opens",
    "java.base/java.lang=ALL-UNNAMED",
    "-jar",
    jdtLsLauncher(),
    "-configuration",
    jdtLsConfig,
    "-data",
    jdtLsData,
  ];
}

async function pumpStdout(
  stream: ReadableStream<Uint8Array>,
  onMessage: (json: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);

  function append(chunk: Uint8Array): void {
    if (buffer.length === 0) {
      buffer = chunk;
      return;
    }
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer, 0);
    next.set(chunk, buffer.length);
    buffer = next;
  }

  function findHeaderEnd(): number {
    for (let index = 3; index < buffer.length; index += 1) {
      if (
        buffer[index - 3] === 0x0d &&
        buffer[index - 2] === 0x0a &&
        buffer[index - 1] === 0x0d &&
        buffer[index] === 0x0a
      ) {
        return index + 1;
      }
    }
    return -1;
  }

  function tryDeliver(): boolean {
    const headerEnd = findHeaderEnd();
    if (headerEnd < 0) {
      return false;
    }
    const headers = decoder.decode(buffer.slice(0, headerEnd));
    const match = /Content-Length:\s*(\d+)/i.exec(headers);
    if (!match) {
      // Drop malformed framing instead of stalling forever.
      buffer = buffer.slice(headerEnd);
      return true;
    }
    const length = Number(match[1]);
    if (buffer.length - headerEnd < length) {
      return false;
    }
    const body = buffer.slice(headerEnd, headerEnd + length);
    buffer = buffer.slice(headerEnd + length);
    onMessage(decoder.decode(body));
    return true;
  }

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    if (next.value) {
      append(next.value);
      while (tryDeliver()) {
        // Consume any complete frames already buffered.
      }
    }
  }
}

async function pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    if (next.value && logMessages) {
      console.error(`[jdtls] ${decoder.decode(next.value)}`);
    }
  }
}

function writeFramed(stdin: Subprocess["stdin"], json: string): void {
  if (!stdin) {
    return;
  }
  const body = encoder.encode(json);
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  // Bun.spawn's stdin is a FileSink in pipe mode.
  const sink = stdin as unknown as { write(data: Uint8Array): number; flush?(): void };
  sink.write(header);
  sink.write(body);
  sink.flush?.();
}

export type CreateServerOptions = {
  spawn?: SpawnFn;
};

export function createBridgeServer(options: CreateServerOptions = {}) {
  const spawn = options.spawn ?? defaultSpawn;

  return Bun.serve<LspSocketData, undefined>({
    hostname: host,
    port,
    async fetch(request, instance) {
      const url = new URL(request.url);
      if (url.pathname !== lspPath) {
        return new Response(`JDT LS bridge listening at ${lspPath}.\n`);
      }

      // Wait for any prior JDT LS to release its workspace lock before
      // spawning the next one. On the very first connection, also pause
      // briefly in case a pre-restart JDT LS from a previous bridge process
      // is still holding the lock inside the bind-mounted jdtls-data dir.
      await previousProcessExit;
      if (!hasSpawnedAtLeastOnce && firstConnectionWarmupMs > 0) {
        hasSpawnedAtLeastOnce = true;
        await Bun.sleep(firstConnectionWarmupMs);
      } else {
        hasSpawnedAtLeastOnce = true;
      }

      let subprocess: Subprocess;
      try {
        subprocess = spawn(jdtLsArgs(), {
          ...process.env,
          HOME: process.env.HOME ?? "/home/frc",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start JDT LS.";
        console.error(`failed to spawn JDT LS: ${message}`);
        return new Response(message, { status: 500 });
      }

      previousProcessExit = subprocess.exited.catch(() => undefined);

      const data: LspSocketData = {
        process: subprocess,
        pumpStdout: null,
        pumpStderr: null,
        closed: false,
      };
      const upgraded = instance.upgrade(request, { data });
      if (!upgraded) {
        try {
          subprocess.kill("SIGTERM");
        } catch {
          // best-effort cleanup
        }
        return new Response("WebSocket upgrade failed.", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      perMessageDeflate: false,
      open(ws) {
        const subprocess = ws.data.process;
        ws.data.pumpStdout = pumpStdout(
          subprocess.stdout as ReadableStream<Uint8Array>,
          (json) => {
            if (ws.data.closed) {
              return;
            }
            ws.send(json);
          },
        );
        ws.data.pumpStderr = pumpStderr(subprocess.stderr as ReadableStream<Uint8Array>);
        void subprocess.exited.then((code) => {
          if (!ws.data.closed) {
            ws.close(1011, `JDT LS exited with code ${code}.`);
          }
        });
        if (logMessages) {
          console.log(`spawned JDT LS pid ${subprocess.pid}`);
        }
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : decoder.decode(raw);
        try {
          writeFramed(ws.data.process.stdin, text);
        } catch (error) {
          const message = error instanceof Error ? error.message : "JDT LS write failed.";
          console.error(`bridge write error: ${message}`);
          ws.close(1011, message);
        }
      },
      close(ws) {
        ws.data.closed = true;
        try {
          ws.data.process.kill("SIGTERM");
        } catch {
          // Subprocess may already be exiting; ignore.
        }
      },
    },
  });
}

if (import.meta.main) {
  const server = createBridgeServer();
  console.log(`JDT LS bridge listening on ws://${host}:${server.port}${lspPath}`);

  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
