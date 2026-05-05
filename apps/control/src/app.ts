import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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

function isReservedProjectTempName(name: string): boolean {
  return /^\.frc-sim-write-[a-f0-9]+\.tmp$/u.test(name);
}

async function readProjectTreeNode(projectRoot: string, relativePath: string): Promise<ProjectTreeNode | null> {
  const absolutePath = relativePath ? resolve(projectRoot, ...relativePath.split("/")) : projectRoot;
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const children: ProjectTreeNode[] = [];

  for (const entry of entries) {
    if (isReservedProjectTempName(entry.name)) {
      continue;
    }

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
  stats: Stats | null;
};

type ResolveProjectPathOptions = {
  mode: "read" | "write";
  existingTarget: "required" | "optional";
  missingTargetMessage?: string;
  parentMissingMessage?: string;
  parentMissingStatus?: number;
};

function apiError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function fsErrorCode(error: unknown): unknown {
  return error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return fsErrorCode(error) === "ENOENT";
}

function isNonEmptyDirectoryError(error: unknown): boolean {
  const code = fsErrorCode(error);
  return code === "ENOTEMPTY" || code === "EEXIST";
}

function symlinkError(): Error & { status: number } {
  return apiError("Project path cannot include symlinks.", 403);
}

async function lstatRequired(path: string, message: string, status: number): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw apiError(message, status);
    }
    throw error;
  }
}

async function assertRealPathInside(rootRealPath: string, targetPath: string): Promise<string> {
  const targetRealPath = await realpath(targetPath);
  if (!isInsideDirectory(rootRealPath, targetRealPath)) {
    throw apiError("Project path resolved outside the workspace.", 403);
  }
  return targetRealPath;
}

async function resolveProjectFilePath(
  auth: AuthContext,
  pathInput: string,
  options: ResolveProjectPathOptions,
): Promise<ResolvedProjectPath> {
  const parsed = projectPathSchema.safeParse(pathInput);
  if (!parsed.success) {
    throw apiError("Invalid project path.", 400);
  }

  const projectPath = parsed.data;
  const access = getProjectPathAccess(projectPath);
  if (access === "blocked" || access === "outside-allowlist") {
    throw apiError("Project path is not available.", 403);
  }

  if (options.mode === "write" && access !== "editable") {
    throw apiError("Project path is read-only.", 403);
  }

  const rootRealPath = await realpath(auth.workspace.project_path);
  const segments = projectPath.split("/");
  const parentSegments = segments.slice(0, -1);
  let parentPath = rootRealPath;

  for (const segment of parentSegments) {
    parentPath = resolve(parentPath, segment);
    if (!isInsideDirectory(rootRealPath, parentPath)) {
      throw apiError("Project path resolved outside the workspace.", 403);
    }

    const segmentStats = await lstatRequired(
      parentPath,
      options.parentMissingMessage ?? "Parent directory does not exist.",
      options.parentMissingStatus ?? 409,
    );
    if (segmentStats.isSymbolicLink()) {
      throw symlinkError();
    }
    if (!segmentStats.isDirectory()) {
      throw apiError(
        options.parentMissingMessage ?? "Parent directory does not exist.",
        options.parentMissingStatus ?? 409,
      );
    }

    parentPath = await assertRealPathInside(rootRealPath, parentPath);
  }

  const absolutePath = resolve(parentPath, segments.at(-1) ?? "");
  if (!isInsideDirectory(rootRealPath, absolutePath)) {
    throw apiError("Project path resolved outside the workspace.", 403);
  }

  let stats: Stats | null = null;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (options.existingTarget === "required" && isMissingPathError(error)) {
      throw apiError(options.missingTargetMessage ?? "Project path was not found.", 404);
    }
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  if (stats?.isSymbolicLink()) {
    throw symlinkError();
  }

  if (stats) {
    await assertRealPathInside(rootRealPath, absolutePath);
  }

  return { path: projectPath, absolutePath, access, stats };
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

function writeTempPathFor(absolutePath: string): string {
  return resolve(dirname(absolutePath), `.frc-sim-write-${randomBytes(12).toString("hex")}.tmp`);
}

async function writeFileAtomically(absolutePath: string, contents: string): Promise<void> {
  const tempPath = writeTempPathFor(absolutePath);
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, absolutePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {
      // Best effort cleanup; the project tree hides any crash leftovers with this prefix.
    });
    throw error;
  }
}

