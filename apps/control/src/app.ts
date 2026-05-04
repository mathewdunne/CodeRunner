import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  createFileRequestSchema,
  displayNameSchema,
  getProjectPathAccess,
  heartbeatRequestSchema,
  projectPathSchema,
  renameFileRequestSchema,
  writeFileRequestSchema,
  workspaceSlugSchema,
  type CreateFileRequest,
  type FileMutationResponse,
  type HeartbeatResponse,
  type ProjectPathAccess,
  type ProjectPath,
  type ProjectFileResponse,
  type ProjectTreeNode,
  type ProjectTreeResponse,
  type RenameFileRequest,
  type SessionResponse,
  type UserId,
  type WriteFileRequest,
  type WorkspaceSlug,
} from "@frc-sim/contracts";
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

type WorkspaceRequestKind = "page" | "api";

function resolveWorkspaceRequest(
  storage: AppStorage,
  request: Request,
  slug: string,
  kind: WorkspaceRequestKind,
): Response | AuthContext {
  const parsedSlug = workspaceSlugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return new Response("Invalid workspace slug", { status: 400 });
  }

  const auth = authFromRequest(storage, request);
  if (!auth) {
    return kind === "api" ? new Response("Unauthorized", { status: 401 }) : redirect("/");
  }

  const workspace = storage.findWorkspaceBySlug(parsedSlug.data as WorkspaceSlug);
  if (!workspace || workspace.user_id !== auth.user.id) {
    return new Response("Workspace is not available for this session.", { status: 403 });
  }

  return auth;
}

function sessionResponse(auth: AuthContext): SessionResponse {
  return {
    user: {
      id: auth.user.id,
      displayName: auth.user.display_name,
      slug: auth.user.slug,
    },
    workspace: {
      id: auth.workspace.id,
      slug: auth.workspace.slug,
    },
  };
}

function sortProjectNodes(left: ProjectTreeNode, right: ProjectTreeNode): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

async function readProjectTreeNode(projectRoot: string, relativePath: string): Promise<ProjectTreeNode | null> {
  const absolutePath = relativePath ? resolve(projectRoot, ...relativePath.split("/")) : projectRoot;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const children: ProjectTreeNode[] = [];

  for (const entry of entries) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const access = getProjectPathAccess(childPath);
    if (access === "blocked") {
      continue;
    }

    if (entry.isDirectory()) {
      const child = await readProjectTreeNode(projectRoot, childPath);
      if (child && ((child.children?.length ?? 0) > 0 || access !== "outside-allowlist")) {
        children.push(child);
      }
      continue;
    }

    if (entry.isFile()) {
      if (access === "outside-allowlist") {
        continue;
      }

      children.push({
        name: entry.name,
        path: childPath,
        kind: "file",
        access,
      });
    }
  }

  children.sort(sortProjectNodes);

  if (!relativePath) {
    return {
      name: "project",
      path: "",
      kind: "directory",
      access: "root",
      children,
    };
  }

  const access = getProjectPathAccess(relativePath);
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    path: relativePath,
    kind: "directory",
    access,
    children,
  };
}

async function projectTreeResponse(auth: AuthContext): Promise<ProjectTreeResponse> {
  const tree = await readProjectTreeNode(auth.workspace.project_path, "");
  if (!tree) {
    throw new Error(`Failed to read project tree for workspace ${auth.workspace.id}.`);
  }

  return {
    workspace: {
      id: auth.workspace.id,
      slug: auth.workspace.slug,
    },
    tree,
  };
}

async function mutationResponse(auth: AuthContext): Promise<FileMutationResponse> {
  return {
    ok: true,
    tree: await projectTreeResponse(auth),
  };
}

function projectPathFromQuery(url: URL): string {
  const value = url.searchParams.get("path");
  if (value === null) {
    throw Object.assign(new Error("Missing project path."), { status: 400 });
  }
  return value;
}

type ResolvedProjectPath = {
  path: ProjectPath;
  absolutePath: string;
  access: Exclude<ProjectPathAccess, "blocked" | "outside-allowlist">;
};

