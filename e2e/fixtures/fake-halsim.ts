/**
 * In-process WS server impersonating the HALSim bridge. The control plane
 * connects upstream to it on a per-workspace basis. Tests inspect/inject frames
 * via `receivedFrames()` and `pushFrame()`.
 */
import { type Server, type ServerWebSocket } from "bun";
import type { FakeHalsimHandle } from "./types";

export async function startFakeHalsim(): Promise<FakeHalsimHandle & {
  pushFrame: (frame: unknown) => void;
  connections(): number;
}> {
  const receivedFrames: Array<unknown> = [];
  const conns = new Set<ServerWebSocket<unknown>>();

  const server: Server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = srv.upgrade(request);
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response("fake halsim ok");
    },
    websocket: {
      open(ws) {
        conns.add(ws);
      },
      message(_ws, message) {
        try {
          receivedFrames.push(typeof message === "string" ? JSON.parse(message) : message);
        } catch {
          receivedFrames.push(message);
        }
      },
      close(ws) {
        conns.delete(ws);
      },
    },
  });

  return {
    wsUrl: `ws://127.0.0.1:${server.port}/`,
    receivedFrames: () => [...receivedFrames],
    pushFrame(frame: unknown) {
      const data = typeof frame === "string" ? frame : JSON.stringify(frame);
      for (const ws of conns) ws.send(data);
    },
    connections: () => conns.size,
    async stop() {
      server.stop(true);
    },
  };
}
