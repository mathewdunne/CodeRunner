import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  autoChooserPatchSchema,
  heartbeatRequestSchema,
  driverStationPatchSchema,
  importRequestSchema,
  runClientMessageSchema,
  simRunCommandRequestSchema,
  workspaceSlugSchema,
  type AdminActionResponse,
  type AdminStatusResponse,
  type AdminWorkspaceStatus,
  type AutoChoosersResponse,
  type ContainersStatusResponse,
  type HeartbeatResponse,
  type ImportServerMessage,
  type SessionResponse,
  type SimRunCommandResponse,
  type SimRunStatus,
  type SimStatusResponse,
  type WorkspaceId,
  type WorkspaceSlug,
} from "@frc-sim/contracts";
import type { ControlConfigInput } from "./config";
import { ContainerOrchestrator, CapacityExceededError, type DockerRunner } from "./containers";
import { HalSimBridge, type HalSimWebSocketFactory } from "./halsim";
import { Nt4AutoChooserBridge, type Nt4AutoWebSocketFactory } from "./nt4-auto";
import { IdleManager } from "./idle";
import { RunManager, type RunCommandFactory, type RunConnection } from "./runs";
import { createStorage, SlugTakenError, type AppStorage, type AuthContext } from "./storage";
import { getSessionFromRequest, requireAdmin, requireWebSocketOrigin, requireWorkspaceOwnership } from "./auth/middleware";
import { recordAuditEvent, queryAuditLog, type AuditActor } from "./audit";
import {
  ImportManager,
  ImportError,
  RateLimitError,
  parseGitHubUrl,
  validateBranch,
  validateSubdir,
  listRecentImports,
  restoreImportBackup,
} from "./imports";

export type ControlApp = {
  fetch(request: Request, server?: BunUpgradeServer): Promise<Response>;
  websocket: {
    open(ws: AppSocket): void;
    message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void;
    close(ws: AppSocket): void;
  };
  storage: AppStorage;
  containers: ContainerOrchestrator;
  halsim: HalSimBridge;
  nt4Auto: Nt4AutoChooserBridge;
  runs: RunManager;
  imports: ImportManager;
  idle: IdleManager;
  close(): void;
};

export type ControlAppOptions = ControlConfigInput & {
  dockerRunner?: DockerRunner | undefined;
  portAvailable?: ((port: number) => Promise<boolean>) | undefined;
  upstreamFetch?: HttpFetch | undefined;
  runCommandFactory?: RunCommandFactory | undefined;
  halsimWebSocketFactory?: HalSimWebSocketFactory | undefined;
  nt4AutoWebSocketFactory?: Nt4AutoWebSocketFactory | undefined;
};

type BunUpgradeServer = {
  upgrade(request: Request, options: { data: SocketData; headers?: HeadersInit }): boolean;
};

type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit & { decompress?: boolean },
) => Promise<Response>;

type RunSocketData = {
  kind: "run";
  workspace: AuthContext["workspace"];
  connection?: RunConnection | undefined;
};

// Defensive cap on per-socket message buffering while waiting for upstream
// to open. A misbehaving sim that accepts TCP but never finishes the WS
// handshake would otherwise let the browser flood control-plane memory.
const PROXY_PENDING_LIMIT = 256;

