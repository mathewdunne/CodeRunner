/**
 * In-process HTTP+WS server that impersonates openvscode-server.
 *
 * Records every HTTP request's headers and every WS frame so tests can assert
 * proxy behavior (hop-by-hop strip, base-path mounting, WS upgrade payload).
 */
import { type Server } from "bun";
import type { FakeVscodeHandle } from "./types";

export async function startFakeVscode(): Promise<FakeVscodeHandle> {
  const receivedHeaders: Array<Record<string, string>> = [];
  const receivedFrames: Array<unknown> = [];
  let wsConnectionCount = 0;
  let wsConnectionWaiters: Array<{ resolve: () => void; target: number }> = [];

  function checkWaiters() {
    for (const waiter of wsConnectionWaiters) {
      if (wsConnectionCount >= waiter.target) {
        waiter.resolve();
      }
    }
    wsConnectionWaiters = wsConnectionWaiters.filter((w) => wsConnectionCount < w.target);
  }

  const server: Server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);

      // Collect headers per request for proxy assertions
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      receivedHeaders.push(headers);

      // WS upgrade
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = request.headers.get("sec-websocket-protocol") ?? "";
        const upgraded = srv.upgrade(request, {
          data: { path: url.pathname },
          headers: protocols ? { "sec-websocket-protocol": protocols.split(",")[0]!.trim() } : undefined,
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }

      // Default HTML response with a sentinel string for iframe tests
      if (url.pathname.endsWith("/") || url.pathname === "" || !url.pathname.includes(".")) {
        return new Response(
          `<!doctype html><html><body data-fake-vscode-ready="true">fake vscode</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      return new Response("ok", { headers: { "content-type": "text/plain" } });
    },
    websocket: {
      open(ws) {
        wsConnectionCount++;
        checkWaiters();
        ws.send(JSON.stringify({ type: "hello", from: "fake-vscode" }));
      },
      message(ws, message) {
        try {
          const parsed = typeof message === "string" ? JSON.parse(message) : message;
          receivedFrames.push(parsed);
          // Echo back for round-trip assertions
          ws.send(JSON.stringify({ type: "echo", payload: parsed }));
        } catch {
          receivedFrames.push(message);
        }
      },
      close() {},
    },
  });

  const httpBaseUrl = `http://127.0.0.1:${server.port}`;
  const wsBaseUrl = `ws://127.0.0.1:${server.port}`;

  return {
    httpBaseUrl,
    wsBaseUrl,
    receivedHeaders: () => [...receivedHeaders],
    receivedFrames: () => [...receivedFrames],
    wsConnections: () => wsConnectionCount,
    awaitWsConnection(target?: number, timeout = 5000): Promise<void> {
      const t = target ?? wsConnectionCount + 1;
      if (wsConnectionCount >= t) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wsConnectionWaiters = wsConnectionWaiters.filter((w) => w.resolve !== resolve);
          reject(new Error(`Timed out waiting for WS connection #${t} (got ${wsConnectionCount})`));
        }, timeout);
        wsConnectionWaiters.push({
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          target: t,
        });
      });
    },
    async stop() {
      server.stop(true);
    },
  };
}