async function readProjectFile(auth: AuthContext, pathInput: string): Promise<ProjectFileResponse> {
  const resolvedPath = await resolveProjectFilePath(auth, pathInput, {
    mode: "read",
    existingTarget: "required",
    missingTargetMessage: "Project file was not found.",
    parentMissingMessage: "Project file was not found.",
    parentMissingStatus: 404,
  });
  if (!resolvedPath.stats?.isFile()) {
    throw apiError("Project path is not a file.", 400);
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
  const resolvedPath = await resolveProjectFilePath(auth, pathInput, {
    mode: "write",
    existingTarget: "optional",
  });
  if (resolvedPath.stats && !resolvedPath.stats.isFile()) {
    throw apiError("Project path is not a file.", 400);
  }

  await writeFileAtomically(resolvedPath.absolutePath, requestBody.contents);
  return mutationResponse(auth);
}

async function createProjectEntry(auth: AuthContext, requestBody: CreateFileRequest): Promise<FileMutationResponse> {
  const resolvedPath = await resolveProjectFilePath(auth, requestBody.path, {
    mode: "write",
    existingTarget: "optional",
  });
  if (resolvedPath.stats) {
    throw apiError("Project path already exists.", 409);
  }

  if (requestBody.kind === "directory") {
    try {
      await mkdir(resolvedPath.absolutePath);
    } catch (error) {
      if (fsErrorCode(error) === "EEXIST") {
        throw apiError("Project path already exists.", 409);
      }
      throw error;
    }
  } else {
    try {
      await writeFile(resolvedPath.absolutePath, requestBody.contents ?? "", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (fsErrorCode(error) === "EEXIST") {
        throw apiError("Project path already exists.", 409);
      }
      throw error;
    }
  }

  return mutationResponse(auth);
}

async function renameProjectEntry(auth: AuthContext, requestBody: RenameFileRequest): Promise<FileMutationResponse> {
  const from = await resolveProjectFilePath(auth, requestBody.from, {
    mode: "write",
    existingTarget: "required",
    missingTargetMessage: "Source path was not found.",
    parentMissingMessage: "Source path was not found.",
    parentMissingStatus: 404,
  });
  const to = await resolveProjectFilePath(auth, requestBody.to, {
    mode: "write",
    existingTarget: "optional",
    parentMissingMessage: "Destination parent directory does not exist.",
  });

  if (to.stats) {
    throw apiError("Destination path already exists.", 409);
  }

  await rename(from.absolutePath, to.absolutePath);
  return mutationResponse(auth);
}

async function deleteProjectEntry(auth: AuthContext, pathInput: string): Promise<FileMutationResponse> {
  const resolvedPath = await resolveProjectFilePath(auth, pathInput, {
    mode: "write",
    existingTarget: "required",
    missingTargetMessage: "Project path was not found.",
    parentMissingMessage: "Project path was not found.",
    parentMissingStatus: 404,
  });
  const fileStat = resolvedPath.stats;

  try {
    if (fileStat?.isDirectory()) {
      await rmdir(resolvedPath.absolutePath);
    } else if (fileStat?.isFile()) {
      await unlink(resolvedPath.absolutePath);
    } else {
      throw apiError("Project path is not a file or directory.", 400);
    }
  } catch (error) {
    if (isNonEmptyDirectoryError(error)) {
      throw apiError("Directory is not empty.", 409);
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