type Nt4SocketData = {
  kind: "nt4";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

type LspSocketData = never;

type VscodeSocketData = {
  kind: "vscode";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

type HalSimSocketData = {
  kind: "halsim";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

type ImportSocketData = {
  kind: "import";
  workspace: AuthContext["workspace"];
  userId: string;
};

type SocketData = RunSocketData | Nt4SocketData | VscodeSocketData | HalSimSocketData | ImportSocketData;

type AppSocket = {
  data: SocketData;
  send(data: string): unknown;
  send(data: ArrayBuffer | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
};

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function redirect(location: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("location", location);
  return new Response(null, { ...init, status: init.status ?? 303, headers });
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginPage(storage: AppStorage, error: string | null = null, init: ResponseInit = {}): Response {
  const friendlyError =
    error === "forbidden" || error?.toLowerCase().includes("roster")
      ? "You're not on the roster yet. Ask your coach to add you."
      : error?.replaceAll("_", " ") ?? null;
  const errorMarkup = friendlyError ? `<p id="login-error" role="alert">${escapeHtml(friendlyError)}</p>` : `<p id="login-error" role="alert" hidden></p>`;
  const providers = [
    storage.config.githubClientId && storage.config.githubClientSecret
      ? { id: "github", label: "Sign in with GitHub" }
      : null,
    storage.config.googleClientId && storage.config.googleClientSecret
      ? { id: "google", label: "Sign in with Google" }
      : null,
  ].filter((provider): provider is { id: string; label: string } => Boolean(provider));
  const providerMarkup =
    providers.length > 0
      ? providers
          .map((provider) => `<button class="btn" type="button" data-provider="${provider.id}">${provider.label}</button>`)
          .join("\n")
      : `<p role="alert">No OAuth provider is configured yet. Ask an operator to set GitHub or Google OAuth credentials.</p>`;

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FRC Web Simulator V2</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #101820; color: #f5f7fb; }
      main { width: min(28rem, calc(100vw - 2rem)); text-align: center; }
      .btn { display: block; width: 100%; font: inherit; padding: 0.7rem 0.8rem; border-radius: 0.4rem; border: 1px solid #52606d; background: #2f80ed; color: white; cursor: pointer; margin-bottom: 0.5rem; text-decoration: none; box-sizing: border-box; }
      .btn:disabled { opacity: 0.65; cursor: wait; }
      p[role="alert"] { color: #ffb4ab; }
      .note { color: #97a6b6; font-size: 0.85rem; margin-top: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>FRC Web Simulator</h1>
      ${errorMarkup}
      <p>Sign in to access your workspace.</p>
      ${providerMarkup}
      <p class="note">Not on the roster? Ask your coach to add you.</p>
    </main>
    <script>
      const error = document.getElementById("login-error");
      async function signIn(provider) {
        for (const button of document.querySelectorAll("button[data-provider]")) button.disabled = true;
        try {
          const response = await fetch("/api/auth/sign-in/social", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ provider, callbackURL: "/", errorCallbackURL: "/login" }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.url) {
            throw new Error(body.message || body.error || "Unable to start OAuth sign-in.");
          }
          window.location.assign(body.url);
        } catch (err) {
          error.hidden = false;
          error.textContent = err instanceof Error ? err.message : "Unable to start OAuth sign-in.";
          for (const button of document.querySelectorAll("button[data-provider]")) button.disabled = false;
        }
      }
      for (const button of document.querySelectorAll("button[data-provider]")) {
        button.addEventListener("click", () => signIn(button.dataset.provider));
      }
    </script>
  </body>
</html>`, init);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function sessionResponse(auth: AuthContext): SessionResponse {
  return {
    user: {
      id: auth.user.id,
      displayName: auth.user.name,
      email: auth.user.email,
      slug: auth.workspace.slug,
      role: auth.user.role as "student" | "admin",
    },
    workspace: {
      id: auth.workspace.id,
      slug: auth.workspace.slug,
    },
  };
}

function apiErrorResponse(error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : fallback;
  const maybeStatus = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  const status = typeof maybeStatus === "number" ? maybeStatus : 500;
  return jsonResponse({ error: message }, { status });
}

async function readHeartbeatRequest(request: Request, storage: AppStorage, auth: AuthContext): Promise<HeartbeatResponse> {
  const text = await request.text();
  const input = text.trim() ? JSON.parse(text) : {};
  const parsed = heartbeatRequestSchema.parse(input);
  storage.touchContainerLeaseActivity(auth.workspace.id);
  return { ok: true, closing: parsed.closing ?? false };
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".glb":
      return "model/gltf-binary";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function isInsideDirectory(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function safeRelativeAssetPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

async function staticFileResponse(root: string, path: string): Promise<Response> {
  const target = resolve(root, path);
  if (!isInsideDirectory(root, target)) {
    return new Response("Static asset path is outside the web shell.", { status: 403 });
  }

  try {
    const targetStats = await stat(target);
    if (!targetStats.isFile()) {
      return notFound();
    }
  } catch {
    return notFound();
  }

  const file = Bun.file(target);
  if (!(await file.exists())) {
    return notFound();
  }

  return new Response(file, {
    headers: {
      "content-type": contentTypeFor(target),
    },
  });
}

async function webShellResponse(storage: AppStorage): Promise<Response> {
  try {
    const indexHtml = await readFile(resolve(storage.config.webDistDir, "index.html"), "utf8");
    return htmlResponse(indexHtml);
  } catch {
    return htmlResponse(
      "The V2 web shell has not been built yet. Run `bun run build:web` before starting the control plane.",
      { status: 503 },
    );
  }
}

async function containersStatusResponse(
  containers: ContainerOrchestrator,
  auth: AuthContext,
): Promise<Response> {
  try {
    const status = await containers.containersStatus(auth.workspace);
    return jsonResponse(status);
  } catch (error) {
    if (error instanceof CapacityExceededError) {
      return jsonResponse(
        { error: "capacity", limit: error.limit, current: error.current },
        { status: 503 },
      );
    }
    throw error;
  }
}

function runIsActive(status: SimRunStatus): boolean {
  return status === "building" || status === "running" || status === "stopping";
}

async function simStatusSnapshot(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  runs: RunManager,
  halsim: HalSimBridge,
  auth: AuthContext,
): Promise<SimStatusResponse> {
  const containerStatus = await containers.containersStatus(auth.workspace);
  const run = runs.getWorkspaceSnapshot(auth.workspace.id);
  const lease = storage.getContainerLease(auth.workspace.id);
  const shouldBridgeRun =
    runIsActive(run.status) &&
    containerStatus.code.state === "running" &&
    typeof lease?.halsim_port === "number";
  const bridge =
    shouldBridgeRun && typeof lease?.halsim_port === "number"
      ? halsim.ensureConnected(auth.workspace.id, lease.halsim_port)
      : halsim.getSnapshot(auth.workspace.id);
  if (!shouldBridgeRun && !runIsActive(run.status)) {
    halsim.disconnect(auth.workspace.id);
  }

  const canEnable =
    containerStatus.code.state === "running" &&
    run.status === "running" &&
    bridge.connected &&
    !bridge.driverStation.eStopped;

  return {
    ok: true,
    workspace: {
      id: auth.workspace.id,
      slug: auth.workspace.slug,
    },
    container: {
      state: containerStatus.code.state,
    },
    run,
    halsim: {
      connection: bridge.connection,
      connected: bridge.connected,
      stale: bridge.stale,
      lastMessageAt: bridge.lastMessageAt,
      error: bridge.error,
    },
    driverStation: bridge.driverStation,
    comms: { canEnable },
    joysticks: { status: "unknown" },
  };
}

async function autoChoosersSnapshot(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  runs: RunManager,
  nt4Auto: Nt4AutoChooserBridge,
  auth: AuthContext,
): Promise<AutoChoosersResponse> {
  const containerStatus = await containers.containersStatus(auth.workspace);
  const run = runs.getWorkspaceSnapshot(auth.workspace.id);
  const lease = storage.getContainerLease(auth.workspace.id);
  const shouldBridgeRun =
    runIsActive(run.status) &&
    containerStatus.code.state === "running" &&
    typeof lease?.nt4_port === "number";
  if (shouldBridgeRun && typeof lease?.nt4_port === "number") {
    return nt4Auto.ensureConnected(auth.workspace.id, lease.nt4_port);
  }
  if (!runIsActive(run.status)) {
    nt4Auto.disconnect(auth.workspace.id);
  }
  return nt4Auto.getSnapshot(auth.workspace.id);
}

async function simStatusResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  runs: RunManager,
  halsim: HalSimBridge,
  auth: AuthContext,
): Promise<Response> {
  try {
    return jsonResponse(await simStatusSnapshot(storage, containers, runs, halsim, auth));
  } catch (error) {
    if (error instanceof CapacityExceededError) {
      return jsonResponse(
        { error: "capacity", limit: error.limit, current: error.current },
        { status: 503 },
      );
    }
    throw error;
  }
}

function openApiResponse(): Response {
  return jsonResponse({
    openapi: "3.1.0",
    info: {
      title: "FRC Web Simulator Control API",
      version: "2.0.0",
    },
    paths: {
      "/u/{slug}/api/sim/status": {
        get: {
          summary: "Read the current simulator and Driver Station state.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Simulation state snapshot." },
            "401": { description: "Authentication required." },
            "403": { description: "Workspace access denied." },
          },
        },
      },
      "/u/{slug}/api/sim/run": {
        post: {
          summary: "Start, stop, or restart robot code.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: { enum: ["start", "stop", "restart"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Run command accepted." },
            "202": { description: "Run start accepted." },
          },
        },
      },
      "/u/{slug}/api/sim/driver-station": {
        patch: {
          summary: "Set desired Driver Station state.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    mode: { enum: ["auto", "teleop", "test"] },
                    eStopped: { type: "boolean" },
                    alliance: { enum: ["red1", "red2", "red3", "blue1", "blue2", "blue3"] },
                  },
                  minProperties: 1,
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated simulation state snapshot." },
            "409": { description: "Robot code is not running." },
            "503": { description: "HALSim bridge is unavailable." },
          },
        },
      },
      "/u/{slug}/api/sim/auto-choosers": {
        get: {
          summary: "Read detected NetworkTables autonomous choosers.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Auto chooser snapshot." },
            "401": { description: "Authentication required." },
            "403": { description: "Workspace access denied." },
          },
        },
      },
      "/u/{slug}/api/sim/auto-chooser": {
        patch: {
          summary: "Select an autonomous routine through NetworkTables.",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["key", "selected"],
                  properties: {
                    key: { type: "string" },
                    selected: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated auto chooser snapshot." },
            "409": { description: "Robot code is not running." },
            "503": { description: "NT4 bridge is unavailable." },
          },
        },
      },
    },
  });
}

async function webAssetResponse(storage: AppStorage, rawPath: string): Promise<Response> {
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawPath);
  } catch {
    return new Response("Invalid static asset path.", { status: 400 });
  }

  const safePath = safeRelativeAssetPath(assetPath);
  if (!safePath) {
    return new Response("Invalid static asset path.", { status: 400 });
  }

  return staticFileResponse(storage.config.webDistDir, safePath);
}

type AssetManifest = Record<string, unknown>;

async function readScopeAssetManifest(storage: AppStorage): Promise<AssetManifest> {
  const bundledAssetsRoot = resolve(storage.config.advantageScopeDistDir, "bundledAssets");
  const manifest: AssetManifest = {};

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const manifestPath = relative(bundledAssetsRoot, absolutePath).split(sep).join("/");
      let contents: unknown = null;
      if (entry.name === "config.json") {
        try {
          contents = JSON.parse(await readFile(absolutePath, "utf8"));
        } catch {
          contents = null;
        }
      }
      manifest[manifestPath] = contents;
    }
  }

  await walk(bundledAssetsRoot);
  return manifest;
}

async function scopeResponse(storage: AppStorage, pathname: string): Promise<Response> {
  let suffix = pathname === "/scope" ? "" : pathname.slice("/scope/".length);
  if (suffix === "" || suffix === "/") {
    suffix = "index.html";
  }

  if (suffix.startsWith("www/www/")) {
    return redirect(`/scope/www/${suffix.slice("www/www/".length)}`, { status: 302 });
  }

  let assetPath: string;
  try {
    assetPath = decodeURIComponent(suffix);
  } catch {
    return new Response("Invalid AdvantageScope asset path.", { status: 400 });
  }

  if (assetPath === "assets" || assetPath === "assets/") {
    return jsonResponse(await readScopeAssetManifest(storage));
  }

  if (assetPath.startsWith("assets/")) {
    const relativeAssetPath = assetPath.slice("assets/".length);
    return staticFileResponse(resolve(storage.config.advantageScopeDistDir, "bundledAssets"), relativeAssetPath);
  }

  return staticFileResponse(storage.config.advantageScopeDistDir, assetPath);
}

function requestedProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

// Headers that must not be forwarded by a proxy (RFC 7230 § 6.1 / RFC 9110 § 7.6.1).
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function stripHopByHopHeaders(source: Headers): Headers {
  // The `Connection` header may list additional hop-by-hop header names.
  const connectionExtras = (source.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  const stripped = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionExtras.includes(lower)) {
      return;
    }
    stripped.set(key, value);
  });

  return stripped;
}

async function probeVscodeReady(
  port: number,
  basePath: string,
  timeoutMs: number,
  upstreamFetch: HttpFetch,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = `http://127.0.0.1:${port}${basePath}`;
  while (Date.now() < deadline) {
    try {
      const response = await upstreamFetch(probeUrl, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status >= 200 && response.status < 500) {
        return true;
      }
    } catch {
      // Connection refused or aborted; keep retrying.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  return false;
}

function capacityErrorResponse(error: unknown): Response | null {
  if (error instanceof CapacityExceededError) {
    return jsonResponse(
      { error: "capacity", limit: error.limit, current: error.current },
      { status: 503 },
    );
  }
  return null;
}

async function vscodeHttpProxyResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  auth: AuthContext,
  request: Request,
  fullPath: string,
  upstreamFetch: HttpFetch,
): Promise<Response> {
  const code = await containers.ensureCodeContainer(auth.workspace);
  const lease = storage.getContainerLease(auth.workspace.id);
  if (code.state !== "running" || !lease?.vscode_port) {
    return new Response(code.error ?? "Editor is not running.", { status: 503 });
  }

  const basePath = `/u/${auth.workspace.slug}/vscode/`;
  if (!(await probeVscodeReady(lease.vscode_port, basePath, 30_000, upstreamFetch))) {
    return new Response("Editor upstream did not become ready.", { status: 503 });
  }

  const upstreamUrl = `http://127.0.0.1:${lease.vscode_port}${fullPath}`;
  const forwardHeaders = stripHopByHopHeaders(request.headers);

  try {
    const upstream = await upstreamFetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.body,
      redirect: "manual",
      decompress: false,
    });

    const responseHeaders = stripHopByHopHeaders(upstream.headers);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return new Response("Editor upstream is not reachable.", { status: 502 });
  }
}

async function vscodeWebSocketResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  auth: AuthContext,
  request: Request,
  fullPath: string,
  upstreamFetch: HttpFetch,
  server?: BunUpgradeServer,
): Promise<Response> {
  if (!server || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade.", { status: 426 });
  }
  const originError = requireWebSocketOrigin(request, storage.config.baseUrl);
  if (originError) {
    return originError;
  }

  const code = await containers.ensureCodeContainer(auth.workspace);
  const lease = storage.getContainerLease(auth.workspace.id);
  if (code.state !== "running" || !lease?.vscode_port) {
    return new Response(code.error ?? "Editor is not running.", { status: 503 });
  }

  const slug = auth.workspace.slug;
  const basePath = `/u/${slug}/vscode/`;
  if (!(await probeVscodeReady(lease.vscode_port, basePath, 30_000, upstreamFetch))) {
    return new Response("Editor upstream did not become ready.", { status: 503 });
  }

  const protocols = requestedProtocols(request);
  const upstreamUrl = `ws://127.0.0.1:${lease.vscode_port}${fullPath}`;
  const upgradeOptions: { data: SocketData; headers?: HeadersInit } = {
    data: {
      kind: "vscode",
      upstreamUrl,
      protocols,
      upstreamOpen: false,
      pendingMessages: [],
    },
  };
  if (protocols.length > 0) {
    upgradeOptions.headers = { "sec-websocket-protocol": protocols[0] ?? "" };
  }
  const upgraded = server.upgrade(request, upgradeOptions);
  if (!upgraded) {
    return new Response("WebSocket upgrade failed.", { status: 400 });
  }
  return undefined as unknown as Response;
}

async function nt4AliveResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  auth: AuthContext,
  upstreamFetch: HttpFetch,
): Promise<Response> {
  const code = await containers.ensureCodeContainer(auth.workspace);
  const lease = storage.getContainerLease(auth.workspace.id);
  if (code.state !== "running" || !lease?.nt4_port) {
    return new Response(code.error ?? "Simulator is not running.", { status: 503 });
  }

  try {
    const upstream = await upstreamFetch(`http://127.0.0.1:${lease.nt4_port}/`, {
      signal: AbortSignal.timeout(500),
    });
    if (!upstream.ok) {
      return new Response("Simulator NT4 endpoint is not ready.", { status: 503 });
    }
    return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("Simulator NT4 endpoint is not reachable.", { status: 503 });
  }
}

async function nt4WebSocketResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  auth: AuthContext,
  request: Request,
  server?: BunUpgradeServer,
): Promise<Response> {
  if (!server || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade.", { status: 426 });
  }
  const originError = requireWebSocketOrigin(request, storage.config.baseUrl);
  if (originError) {
    return originError;
  }

  const code = await containers.ensureCodeContainer(auth.workspace);
  const lease = storage.getContainerLease(auth.workspace.id);
  if (code.state !== "running" || !lease?.nt4_port) {
    return new Response(code.error ?? "Simulator is not running.", { status: 503 });
  }

  const protocols = requestedProtocols(request);
  const upgradeOptions: { data: SocketData; headers?: HeadersInit } = {
    data: {
      kind: "nt4",
      upstreamUrl: `ws://127.0.0.1:${lease.nt4_port}/nt/AdvantageScopeLite`,
      protocols,
      upstreamOpen: false,
      pendingMessages: [],
    },
  };
  if (protocols.length > 0) {
    upgradeOptions.headers = { "sec-websocket-protocol": protocols[0] ?? "" };
  }
  const upgraded = server.upgrade(request, upgradeOptions);
  if (!upgraded) {
    return new Response("WebSocket upgrade failed.", { status: 400 });
  }
  return undefined as unknown as Response;
}

async function halsimWebSocketResponse(
  storage: AppStorage,
  containers: ContainerOrchestrator,
  auth: AuthContext,
  request: Request,
  server?: BunUpgradeServer,
): Promise<Response> {
  if (!server || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade.", { status: 426 });
  }
  const originError = requireWebSocketOrigin(request, storage.config.baseUrl);
  if (originError) {
    return originError;
  }

  const code = await containers.ensureCodeContainer(auth.workspace);
  const lease = storage.getContainerLease(auth.workspace.id);
  if (code.state !== "running" || !lease?.halsim_port) {
    return new Response(code.error ?? "Simulator is not running.", { status: 503 });
  }

  const protocols = requestedProtocols(request);
  const upgradeOptions: { data: SocketData; headers?: HeadersInit } = {
    data: {
      kind: "halsim",
      upstreamUrl: `ws://127.0.0.1:${lease.halsim_port}/wpilibws`,
      protocols,
      upstreamOpen: false,
      pendingMessages: [],
    },
  };
  if (protocols.length > 0) {
    upgradeOptions.headers = { "sec-websocket-protocol": protocols[0] ?? "" };
  }
  const upgraded = server.upgrade(request, upgradeOptions);
  if (!upgraded) {
    return new Response("WebSocket upgrade failed.", { status: 400 });
  }
  return undefined as unknown as Response;
}

// Admin auth is now handled by requireAdmin() from the middleware module.

async function runTar(args: string[]): Promise<void> {
  const subprocess = Bun.spawn(["tar", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`tar ${args.join(" ")} failed: ${detail}`);
  }
}

async function createProjectArchive(projectDir: string, archivePath: string): Promise<void> {
  await runTar(["-czf", archivePath, "-C", projectDir, "."]);
}

async function restoreProjectArchive(projectDir: string, archivePath: string): Promise<void> {
  const parentDir = dirname(projectDir);
  const tempDir = resolve(parentDir, `.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  try {
    await runTar(["-xzf", archivePath, "-C", tempDir]);
    await rm(projectDir, { recursive: true, force: true });
    await rename(tempDir, projectDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  async function walk(path: string): Promise<void> {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }

    if (info.isSymbolicLink()) {
      return;
    }
    if (info.isFile()) {
      total += info.size;
      return;
    }
    if (!info.isDirectory()) {
      return;
    }

    const entries = await readdir(path).catch(() => []);
    for (const entry of entries) {
      await walk(resolve(path, entry));
    }
  }

  await walk(root);
  return total;
}

function adminStatusResponse(storage: AppStorage, runs: RunManager): AdminStatusResponse {
  const entries = storage.listAllWorkspacesWithLeases();
  const idleMinutes = storage.config.idleStopMinutes;
  const cutoff = Date.now() - idleMinutes * 60_000;

  const workspaces: AdminWorkspaceStatus[] = entries.map((entry) => {
    const lastActivity = entry.workspace.last_accessed_at;
    const isIdle = Date.parse(lastActivity) < cutoff;
    return {
      workspace: {
        id: entry.workspace.id,
        slug: entry.workspace.slug,
        lastAccessedAt: entry.workspace.last_accessed_at,
      },
      user: {
        displayName: entry.user.name,
        email: entry.user.email,
        role: entry.user.role as "student" | "admin",
        slug: entry.user.slug ?? entry.workspace.slug,
        lastSeenAt: entry.workspace.last_accessed_at,
      },
      code: {
        state: entry.lease?.code_state ?? "missing",
        containerName: entry.lease?.vscode_container ?? null,
        simPort: entry.lease?.nt4_port ?? null,
        vscodePort: entry.lease?.vscode_port ?? null,
        halsimPort: entry.lease?.halsim_port ?? null,
      },
      idle: isIdle,
      lastActivity,
    };
  });

  return {
    ok: true,
    workspaces,
    idleStopMinutes: idleMinutes,
    activeBuilds: runs.activeBuildCount(),
    maxActiveContainers: storage.getEffectiveMaxActiveContainers(),
  };
}

function auditActor(adminResult: { user: { id: string; email: string } }): AuditActor {
  return { userId: adminResult.user.id, email: adminResult.user.email };
}

export async function createApp(configInput: ControlAppOptions = {}): Promise<ControlApp> {
  const {
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
  const containers = new ContainerOrchestrator(storage, { dockerRunner, portAvailable });
  const halsim = new HalSimBridge(
    halsimWebSocketFactory ? { webSocketFactory: halsimWebSocketFactory } : {},
  );
  const nt4Auto = new Nt4AutoChooserBridge(
    nt4AutoWebSocketFactory ? { webSocketFactory: nt4AutoWebSocketFactory } : {},
  );
  const runs = new RunManager(storage, containers, { commandFactory: runCommandFactory });
  const imports = new ImportManager(storage, containers);
  const idle = new IdleManager({
    storage,
    containers,
    onStop: (workspaceId) => {
      halsim.disconnect(workspaceId);
      nt4Auto.disconnect(workspaceId);
      console.log(`Idle sweep stopped containers for workspace ${workspaceId}`);
    },
  });
  idle.start();

  async function fetch(request: Request, server?: BunUpgradeServer): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "control", version: "v2-3" });
    }

    if (url.pathname === "/api/openapi.json" && request.method === "GET") {
      return openApiResponse();
    }

    if ((url.pathname === "/scope" || url.pathname.startsWith("/scope/")) && request.method === "GET") {
      return scopeResponse(storage, url.pathname);
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
      return loginPage(storage);
    }

    if (url.pathname === "/login" && request.method === "GET") {
      const error = url.searchParams.get("error");
      return loginPage(storage, error);
    }

    // --- Default-deny: everything below requires a session (or admin token). ---
    // Public routes (healthz, scope, api/auth, /, /login) are handled above.
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
      const adminResult = await requireAdmin(storage.auth, storage, request);
      if (adminResult instanceof Response) {
        return adminResult;
      }

      // Serve static assets for the admin SPA
      if (url.pathname.startsWith("/admin/assets/") && request.method === "GET") {
        return webAssetResponse(storage, `assets/${url.pathname.slice("/admin/assets/".length)}`);
      }

      if (url.pathname === "/admin/status" && request.method === "GET") {
        return jsonResponse(adminStatusResponse(storage, runs));
      }

      if (url.pathname === "/admin/containers/stats" && request.method === "GET") {
        const workspacesById = new Map(
          storage.listAllWorkspacesWithLeases().map((entry) => [entry.workspace.id, entry]),
        );
        const stats = await containers.managedContainerStats();
        return jsonResponse({
          ok: true,
          containers: stats.map((container) => {
            const entry = container.workspaceId ? workspacesById.get(container.workspaceId as WorkspaceId) : undefined;
            const lease = entry?.lease ?? null;
            return {
              ...container,
              workspaceSlug: entry?.workspace.slug ?? null,
              ports: {
                nt4: lease?.nt4_port ?? null,
                vscode: lease?.vscode_port ?? null,
                halsim: lease?.halsim_port ?? null,
              },
            };
          }),
        });
      }

      if (url.pathname === "/admin/workspaces/disk-usage" && request.method === "GET") {
        const entries = storage.listAllWorkspacesWithLeases();
        const usage = await Promise.all(
          entries.map(async (entry) => ({
            workspaceId: entry.workspace.id,
            workspaceSlug: entry.workspace.slug,
            projectPath: entry.workspace.project_path,
            bytes: await directorySizeBytes(entry.workspace.project_path),
          })),
        );
        return jsonResponse({ ok: true, workspaces: usage });
      }

      const adminWorkspaceMatch = /^\/admin\/workspaces\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (adminWorkspaceMatch && request.method === "POST") {
        const targetWorkspaceId = adminWorkspaceMatch[1] ?? "";
        const action = adminWorkspaceMatch[2] ?? "";
        const workspace = storage.findWorkspaceById(targetWorkspaceId as WorkspaceId);
        if (!workspace) {
          return jsonResponse({ error: "Workspace not found." }, { status: 404 });
        }

        const actor = auditActor(adminResult);

        try {
          if (action === "restart-code") {
            await containers.restartCodeContainer(workspace);
            recordAuditEvent(storage, {
              actor,
              action: "container.restart-code",
              target: { kind: "workspace", id: workspace.id },
            });
            return jsonResponse({
              ok: true,
              action: "restart-code",
              workspaceId: workspace.id,
              detail: "Code container restarted.",
            } satisfies AdminActionResponse);
          }

          if (action === "stop-containers") {
            await containers.stopWorkspaceContainers(workspace.id);
            recordAuditEvent(storage, {
              actor,
              action: "container.stop",
              target: { kind: "workspace", id: workspace.id },
            });
            return jsonResponse({
              ok: true,
              action: "stop-containers",
              workspaceId: workspace.id,
              detail: "All containers stopped.",
            } satisfies AdminActionResponse);
          }

          if (action === "seed-template") {
            const projectDir = workspace.project_path;
            let entries: string[] = [];
            try {
              entries = await readdir(projectDir);
            } catch {
              // Directory doesn't exist yet — treat as empty.
            }
            if (entries.length > 0) {
              return jsonResponse(
                { error: "Workspace project directory is not empty." },
                { status: 409 },
              );
            }
            await mkdir(projectDir, { recursive: true });
            await cp(storage.config.templateDir, projectDir, { recursive: true });
            recordAuditEvent(storage, {
              actor,
              action: "workspace.seed-template",
              target: { kind: "workspace", id: workspace.id },
            });
            return jsonResponse({
              ok: true,
              action: "seed-template",
              workspaceId: workspace.id,
              detail: "Template seeded.",
            } satisfies AdminActionResponse);
          }

          if (action === "backup") {
            const projectDir = workspace.project_path;
            try {
              const s = await stat(projectDir);
              if (!s.isDirectory()) {
                return jsonResponse({ error: "Project directory does not exist." }, { status: 404 });
              }
            } catch {
              return jsonResponse({ error: "Project directory does not exist." }, { status: 404 });
            }
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, "0");
            const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const backupRoot = resolve(storage.config.dataDir, "backups", ts);
            const workspaceBackupDir = resolve(backupRoot, workspace.id);
            const dest = resolve(workspaceBackupDir, "project.tar.gz");
            await mkdir(workspaceBackupDir, { recursive: true });
            await createProjectArchive(projectDir, dest);
            recordAuditEvent(storage, {
              actor,
              action: "workspace.backup",
              target: { kind: "workspace", id: workspace.id },
              metadata: { dest },
            });
            return jsonResponse({
              ok: true,
              action: "backup",
              workspaceId: workspace.id,
              detail: `Backed up to ${dest}`,
            } satisfies AdminActionResponse);
          }

          if (action === "restore") {
            let body: { path?: string };
            try {
              body = await request.json() as { path?: string };
            } catch {
              return jsonResponse({ error: "Request body must be valid JSON." }, { status: 400 });
            }
            if (typeof body.path !== "string" || body.path.trim().length === 0) {
              return jsonResponse({ error: "Missing or empty 'path' in request body." }, { status: 400 });
            }
            const backupsRoot = resolve(storage.config.dataDir, "backups");
            const sourcePath = resolve(body.path);
            if (!isInsideDirectory(backupsRoot, sourcePath)) {
              return jsonResponse({ error: "Restore path must be under data/backups/." }, { status: 403 });
            }
            try {
              const s = await stat(sourcePath);
              if (!s.isFile()) {
                return jsonResponse({ error: "Restore source is not a file." }, { status: 404 });
              }
            } catch {
              return jsonResponse({ error: "Restore source not found." }, { status: 404 });
            }
            const projectDir = workspace.project_path;
            await mkdir(dirname(projectDir), { recursive: true });
            await restoreProjectArchive(projectDir, sourcePath);
            recordAuditEvent(storage, {
              actor,
              action: "workspace.restore",
              target: { kind: "workspace", id: workspace.id },
              metadata: { source: sourcePath },
            });
            return jsonResponse({
              ok: true,
              action: "restore",
              workspaceId: workspace.id,
              detail: `Restored from ${sourcePath}`,
            } satisfies AdminActionResponse);
          }
        } catch (error) {
          return apiErrorResponse(error, `Admin action ${action} failed.`);
        }
      }

      // --- User management endpoints ---
      if (url.pathname === "/admin/users" && request.method === "GET") {
        const users = storage.db.query(
          `
            SELECT
              u.id, u.name, u.email, u.role, u.slug, u.createdAt, u.updatedAt,
              w.id AS workspaceId, w.last_accessed_at AS lastSeenAt
            FROM user u
            LEFT JOIN workspaces w ON w.user_id = u.id
            ORDER BY u.name
          `,
        ).all() as Array<{
          id: string;
          name: string;
          email: string;
          role: string | null;
          slug: string | null;
          createdAt: string;
          updatedAt: string;
          workspaceId: string | null;
          lastSeenAt: string | null;
        }>;
        return jsonResponse({ ok: true, users });
      }

      const userActionMatch = /^\/admin\/users\/([^/]+)\/(promote|demote)$/.exec(url.pathname);
      if (userActionMatch && request.method === "POST") {
        const userId = userActionMatch[1] ?? "";
        const action = userActionMatch[2] as "promote" | "demote";
        const user = storage.db.query("SELECT id, name, email, role FROM user WHERE id = ?").get(userId) as { id: string; name: string; email: string; role: string | null } | null;
        if (!user) {
          return jsonResponse({ error: "User not found." }, { status: 404 });
        }
        const newRole = action === "promote" ? "admin" : "student";
        if (action === "demote" && user.role === "admin") {
          const adminCount = storage.db.query("SELECT COUNT(*) AS count FROM user WHERE role = 'admin'").get() as { count: number };
          if (adminCount.count <= 1) {
            return jsonResponse({ error: "Cannot demote the last admin user." }, { status: 409 });
          }
        }
        storage.db.query("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?").run(newRole, new Date().toISOString(), userId);
        recordAuditEvent(storage, {
          actor: auditActor(adminResult),
          action: action === "promote" ? "user.promote" : "user.demote",
          target: { kind: "user", id: userId },
          metadata: { email: user.email, newRole },
        });
        return jsonResponse({ ok: true, userId, role: newRole });
      }

      const userDeleteMatch = /^\/admin\/users\/([^/]+)$/.exec(url.pathname);
      if (userDeleteMatch && request.method === "DELETE") {
        const userId = userDeleteMatch[1] ?? "";
        const user = storage.db.query("SELECT id, name, email, role FROM user WHERE id = ?").get(userId) as { id: string; name: string; email: string; role: string | null } | null;
        if (!user) {
          return jsonResponse({ error: "User not found." }, { status: 404 });
        }
        if (user.role === "admin") {
          const adminCount = storage.db.query("SELECT COUNT(*) AS count FROM user WHERE role = 'admin'").get() as { count: number };
          if (adminCount.count <= 1) {
            return jsonResponse({ error: "Cannot delete the last admin user." }, { status: 409 });
          }
        }

        const workspace = storage.findWorkspaceByUserId(userId);
        if (workspace) {
          runs.stopWorkspace(workspace.id);
          await containers.stopWorkspaceContainers(workspace.id);
          await containers.removeCodeContainer(workspace.id);
        }

        storage.db.exec("BEGIN");
        try {
          if (workspace) {
            storage.db.query("DELETE FROM run_jobs WHERE workspace_id = ?").run(workspace.id);
            storage.db.query("DELETE FROM container_leases WHERE workspace_id = ?").run(workspace.id);
            storage.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
          }
          storage.db.query("DELETE FROM session WHERE userId = ?").run(userId);
          storage.db.query("DELETE FROM account WHERE userId = ?").run(userId);
          storage.db.query("DELETE FROM user WHERE id = ?").run(userId);
          storage.db.exec("COMMIT");
        } catch (error) {
          storage.db.exec("ROLLBACK");
          throw error;
        }

        if (workspace) {
          await rm(dirname(workspace.project_path), { recursive: true, force: true });
        }

        recordAuditEvent(storage, {
          actor: auditActor(adminResult),
          action: "user.delete",
          target: { kind: "user", id: userId },
          metadata: { email: user.email },
        });

        return jsonResponse({ ok: true, userId });
      }

      // --- Allowlist endpoints ---
      if (url.pathname === "/admin/allowlist" && request.method === "GET") {
        const { getAllowlist } = await import("./auth/allowlist");
        return jsonResponse({ ok: true, ...getAllowlist() });
      }

      if (url.pathname === "/admin/allowlist" && request.method === "POST") {
        const { addAllowlistEntry } = await import("./auth/allowlist");
        let body: { kind?: string; value?: string };
        try {
          body = await request.json() as { kind?: string; value?: string };
        } catch {
          return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
        }
        if (body.kind !== "email" && body.kind !== "domain") {
          return jsonResponse({ error: "kind must be 'email' or 'domain'." }, { status: 400 });
        }
        if (typeof body.value !== "string" || !body.value.trim()) {
          return jsonResponse({ error: "value is required." }, { status: 400 });
        }
        const result = await addAllowlistEntry(body.kind, body.value);
        recordAuditEvent(storage, {
          actor: auditActor(adminResult),
          action: "allowlist.add",
          target: { kind: "allowlist", id: body.value },
          metadata: { kind: body.kind },
        });
        return jsonResponse({ ok: true, ...result });
      }

      const allowlistDeleteMatch = /^\/admin\/allowlist\/(.+)$/.exec(url.pathname);
      if (allowlistDeleteMatch && request.method === "DELETE") {
        const { removeAllowlistEntry, getAllowlist } = await import("./auth/allowlist");
        const value = decodeURIComponent(allowlistDeleteMatch[1] ?? "");
        const current = getAllowlist();
        const kind = current.emails.includes(value.toLowerCase()) ? "email" : "domain";
        await removeAllowlistEntry(kind, value);
        recordAuditEvent(storage, {
          actor: auditActor(adminResult),
          action: "allowlist.remove",
          target: { kind: "allowlist", id: value },
          metadata: { kind },
        });
        const updated = getAllowlist();
        return jsonResponse({ ok: true, ...updated });
      }

      // --- Allowlist reload ---
      if (url.pathname === "/admin/allowlist/reload" && request.method === "POST") {
        const { reloadAllowlist } = await import("./auth/allowlist");
        try {
          const result = await reloadAllowlist();
          return jsonResponse({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResponse({ ok: false, error: message }, { status: 400 });
        }
      }

      // --- Capacity cap runtime override ---
      if (url.pathname === "/admin/config/max-active-containers" && request.method === "POST") {
        let body: { value?: unknown };
        try {
          body = await request.json() as { value?: unknown };
        } catch {
          return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
        }
        const value = Number(body.value);
        if (!Number.isInteger(value) || value < 1) {
          return jsonResponse({ error: "value must be a positive integer." }, { status: 400 });
        }
        storage.setRuntimeConfig("max_active_containers", String(value));
        const actor = auditActor(adminResult);
        recordAuditEvent(storage, {
          actor,
          action: "config.max-active-containers",
          metadata: { value },
        });
        return jsonResponse({ ok: true, maxActiveContainers: value });
      }

      if (url.pathname === "/admin/config/max-active-containers" && request.method === "GET") {
        return jsonResponse({
          ok: true,
          maxActiveContainers: storage.getEffectiveMaxActiveContainers(),
          configDefault: storage.config.maxActiveContainers,
        });
      }

      // --- Audit log ---
      if (url.pathname === "/admin/audit-log" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const before = url.searchParams.get("before") ? Number(url.searchParams.get("before")) : undefined;
        const actorEmail = url.searchParams.get("actor") ?? undefined;
        const actionPrefix = url.searchParams.get("action") ?? undefined;
        const days = url.searchParams.get("days") ? Number(url.searchParams.get("days")) : undefined;
        const sinceMs = days ? Date.now() - days * 86_400_000 : undefined;
        const entries = queryAuditLog(storage, { limit, before, actorEmail, actionPrefix, sinceMs });
        return jsonResponse({ ok: true, entries });
      }

      return notFound();
    }

    const workspaceMatch = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (workspaceMatch) {
      const slug = workspaceMatch[1] ?? "";
      const suffix = workspaceMatch[2] ?? "";
      if (suffix === "") {
        return redirect(`/u/${slug}/`);
      }

      if (!workspaceSlugSchema.safeParse(slug).success) {
        return new Response("Invalid workspace slug.", { status: 400 });
      }

      const isApiRequest = suffix.startsWith("/api/");
      const auth = await requireWorkspaceOwnership(storage.auth, storage, request, slug);
      if (auth instanceof Response) {
        if (!isApiRequest && auth.status === 401) return redirect("/login");
        return auth;
      }

      if (suffix === "/" && request.method === "GET") {
        containers.startWorkspaceContainers(auth.workspace);
        return webShellResponse(storage);
      }

      if (suffix === "/ws/run" && request.method === "GET") {
        if (!server || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected WebSocket upgrade.", { status: 426 });
        }
        const originError = requireWebSocketOrigin(request, storage.config.baseUrl);
        if (originError) {
          return originError;
        }
        const upgraded = server.upgrade(request, {
          data: {
            kind: "run",
            workspace: auth.workspace,
          },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed.", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      if (suffix === "/sim/alive" && request.method === "GET") {
        try {
          return await nt4AliveResponse(storage, containers, auth, upstreamFetch);
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Simulator not available.");
        }
      }

      if (suffix === "/sim/nt4" && request.method === "GET") {
        try {
          return await nt4WebSocketResponse(storage, containers, auth, request, server);
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Simulator not available.");
        }
      }

      if (suffix === "/sim/halsim" && request.method === "GET") {
        try {
          return await halsimWebSocketResponse(storage, containers, auth, request, server);
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Simulator not available.");
        }
      }

      // --- Editor proxy: openvscode-server ---
      // Match /vscode or /vscode/* (the suffix starts with /vscode).
      // The full URL path including /u/<slug>/vscode/ is passed through
      // unchanged because openvscode-server is launched with
      // --server-base-path /u/<slug>/vscode/.
      if (suffix === "/vscode" || suffix.startsWith("/vscode/")) {
        const fullPath = url.pathname + (url.search || "");
        try {
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            return await vscodeWebSocketResponse(storage, containers, auth, request, fullPath, upstreamFetch, server);
          }
          return await vscodeHttpProxyResponse(storage, containers, auth, request, fullPath, upstreamFetch);
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Editor not available.");
        }
      }

      if (suffix.startsWith("/assets/") && request.method === "GET") {
        return webAssetResponse(storage, `assets/${suffix.slice("/assets/".length)}`);
      }

      if (suffix === "/api/session" && request.method === "GET") {
        return jsonResponse(sessionResponse(auth));
      }

      if (suffix === "/api/containers/status" && request.method === "GET") {
        try {
          return await containersStatusResponse(containers, auth);
        } catch (error) {
          return apiErrorResponse(error, "Unable to read container status.");
        }
      }

      if (suffix === "/api/sim/status" && request.method === "GET") {
        try {
          return await simStatusResponse(storage, containers, runs, halsim, auth);
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Unable to read simulation status.");
        }
      }

      if (suffix === "/api/sim/auto-choosers" && request.method === "GET") {
        try {
          return jsonResponse(await autoChoosersSnapshot(storage, containers, runs, nt4Auto, auth));
        } catch (error) {
          return capacityErrorResponse(error) ?? apiErrorResponse(error, "Unable to read auto choosers.");
        }
      }

      if (suffix === "/api/sim/run" && request.method === "POST") {
        try {
          const parsed = simRunCommandRequestSchema.parse(await request.json());
          let runId: string | null = null;
          if (parsed.action === "stop") {
            runs.stopWorkspace(auth.workspace.id);
            halsim.disconnect(auth.workspace.id);
            nt4Auto.disconnect(auth.workspace.id);
          } else {
            halsim.disconnect(auth.workspace.id);
            nt4Auto.disconnect(auth.workspace.id);
            runId = runs.start(auth.workspace);
          }
          const snapshot = runs.getWorkspaceSnapshot(auth.workspace.id);
          const body: SimRunCommandResponse = {
            ok: true,
            action: parsed.action,
            runId: runId ?? snapshot.runId,
            status: snapshot.status,
          };
          return jsonResponse(body, { status: parsed.action === "stop" ? 200 : 202 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid simulation run command.";
          return jsonResponse({ error: message }, { status: 400 });
        }
      }

      if (suffix === "/api/sim/driver-station" && request.method === "PATCH") {
        try {
          const patch = driverStationPatchSchema.parse(await request.json());
          const run = runs.getWorkspaceSnapshot(auth.workspace.id);
          if (run.status !== "running") {
            return jsonResponse({ error: "Robot code is not running." }, { status: 409 });
          }
          const code = await containers.ensureCodeContainer(auth.workspace);
          const lease = storage.getContainerLease(auth.workspace.id);
          if (code.state !== "running" || !lease?.halsim_port) {
            return jsonResponse({ error: code.error ?? "HALSim is not available." }, { status: 503 });
          }
          halsim.applyDriverStationPatch(auth.workspace.id, lease.halsim_port, patch);
          return jsonResponse(await simStatusSnapshot(storage, containers, runs, halsim, auth));
        } catch (error) {
          const status = error instanceof Error && typeof (error as Error & { status?: unknown }).status === "number"
            ? ((error as Error & { status: number }).status)
            : 400;
          const message = error instanceof Error ? error.message : "Invalid Driver Station command.";
          return jsonResponse({ error: message }, { status });
        }
      }

      if (suffix === "/api/sim/auto-chooser" && request.method === "PATCH") {
        try {
          const patch = autoChooserPatchSchema.parse(await request.json());
          const run = runs.getWorkspaceSnapshot(auth.workspace.id);
          if (run.status !== "running") {
            return jsonResponse({ error: "Robot code is not running." }, { status: 409 });
          }
          const code = await containers.ensureCodeContainer(auth.workspace);
          const lease = storage.getContainerLease(auth.workspace.id);
          if (code.state !== "running" || !lease?.nt4_port) {
            return jsonResponse({ error: code.error ?? "NT4 is not available." }, { status: 503 });
          }
          return jsonResponse(nt4Auto.select(auth.workspace.id, lease.nt4_port, patch));
        } catch (error) {
          const status = error instanceof Error && typeof (error as Error & { status?: unknown }).status === "number"
            ? ((error as Error & { status: number }).status)
            : 400;
          const message = error instanceof Error ? error.message : "Invalid auto chooser command.";
          return jsonResponse({ error: message }, { status });
        }
      }

      if (suffix === "/api/run" && request.method === "POST") {
        halsim.disconnect(auth.workspace.id);
        nt4Auto.disconnect(auth.workspace.id);
        const runId = runs.start(auth.workspace);
        return jsonResponse({ ok: true, runId }, { status: 202 });
      }

      if (suffix === "/api/run/stop" && request.method === "POST") {
        halsim.disconnect(auth.workspace.id);
        nt4Auto.disconnect(auth.workspace.id);
        return jsonResponse({ ok: true, stopped: runs.stopWorkspace(auth.workspace.id) });
      }

      // --- Import endpoints ---
      if (suffix === "/api/project/import" && request.method === "POST") {
        try {
          const body = await request.json();
          const parsed = importRequestSchema.parse(body);
          const { cloneUrl, branch, subdir } = parseGitHubUrl(parsed.url, parsed.branch, parsed.subdir);
          validateBranch(branch);
          if (subdir) validateSubdir(subdir);
          // Validate only — actual import runs via WS stream
          return jsonResponse({ ok: true, cloneUrl, branch, subdir });
        } catch (error) {
          if (error instanceof ImportError) {
            return jsonResponse({ error: error.message }, { status: 400 });
          }
          if (error instanceof RateLimitError) {
            return jsonResponse({ error: error.message }, { status: 429 });
          }
          const message = error instanceof Error ? error.message : "Invalid import request.";
          return jsonResponse({ error: message }, { status: 400 });
        }
      }

      if (suffix === "/api/project/recent-imports" && request.method === "GET") {
        try {
          const recentImports = await listRecentImports(auth.workspace);
          return jsonResponse({ ok: true, imports: recentImports });
        } catch (error) {
          return apiErrorResponse(error, "Unable to list recent imports.");
        }
      }

      if (suffix === "/api/project/restore" && request.method === "POST") {
        try {
          const body = await request.json() as { archiveFile?: string };
          if (typeof body.archiveFile !== "string" || !body.archiveFile.trim()) {
            return jsonResponse({ error: "Missing or empty 'archiveFile'." }, { status: 400 });
          }
          await restoreImportBackup(auth.workspace, body.archiveFile);
          return jsonResponse({ ok: true, message: "Project restored from backup." });
        } catch (error) {
          if (error instanceof ImportError) {
            return jsonResponse({ error: error.message }, { status: 400 });
          }
          return apiErrorResponse(error, "Restore failed.");
        }
      }

      if (suffix === "/ws/import" && request.method === "GET") {
        if (!server || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected WebSocket upgrade.", { status: 426 });
        }
        const originError = requireWebSocketOrigin(request, storage.config.baseUrl);
        if (originError) {
          return originError;
        }
        const upgraded = server.upgrade(request, {
          data: {
            kind: "import",
            workspace: auth.workspace,
            userId: auth.user.id,
          } satisfies ImportSocketData,
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed.", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      if (suffix === "/api/heartbeat" && request.method === "POST") {
        try {
          return jsonResponse(await readHeartbeatRequest(request, storage, auth));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid heartbeat request.";
          return jsonResponse({ error: message }, { status: 400 });
        }
      }
    }

    return notFound();
  }

  function socketMessageText(message: string | ArrayBuffer | Uint8Array): string {
    if (typeof message === "string") {
      return message;
    }
    return new TextDecoder().decode(message);
  }

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
        upstream.send(message);
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

  const websocket = {
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
      ws.data.connection = runs.connect(ws.data.workspace, (message) => {
        ws.send(JSON.stringify(message));
      });
    },
    message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void {
      if (ws.data.kind === "nt4" || ws.data.kind === "vscode" || ws.data.kind === "halsim") {
        if (ws.data.upstreamOpen && ws.data.upstream) {
          ws.data.upstream.send(message);
        } else {
          if (ws.data.pendingMessages.length >= PROXY_PENDING_LIMIT) {
            ws.close(1013, "Upstream is not ready; please retry.");
            return;
          }
          ws.data.pendingMessages.push(message);
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

      if (ws.data.connection) {
        runs.disconnect(ws.data.connection);
      }
    },
  };

  return {
    fetch,
    websocket,
    storage,
    containers,
    halsim,
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
