import { gamepadClientMessageSchema, importRequestSchema, runClientMessageSchema, type WorkspaceId, type ImportServerMessage } from "@frc-sim/contracts";
import type { GamepadLease, GamepadSessions } from "../gamepad";
import type { HalSimBridge } from "../halsim";
import { ImportManager, RateLimitError, parseGitHubUrl, validateBranch, validateSubdir } from "../imports";
import type { Nt4AutoChooserBridge } from "../nt4-auto";
import type { RunManager } from "../runs";
import type { AppStorage } from "../storage";
import { sendUpstreamWebSocketMessage } from "./proxy";
import { PROXY_PENDING_LIMIT, type AppSocket } from "./types";

export type WebSocketHandlerContext = {
  storage: AppStorage;
  runs: RunManager;
  halsim: HalSimBridge;
  nt4Auto: Nt4AutoChooserBridge;
  gamepad: GamepadSessions;
  imports: ImportManager;
};

function socketMessageText(message: string | ArrayBuffer | Uint8Array): string {
  if (typeof message === "string") {
    return message;
  }
  return new TextDecoder().decode(message);
}

export function createWebSocketHandlers(ctx: WebSocketHandlerContext) {
  const { storage, runs, halsim, nt4Auto, gamepad, imports } = ctx;

  const resolveGamepadLease = (workspaceId: WorkspaceId): GamepadLease | null => {
    const snapshot = runs.getWorkspaceSnapshot(workspaceId);
    if (snapshot.status !== "running") return null;
    const lease = storage.getContainerLease(workspaceId);
    if (typeof lease?.halsim_port !== "number") return null;
    return { halsimUrl: `ws://127.0.0.1:${lease.halsim_port}/wpilibws` };
  };

  function openProxyUpstream(
    ws: AppSocket,
    label: "NT4" | "VSCode" | "HALSim",
    protocols: string[] | undefined,
  ): void {
    if (ws.data.kind !== "nt4" && ws.data.kind !== "vscode" && ws.data.kind !== "halsim") {
      return;
    }
    const upstream = new WebSocket(ws.data.upstreamUrl, protocols && protocols.length > 0 ? protocols : undefined);
    ws.data.upstream = upstream;
    upstream.binaryType = "arraybuffer";

    upstream.addEventListener("open", () => {
      if (ws.data.kind !== "nt4" && ws.data.kind !== "vscode" && ws.data.kind !== "halsim") {
        return;
      }
      // The browser was told (in the upgrade handshake) that we picked
      // protocols[0]. If upstream actually negotiated something else, the
      // browser believes a protocol that the upstream isn't speaking. Close
      // with 1002 (protocol error) so AS Lite reconnects rather than silently
      // talking past the sim.
      if (
        protocols &&
        protocols.length > 0 &&
        upstream.protocol &&
        upstream.protocol !== protocols[0]
      ) {
        console.warn(
          `${label} upstream subprotocol mismatch: browser expected ${protocols[0]}, upstream chose ${upstream.protocol}.`,
        );
        ws.close(1002, `${label} subprotocol mismatch.`);
        upstream.close();
        return;
      }
      ws.data.upstreamOpen = true;
      for (const message of ws.data.pendingMessages.splice(0)) {
        sendUpstreamWebSocketMessage(upstream, message);
      }
    });
    upstream.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        ws.send(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        ws.send(event.data);
      } else if (event.data instanceof Uint8Array) {
        ws.send(event.data);
      }
    });
    upstream.addEventListener("close", (event) => {
      ws.close(event.code || 1011, event.reason || `${label} upstream closed.`);
    });
    upstream.addEventListener("error", () => {
      ws.close(1011, `${label} upstream error.`);
    });
  }

  return {
    open(ws: AppSocket): void {
      if (ws.data.kind === "nt4") {
        openProxyUpstream(ws, "NT4", ws.data.protocols);
        return;
      }
      if (ws.data.kind === "vscode") {
        openProxyUpstream(ws, "VSCode", ws.data.protocols);
        return;
      }
      if (ws.data.kind === "halsim") {
        openProxyUpstream(ws, "HALSim", ws.data.protocols);
        return;
      }
      if (ws.data.kind === "import") {
        // Import WS is open; client sends an import request message to start
        return;
      }
      if (ws.data.kind === "gamepad") {
        ws.send(JSON.stringify({ type: "hello" }));
        return;
      }
      ws.data.connection = runs.connect(ws.data.workspace, (message) => {
        ws.send(JSON.stringify(message));
      });
    },
    message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void {
      if (ws.data.kind === "nt4" || ws.data.kind === "vscode" || ws.data.kind === "halsim") {
        if (ws.data.upstreamOpen && ws.data.upstream) {
          sendUpstreamWebSocketMessage(ws.data.upstream, message);
        } else {
          if (ws.data.pendingMessages.length >= PROXY_PENDING_LIMIT) {
            ws.close(1013, "Upstream is not ready; please retry.");
            return;
          }
          ws.data.pendingMessages.push(message);
        }
        return;
      }

      if (ws.data.kind === "gamepad") {
        try {
          const parsed = gamepadClientMessageSchema.parse(JSON.parse(socketMessageText(message)));
          const outcome = gamepad.handleMessage(ws.data.workspace.id, parsed, resolveGamepadLease);
          if (outcome === "no-lease") {
            ws.send(JSON.stringify({ type: "error", message: "Simulator is not running." }));
          } else if (outcome === "halsim-unavailable") {
            ws.send(JSON.stringify({ type: "halsim-disconnected" }));
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Invalid gamepad message.";
          try { ws.send(JSON.stringify({ type: "error", message: detail })); } catch {}
        }
        return;
      }

      if (ws.data.kind === "import") {
        try {
          const parsed = importRequestSchema.parse(JSON.parse(socketMessageText(message)));
          const { cloneUrl, branch, subdir } = parseGitHubUrl(parsed.url, parsed.branch, parsed.subdir);
          validateBranch(branch);
          if (subdir) validateSubdir(subdir);
          const send = (msg: ImportServerMessage) => {
            try { ws.send(JSON.stringify(msg)); } catch {}
          };
          void imports.run({
            workspace: ws.data.workspace,
            userId: ws.data.userId,
            cloneUrl,
            branch,
            subdir,
            backup: parsed.backup ?? true,
            send,
          }).finally(() => {
            try { ws.close(1000, "Import finished."); } catch {}
          });
        } catch (error) {
          if (error instanceof RateLimitError) {
            ws.send(JSON.stringify({ type: "error", message: error.message }));
            ws.close(1000, "Rate limited.");
            return;
          }
          const detail = error instanceof Error ? error.message : "Invalid import request.";
          ws.send(JSON.stringify({ type: "error", message: detail }));
          ws.close(1000, "Invalid request.");
        }
        return;
      }

      try {
        const parsed = runClientMessageSchema.parse(JSON.parse(socketMessageText(message)));
        if (parsed.type === "start") {
          halsim.disconnect(ws.data.workspace.id);
          nt4Auto.disconnect(ws.data.workspace.id);
          const runId = runs.start(ws.data.workspace, ws.data.connection);
          ws.send(JSON.stringify({ type: "hello", runId }));
        } else {
          halsim.disconnect(ws.data.workspace.id);
          nt4Auto.disconnect(ws.data.workspace.id);
          runs.stopWorkspace(ws.data.workspace.id);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Invalid run message.";
        ws.send(JSON.stringify({ type: "error", message: detail }));
      }
    },
    close(ws: AppSocket): void {
      if (ws.data.kind === "nt4" || ws.data.kind === "vscode" || ws.data.kind === "halsim") {
        ws.data.upstream?.close();
        ws.data.pendingMessages.length = 0;
        return;
      }

      if (ws.data.kind === "import") {
        // Import WS closed — job will finish/fail on its own
        return;
      }

      if (ws.data.kind === "gamepad") {
        gamepad.closeSession(ws.data.workspace.id, resolveGamepadLease);
        return;
      }

      if (ws.data.connection) {
        runs.disconnect(ws.data.connection);
      }
    },
  };
}
