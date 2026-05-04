import { displayNameSchema, workspaceSlugSchema, type UserId, type WorkspaceSlug } from "@frc-sim/contracts";
import type { ControlConfigInput } from "./config";
import {
  parseSignedSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "./cookies";
import { createStorage, SlugTakenError, type AppStorage, type AuthContext } from "./storage";

export type ControlApp = {
  fetch(request: Request): Promise<Response>;
  storage: AppStorage;
  close(): void;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginPage(error: string | null = null, init: ResponseInit = {}): Response {
  const errorMarkup = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FRC Web Simulator V1</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #101820; color: #f5f7fb; }
      main { width: min(28rem, calc(100vw - 2rem)); }
      form { display: grid; gap: 0.75rem; }
      input, button { font: inherit; padding: 0.7rem 0.8rem; border-radius: 0.4rem; border: 1px solid #52606d; }
      button { background: #2f80ed; color: white; border-color: #2f80ed; cursor: pointer; }
      p[role="alert"] { color: #ffb4ab; }
    </style>
  </head>
  <body>
    <main>
      <h1>FRC Web Simulator</h1>
      ${errorMarkup}
      <form method="post" action="/login">
        <label for="displayName">Classroom name</label>
        <input id="displayName" name="displayName" autocomplete="name" required maxlength="80">
        <button type="submit">Enter workspace</button>
      </form>
    </main>
  </body>
</html>`, init);
}

function workspacePage(auth: AuthContext): Response {
  const displayName = escapeHtml(auth.user.display_name);
  const workspaceSlug = escapeHtml(auth.workspace.slug);
  const workspaceId = escapeHtml(auth.workspace.id);
  const projectPath = escapeHtml(auth.workspace.project_path);

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${displayName} - FRC Web Simulator V1</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0f1720; color: #f8fafc; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid #263241; }
      main { padding: 1.25rem; display: grid; gap: 0.75rem; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.45rem 0.8rem; }
      dt { color: #aeb8c4; }
      dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      button { font: inherit; padding: 0.5rem 0.7rem; border-radius: 0.35rem; border: 1px solid #52606d; background: #17212f; color: #f8fafc; cursor: pointer; }
    </style>
  </head>
  <body>
    <header>
      <strong>FRC Web Simulator V1</strong>
      <form method="post" action="/logout"><button type="submit">Logout</button></form>
    </header>
    <main>
      <h1>${displayName}</h1>
      <dl>
        <dt>Workspace slug</dt><dd>${workspaceSlug}</dd>
        <dt>Workspace ID</dt><dd>${workspaceId}</dd>
        <dt>Project path</dt><dd>${projectPath}</dd>
      </dl>
    </main>
  </body>
</html>`);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function readDisplayName(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) {
    throw new Error("Login form must be submitted as form data.");
  }

  const form = await request.formData();
  const displayName = form.get("displayName");
  if (typeof displayName !== "string") {
    throw new Error("Display name is required.");
  }

  return displayNameSchema.parse(displayName);
}

function currentUserId(auth: AuthContext | null): UserId | null {
  return auth?.user.id ?? null;
}

function authFromRequest(storage: AppStorage, request: Request): AuthContext | null {
  const sessionId = parseSignedSessionCookie(request.headers.get("cookie"), storage.config.sessionSecret);
  if (!sessionId) {
    return null;
  }

  const auth = storage.getAuthContext(sessionId);
  if (!auth) {
    return null;
  }

  storage.touchSession(auth);
  return auth;
}

function resolveWorkspaceRequest(storage: AppStorage, request: Request, slug: string): Response | AuthContext {
  const parsedSlug = workspaceSlugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return new Response("Invalid workspace slug", { status: 400 });
  }

  const auth = authFromRequest(storage, request);
  if (!auth) {
    return redirect("/");
  }

  const workspace = storage.findWorkspaceBySlug(parsedSlug.data as WorkspaceSlug);
  if (!workspace || workspace.user_id !== auth.user.id) {
    return new Response("Workspace is not available for this session.", { status: 403 });
  }

  return auth;
}

export async function createApp(configInput: ControlConfigInput = {}): Promise<ControlApp> {
  const storage = await createStorage(configInput);

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "control", version: "v1-1" });
    }

    if (url.pathname === "/" && request.method === "GET") {
      const auth = authFromRequest(storage, request);
      if (auth) {
        return redirect(`/u/${auth.workspace.slug}/`);
      }
      return loginPage();
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const auth = authFromRequest(storage, request);

      try {
        const displayName = await readDisplayName(request);
        const login = await storage.login(displayName, currentUserId(auth));
        const headers = new Headers({
          "set-cookie": serializeSessionCookie(login.session.id, storage.config.sessionSecret, login.expiresAt),
        });
        return redirect(`/u/${login.workspace.slug}/`, { headers });
      } catch (error) {
        const message =
          error instanceof SlugTakenError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unable to create workspace.";
        const status = error instanceof SlugTakenError ? 409 : 400;
        return loginPage(message, { status });
      }
    }

    if (url.pathname === "/logout" && request.method === "POST") {
      const sessionId = parseSignedSessionCookie(request.headers.get("cookie"), storage.config.sessionSecret);
      if (sessionId) {
        storage.deleteSession(sessionId);
      }

      return redirect("/", {
        headers: {
          "set-cookie": serializeExpiredSessionCookie(),
        },
      });
    }

    const workspaceMatch = /^\/u\/([^/]+)\/?$/.exec(url.pathname);
    if (workspaceMatch && request.method === "GET") {
      const slug = workspaceMatch[1] ?? "";
      const auth = resolveWorkspaceRequest(storage, request, slug);
      if (auth instanceof Response) {
        return auth;
      }

      return workspacePage(auth);
    }

    return notFound();
  }

  return {
    fetch,
    storage,
    close() {
      storage.close();
    },
  };
}
