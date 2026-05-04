import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

type Session = {
  user: string;
  nt4Host: string;
  nt4Port: number;
};

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const sessions = parseSessions(process.env.SPIKE_NT4_SESSIONS ?? "alice=127.0.0.1:5811,bob=127.0.0.1:5812,charlie=127.0.0.1:5813");
const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

function parseSessions(value: string): Map<string, Session> {
  const parsed = new Map<string, Session>();

  for (const entry of value.split(",")) {
    const [rawUser, rawTarget] = entry.split("=", 2);
    const user = rawUser?.trim();
    const target = rawTarget?.trim();
    if (!user || !target || !/^[a-zA-Z0-9_-]{1,32}$/.test(user)) continue;

    const [nt4Host, rawPort] = target.split(":", 2);
    const nt4Port = Number(rawPort);
    if (!nt4Host || !Number.isInteger(nt4Port) || nt4Port <= 0) continue;

    parsed.set(user, { user, nt4Host, nt4Port });
  }

  return parsed;
}

function sessionFromPath(pathname: string): Session | null {
  const match = /^\/sim\/([^/]+)\/(?:alive|nt4)$/.exec(pathname);
  if (!match) return null;

  const user = decodeURIComponent(match[1] ?? "");
  return sessions.get(user) ?? null;
}

function nt4HttpUrl(session: Session): string {
  return `http://${session.nt4Host}:${session.nt4Port}`;
}

function nt4WsUrl(session: Session): string {
  return `ws://${session.nt4Host}:${session.nt4Port}/nt/AdvantageScopeLite`;
}

function requestedProtocols(request: IncomingMessage): string[] {
  const header = request.headers["sec-websocket-protocol"];
  if (typeof header !== "string") return [];
  return header.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

function pipeWebSockets(client: WebSocket, upstream: WebSocket): void {
  const closeBoth = (): void => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  };

  client.on("message", (data: RawData, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on("message", (data: RawData, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", closeBoth);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const session = sessionFromPath(requestUrl.pathname);

  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, sessions: Array.from(sessions.keys()) }));
    return;
  }

  if (!session || !requestUrl.pathname.endsWith("/alive")) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
    return;
  }

  try {
    const upstream = await fetch(nt4HttpUrl(session), { signal: AbortSignal.timeout(500) });
    res.writeHead(upstream.ok ? 200 : 502, { "content-type": "text/plain; charset=utf-8" });
    res.end(upstream.ok ? "ok\n" : "NT4 server did not report alive\n");
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? `${err.message}\n` : "NT4 alive check failed\n");
  }
});

server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const session = sessionFromPath(requestUrl.pathname);
  if (!session || !requestUrl.pathname.endsWith("/nt4")) {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (client) => {
    const upstream = new WebSocket(nt4WsUrl(session), requestedProtocols(request));
    upstream.on("open", () => pipeWebSockets(client, upstream));
    upstream.on("error", () => client.close());
  });
});

server.listen(port, host, () => {
  console.log(`Spike NT4 router listening on http://${host}:${port}`);
  console.log(`Sessions: ${Array.from(sessions.values()).map((session) => `${session.user}->${session.nt4Host}:${session.nt4Port}`).join(", ")}`);
});

process.on("SIGTERM", () => {
  wsServer.close();
  server.close();
});