function resolveProjectFilePath(auth: AuthContext, pathInput: string, mode: "read" | "write"): ResolvedProjectPath {
  const parsed = projectPathSchema.safeParse(pathInput);
  if (!parsed.success) {
    throw Object.assign(new Error("Invalid project path."), { status: 400 });
  }

  const projectPath = parsed.data;
  const access = getProjectPathAccess(projectPath);
  if (access === "blocked" || access === "outside-allowlist") {
    throw Object.assign(new Error("Project path is not available."), { status: 403 });
  }

  if (mode === "write" && access !== "editable") {
    throw Object.assign(new Error("Project path is read-only."), { status: 403 });
  }

  const absolutePath = resolve(auth.workspace.project_path, ...projectPath.split("/"));
  if (!isInsideDirectory(auth.workspace.project_path, absolutePath)) {
    throw Object.assign(new Error("Project path resolved outside the workspace."), { status: 403 });
  }

  return { path: projectPath, absolutePath, access };
}

async function readJsonRequest<T>(request: Request, parse: (input: unknown) => T): Promise<T> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }

  try {
    return parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request body did not match the API contract.";
    throw Object.assign(new Error(message), { status: 400 });
  }
}

async function readProjectFile(auth: AuthContext, pathInput: string): Promise<ProjectFileResponse> {
  const resolvedPath = resolveProjectFilePath(auth, pathInput, "read");
  const fileStat = await stat(resolvedPath.absolutePath).catch(() => null);
  if (!fileStat) {
    throw Object.assign(new Error("Project file was not found."), { status: 404 });
  }

  if (!fileStat.isFile()) {
    throw Object.assign(new Error("Project path is not a file."), { status: 400 });
  }

  return {
    path: resolvedPath.path,
    contents: await readFile(resolvedPath.absolutePath, "utf8"),
    access: resolvedPath.access,
  };
}

async function writeProjectFile(
  auth: AuthContext,
  pathInput: string,
  requestBody: WriteFileRequest,
): Promise<FileMutationResponse> {
  const resolvedPath = resolveProjectFilePath(auth, pathInput, "write");
  const parentStat = await stat(dirname(resolvedPath.absolutePath)).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw Object.assign(new Error("Parent directory does not exist."), { status: 409 });
  }

  await writeFile(resolvedPath.absolutePath, requestBody.contents, "utf8");
  return mutationResponse(auth);
}

async function createProjectEntry(auth: AuthContext, requestBody: CreateFileRequest): Promise<FileMutationResponse> {
  const resolvedPath = resolveProjectFilePath(auth, requestBody.path, "write");
  const existing = await stat(resolvedPath.absolutePath).catch(() => null);
  if (existing) {
    throw Object.assign(new Error("Project path already exists."), { status: 409 });
  }

  const parentStat = await stat(dirname(resolvedPath.absolutePath)).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw Object.assign(new Error("Parent directory does not exist."), { status: 409 });
  }

  if (requestBody.kind === "directory") {
    await mkdir(resolvedPath.absolutePath);
  } else {
    await writeFile(resolvedPath.absolutePath, requestBody.contents ?? "", "utf8");
  }

  return mutationResponse(auth);
}

async function renameProjectEntry(auth: AuthContext, requestBody: RenameFileRequest): Promise<FileMutationResponse> {
  const from = resolveProjectFilePath(auth, requestBody.from, "write");
  const to = resolveProjectFilePath(auth, requestBody.to, "write");

  const fromStat = await stat(from.absolutePath).catch(() => null);
  if (!fromStat) {
    throw Object.assign(new Error("Source path was not found."), { status: 404 });
  }

  const toStat = await stat(to.absolutePath).catch(() => null);
  if (toStat) {
    throw Object.assign(new Error("Destination path already exists."), { status: 409 });
  }

  const parentStat = await stat(dirname(to.absolutePath)).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw Object.assign(new Error("Destination parent directory does not exist."), { status: 409 });
  }

  await rename(from.absolutePath, to.absolutePath);
  return mutationResponse(auth);
}

async function deleteProjectEntry(auth: AuthContext, pathInput: string): Promise<FileMutationResponse> {
  const resolvedPath = resolveProjectFilePath(auth, pathInput, "write");
  const fileStat = await stat(resolvedPath.absolutePath).catch(() => null);
  if (!fileStat) {
    throw Object.assign(new Error("Project path was not found."), { status: 404 });
  }

  try {
    await rm(resolvedPath.absolutePath, { recursive: false });
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    if (code === "ENOTEMPTY") {
      throw Object.assign(new Error("Directory is not empty."), { status: 409 });
    }
    throw error;
  }
  return mutationResponse(auth);
}

