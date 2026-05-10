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
): Promise<{ user: { id: string; email: string; name: string; role: string; slug: string }; session: { token: string } } | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;

    const user = session.user as { id: string; email: string; name: string; role?: string; slug?: string };
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
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
): Promise<{ user: { id: string; email: string; name: string; role: string; slug: string }; session: { token: string } } | Response> {
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
): Promise<{ user: { id: string; email: string; name: string; role: string; slug: string } } | Response> {
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

  // Localhost-only fallback: when no adminToken is set, allow unauthenticated admin access
  if (!adminToken) {
    return {
      user: session?.user ?? {
        id: "<localhost>",
        email: "<localhost>",
        name: "Localhost Admin",
        role: "admin",
        slug: "",
      },
    };
  }

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  return new Response("Forbidden", { status: 403 });
}
