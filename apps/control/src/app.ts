import { type AuthProvidersResponse } from "@frc-sim/contracts";
import { LocalDockerRuntimeProvider } from "./containers";
import { HalSimBridge } from "./halsim";
import { GamepadSessions } from "./gamepad";
import { Nt4AutoChooserBridge } from "./nt4-auto";
import { IdleManager } from "./idle";
import { RunManager } from "./runs";
import { createStorage } from "./storage";
import { getSessionFromRequest, requireAdmin } from "./auth/middleware";
import { getEnabledAuthProviders } from "./auth/providers";
import { ImportManager } from "./imports";
import { handleAdminRoute } from "./app/admin-routes";
import { handleWorkspaceRoute } from "./app/workspace-routes";
import { handleUploadAsset, userAssetsPath, scopeResponse, webAssetResponse, webShellResponse } from "./app/assets";
import { openApiResponse } from "./app/status";
import { jsonResponse, notFound, redirect } from "./app/responses";
import { createWebSocketHandlers } from "./app/websocket";
import type { AppSocket, BunUpgradeServer, ControlApp, ControlAppOptions } from "./app/types";

export { stripHopByHopHeaders } from "./app/proxy";
export type {
  AppSocket,
  BunUpgradeServer,
  ControlApp,
  ControlAppOptions,
} from "./app/types";

export async function createApp(configInput: ControlAppOptions = {}): Promise<ControlApp> {
  const {
    runtimeProvider: configuredRuntimeProvider,
    dockerRunner,
    portAvailable,
    upstreamFetch: configuredUpstreamFetch,
    runCommandFactory,
    halsimWebSocketFactory,
    nt4AutoWebSocketFactory,
    ...storageConfig
  } = configInput;
  const upstreamFetch = configuredUpstreamFetch ?? globalThis.fetch;
  const storage = await createStorage(storageConfig);
  const runtimeProvider =
    configuredRuntimeProvider ?? new LocalDockerRuntimeProvider(storage, { dockerRunner, portAvailable });
  const containers = runtimeProvider as LocalDockerRuntimeProvider;
  const halsim = new HalSimBridge(
    halsimWebSocketFactory ? { webSocketFactory: halsimWebSocketFactory } : {},
  );
  const gamepad = new GamepadSessions(halsim);
  const nt4Auto = new Nt4AutoChooserBridge(
    nt4AutoWebSocketFactory ? { webSocketFactory: nt4AutoWebSocketFactory } : {},
  );
  const runs = new RunManager(storage, runtimeProvider, { commandFactory: runCommandFactory });
  const orphanedRuns = runs.reconcileOrphanedRuns();
  if (orphanedRuns > 0) {
    console.log(`Reconciled ${orphanedRuns} orphaned simulation run(s) after control-plane start.`);
  }

  const imports = new ImportManager(storage, runtimeProvider);
  const idle = new IdleManager({
    storage,
    runtimeProvider,
    onStop: (workspaceId) => {
      halsim.disconnect(workspaceId);
      nt4Auto.disconnect(workspaceId);
      gamepad.reset(workspaceId);
      console.log(`Idle sweep stopped containers for workspace ${workspaceId}`);
    },
  });
  idle.start();

  const adminCtx = { storage, runs, runtimeProvider };
  const workspaceCtx = { storage, runs, runtimeProvider, halsim, gamepad, nt4Auto, upstreamFetch };

  async function fetch(request: Request, server?: BunUpgradeServer): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "control", version: "v2-3" });
    }

    if (url.pathname === "/api/openapi.json" && request.method === "GET") {
      return openApiResponse();
    }

    // --- AdvantageScope Lite: upload asset (POST, authenticated) ---
    if (url.pathname === "/scope/uploadAsset" && request.method === "POST") {
      return handleUploadAsset(storage, request);
    }

    if ((url.pathname === "/scope" || url.pathname.startsWith("/scope/")) && request.method === "GET") {
      // Resolve user assets dir from session (best-effort; unauthenticated users get bundled only)
      let scopeUserAssetsDir: string | undefined;
      const session = await getSessionFromRequest(storage.auth, request);
      if (session) {
        const workspace = storage.findWorkspaceByUserId(session.user.id);
        if (workspace) {
          scopeUserAssetsDir = userAssetsPath(workspace);
        }
      }
      return scopeResponse(storage, url.pathname, scopeUserAssetsDir);
    }

    if (url.pathname === "/api/auth/providers" && request.method === "GET") {
      return jsonResponse({
        providers: getEnabledAuthProviders(storage.config),
      } satisfies AuthProvidersResponse);
    }

    // --- Better Auth API routes ---
    if (url.pathname.startsWith("/api/auth/")) {
      return storage.auth.handler(request);
    }

    if (url.pathname === "/" && request.method === "GET") {
      const session = await getSessionFromRequest(storage.auth, request);
      if (session) {
        const workspace = storage.findWorkspaceByUserId(session.user.id);
        if (workspace) {
          return redirect(`/u/${workspace.slug}/`);
        }
      }
      return webShellResponse(storage);
    }

    if (url.pathname === "/login" && request.method === "GET") {
      return webShellResponse(storage);
    }

    // Serve the favicon from the site root for pages outside the /u/:slug/ scope
    // and for browsers that fall back to requesting /favicon.ico automatically.
    if (
      (url.pathname === "/coderunner-icon.png" || url.pathname === "/favicon.ico") &&
      request.method === "GET"
    ) {
      return webAssetResponse(storage, "coderunner-icon.png");
    }

    // Serve Vite-processed assets for pages outside /u/:slug/ (e.g. /login)
    if (url.pathname.startsWith("/assets/") && request.method === "GET") {
      return webAssetResponse(storage, url.pathname.slice(1));
    }

    // --- Default-deny: everything below requires a session (or admin token). ---
    // Public routes (healthz, scope, /api/auth/providers, other api/auth routes, /, /login,
    // /coderunner-icon.png, /assets/*) are handled above.
    // If we reach here without matching a gated route, we return 404.

    // --- Admin / operator routes ---
    if (url.pathname === "/admin") {
      const adminResult = await requireAdmin(storage.auth, storage, request);
      if (adminResult instanceof Response) {
        return adminResult;
      }
      return redirect("/admin/", { status: 308 });
    }

    if (url.pathname === "/admin/") {
      const adminResult = await requireAdmin(storage.auth, storage, request);
      if (adminResult instanceof Response) {
        return adminResult;
      }
      if (request.method === "GET") {
        return webShellResponse(storage);
      }
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdminRoute(adminCtx, url, request);
    }

    const workspaceResponse = await handleWorkspaceRoute(workspaceCtx, url, request, server);
    if (workspaceResponse) {
      return workspaceResponse;
    }

    return notFound();
  }

  const websocket = createWebSocketHandlers({ storage, runs, halsim, nt4Auto, gamepad, imports });

  return {
    fetch,
    websocket: websocket as {
      open(ws: AppSocket): void;
      message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void;
      close(ws: AppSocket): void;
    },
    storage,
    runtime: runtimeProvider,
    containers,
    halsim,
    gamepad,
    nt4Auto,
    runs,
    imports,
    idle,
    close() {
      idle.stop();
      halsim.close();
      nt4Auto.close();
      storage.close();
    },
  };
}