function apiErrorResponse(error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : fallback;
  const maybeStatus = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  const status = typeof maybeStatus === "number" ? maybeStatus : 500;
  return jsonResponse({ error: message }, { status });
}

async function readHeartbeatRequest(request: Request): Promise<HeartbeatResponse> {
  const text = await request.text();
  const input = text.trim() ? JSON.parse(text) : {};
  const parsed = heartbeatRequestSchema.parse(input);
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
    case ".svg":
      return "image/svg+xml";
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

async function staticFileResponse(root: string, path: string): Promise<Response> {
  const target = resolve(root, path);
  if (!isInsideDirectory(root, target)) {
    return new Response("Static asset path is outside the web shell.", { status: 403 });
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
      "The V1 web shell has not been built yet. Run `bun run build:web` before starting the control plane.",
      { status: 503 },
    );
  }
}

async function webAssetResponse(storage: AppStorage, rawPath: string): Promise<Response> {
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawPath);
  } catch {
    return new Response("Invalid static asset path.", { status: 400 });
  }

  const parsed = projectPathSchema.safeParse(assetPath);
  if (!parsed.success) {
    return new Response("Invalid static asset path.", { status: 400 });
  }

  return staticFileResponse(storage.config.webDistDir, parsed.data);
}

export async function createApp(configInput: ControlConfigInput = {}): Promise<ControlApp> {
  const storage = await createStorage(configInput);

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "control", version: "v1-3" });
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

    const workspaceMatch = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (workspaceMatch) {
      const slug = workspaceMatch[1] ?? "";
      const suffix = workspaceMatch[2] ?? "";
      if (suffix === "") {
        return redirect(`/u/${slug}/`);
      }

      const isApiRequest = suffix.startsWith("/api/");
      const auth = resolveWorkspaceRequest(storage, request, slug, isApiRequest ? "api" : "page");
      if (auth instanceof Response) {
        return auth;
      }

      if (suffix === "/" && request.method === "GET") {
        return webShellResponse(storage);
      }

      if (suffix.startsWith("/assets/") && request.method === "GET") {
        return webAssetResponse(storage, `assets/${suffix.slice("/assets/".length)}`);
      }

      if (suffix === "/api/session" && request.method === "GET") {
        return jsonResponse(sessionResponse(auth));
      }

      if (suffix === "/api/project/tree" && request.method === "GET") {
        try {
          return jsonResponse(await projectTreeResponse(auth));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to read project tree.";
          return jsonResponse({ error: message }, { status: 500 });
        }
      }

      if (suffix === "/api/files" && request.method === "GET") {
        try {
          return jsonResponse(await readProjectFile(auth, projectPathFromQuery(url)));
        } catch (error) {
          return apiErrorResponse(error, "Unable to read project file.");
        }
      }

      if (suffix === "/api/files" && request.method === "PUT") {
        try {
          const body = await readJsonRequest(request, (input) => writeFileRequestSchema.parse(input));
          return jsonResponse(await writeProjectFile(auth, projectPathFromQuery(url), body));
        } catch (error) {
          return apiErrorResponse(error, "Unable to write project file.");
        }
      }

      if (suffix === "/api/files" && request.method === "POST") {
        try {
          const body = await readJsonRequest(request, (input) => createFileRequestSchema.parse(input));
          return jsonResponse(await createProjectEntry(auth, body));
        } catch (error) {
          return apiErrorResponse(error, "Unable to create project entry.");
        }
      }

      if (suffix === "/api/files/rename" && request.method === "PATCH") {
        try {
          const body = await readJsonRequest(request, (input) => renameFileRequestSchema.parse(input));
          return jsonResponse(await renameProjectEntry(auth, body));
        } catch (error) {
          return apiErrorResponse(error, "Unable to rename project entry.");
        }
      }

      if (suffix === "/api/files" && request.method === "DELETE") {
        try {
          return jsonResponse(await deleteProjectEntry(auth, projectPathFromQuery(url)));
        } catch (error) {
          return apiErrorResponse(error, "Unable to delete project entry.");
        }
      }

      if (suffix === "/api/heartbeat" && request.method === "POST") {
        try {
          return jsonResponse(await readHeartbeatRequest(request));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid heartbeat request.";
          return jsonResponse({ error: message }, { status: 400 });
        }
      }
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
