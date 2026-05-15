import { heartbeatRequestSchema, type HeartbeatResponse, type SessionResponse } from "@frc-sim/contracts";
import { CapacityExceededError, type CodeContainerStatus } from "../containers";
import type { WorkspaceRuntime } from "../runtime";
import type { AppStorage, AuthContext } from "../storage";

export function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function redirect(location: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("location", location);
  return new Response(null, { ...init, status: init.status ?? 303, headers });
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export function sessionResponse(auth: AuthContext): SessionResponse {
  return {
    user: {
      id: auth.user.id,
      displayName: auth.user.name,
      email: auth.user.email,
      avatarUrl: auth.user.image,
      slug: auth.workspace.slug,
      role: auth.user.role as "student" | "admin",
    },
    workspace: {
      id: auth.workspace.id,
      slug: auth.workspace.slug,
    },
  };
}

export function apiErrorResponse(error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : fallback;
  const maybeStatus = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  const status = typeof maybeStatus === "number" ? maybeStatus : 500;
  return jsonResponse({ error: message }, { status });
}

export function codeStatusFromRuntime(runtime: WorkspaceRuntime): CodeContainerStatus {
  return {
    role: "code",
    state: runtime.state,
    image: runtime.image,
    containerName: runtime.runtimeName,
    simPortAllocated: runtime.ports.nt4 !== null,
    vscodePortAllocated: runtime.ports.vscode !== null,
    halsimPortAllocated: runtime.ports.halsim !== null,
    lastUsedAt: runtime.lastUsedAt,
    error: runtime.error,
  };
}

export async function readHeartbeatRequest(
  request: Request,
  storage: AppStorage,
  auth: AuthContext,
): Promise<HeartbeatResponse> {
  const text = await request.text();
  const input = text.trim() ? JSON.parse(text) : {};
  const parsed = heartbeatRequestSchema.parse(input);
  storage.touchContainerLeaseActivity(auth.workspace.id);
  return { ok: true, closing: parsed.closing ?? false };
}

export function capacityErrorResponse(error: unknown): Response | null {
  if (error instanceof CapacityExceededError) {
    return jsonResponse(
      { error: "capacity", limit: error.limit, current: error.current },
      { status: 503 },
    );
  }
  return null;
}
