/**
 * Auth middleware helpers — default-deny session gating.
 *
 * These replace the old per-route `authFromRequest` + `resolveWorkspaceRequest`
 * with centralized helpers backed by Better Auth.
 */
import type { Auth } from "./auth";
import type { AppStorage, AuthContext, WorkspaceRow } from "../storage";
import type { WorkspaceSlug } from "@frc-sim/contracts";

/** Resolve a Better Auth session from the incoming request. Returns null if no valid session. */
export async function getSessionFromRequest(
  auth: Auth,
  request: Request,
): Promise<{ user: { id: string; email: string; name: string; image: string | null; role: string; slug: string }; session: { token: string } } | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;

    const user = session.user as { id: string; email: string; name: string; image?: string | null; role?: string; slug?: string };
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image ?? null,
        role: (user.role as string) ?? "student",
        slug: (user.slug as string) ?? "",
      },
      session: { token: session.session.token },
    };
  } catch {
    return null;
  }
}

/** Require a valid session. Returns the session or a 401 Response. */
export async function requireSession(
  auth: Auth,
  request: Request,
): Promise<{ user: { id: string; email: string; name: string; image: string | null; role: string; slug: string }; session: { token: string } } | Response> {
  const session = await getSessionFromRequest(auth, request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  return session;
}

/** Require session + workspace ownership. Returns AuthContext or error Response. */
export async function requireWorkspaceOwnership(
  auth: Auth,
  storage: AppStorage,
  request: Request,
  slug: string,
): Promise<AuthContext | Response> {
  const session = await getSessionFromRequest(auth, request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const workspace = storage.findWorkspaceBySlug(slug as WorkspaceSlug);
  if (!workspace || workspace.user_id !== session.user.id) {
    return new Response("Workspace is not available for this session.", { status: 403 });
  }

  storage.touchWorkspace(workspace.id);

  return {
    user: session.user,
    workspace,
  };
}

/** Require admin role. Returns session or error Response. Honors ADMIN_TOKEN as break-glass. */
export async function requireAdmin(
  auth: Auth,
  storage: AppStorage,
  request: Request,
): Promise<{ user: { id: string; email: string; name: string; image: string | null; role: string; slug: string } } | Response> {
  // Break-glass: ADMIN_TOKEN header
  const adminToken = storage.config.adminToken;
  if (adminToken) {
    const authHeader = request.headers.get("authorization");
    if (authHeader === `Bearer ${adminToken}`) {
      return {
        user: {
          id: "<admin-token>",
          email: "<admin-token>",
          name: "Admin Token",
          image: null,
          role: "admin",
          slug: "",
        },
      };
    }
  }

  const session = await getSessionFromRequest(auth, request);
  if (session && session.user.role === "admin") {
    return session;
  }

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  return new Response("Forbidden", { status: 403 });
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function isAllowedWebSocketOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients often omit Origin. Browser WebSocket requests include it,
    // so cross-site hijacking is still blocked by the checks below.
    return true;
  }

  try {
    const originUrl = new URL(origin);
    const expectedUrl = new URL(baseUrl);
    if (normalizeHost(originUrl.host) === normalizeHost(expectedUrl.host)) {
      return true;
    }

    // Local development commonly mixes localhost and 127.0.0.1 while keeping
    // the same control plane; allow those loopback aliases only in loopback dev.
    return isLoopbackHost(originUrl.hostname) && isLoopbackHost(expectedUrl.hostname);
  } catch {
    return false;
  }
}

export function requireWebSocketOrigin(request: Request, baseUrl: string): Response | null {
  return isAllowedWebSocketOrigin(request, baseUrl)
    ? null
    : new Response("WebSocket origin is not allowed.", { status: 403 });
}
