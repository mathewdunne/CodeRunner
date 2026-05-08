import { z } from "zod";

export const V1_ROUTE_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
export const V1_USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
export const V1_WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{32}$/;
export const V1_SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;

export const workspaceSlugSchema = z.string().regex(V1_ROUTE_SLUG_PATTERN);
export const userIdSchema = z.string().regex(V1_USER_ID_PATTERN);
export const workspaceIdSchema = z.string().regex(V1_WORKSPACE_ID_PATTERN);
export const sessionIdSchema = z.string().regex(V1_SESSION_ID_PATTERN);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required.")
  .max(80, "Display name must be 80 characters or fewer.");

export const workspaceRouteSchema = z.object({
  workspaceSlug: workspaceSlugSchema,
});

export function isWorkspaceSlug(value: string): boolean {
  return workspaceSlugSchema.safeParse(value).success;
}

export type V1WorkspaceRoute = z.infer<typeof workspaceRouteSchema>;
export type UserId = z.infer<typeof userIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type WorkspaceSlug = z.infer<typeof workspaceSlugSchema>;

export type ProjectPath = string & { readonly __projectPath: unique symbol };

function projectPathIssue(value: string): string | null {
  if (value.length === 0) {
    return "Project path must not be empty.";
  }

  if (value.length > 512) {
    return "Project path is too long.";
  }

  if (value.startsWith("/") || value.startsWith("\\")) {
    return "Project path must be relative.";
  }

  if (/^[a-zA-Z]:/.test(value)) {
    return "Project path must not include a drive letter.";
  }

  if (value.includes("\\")) {
    return "Project path must use POSIX separators.";
  }

  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return "Project path must not include control characters.";
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "Project path must not include empty segments.";
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "Project path must not include dot segments.";
  }

  return null;
}

export const projectPathSchema = z
  .string()
  .superRefine((value, context) => {
    const issue = projectPathIssue(value);
    if (issue) {
      context.addIssue({ code: "custom", message: issue });
    }
  })
  .transform((value) => value as ProjectPath);

export function parseProjectPath(value: string): ProjectPath {
  return projectPathSchema.parse(value);
}

export function isProjectPath(value: string): boolean {
  return projectPathSchema.safeParse(value).success;
}

export type ProjectPathAccess = "editable" | "readonly" | "blocked" | "outside-allowlist";

function matchesPathOrChild(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function getProjectPathAccess(path: string): ProjectPathAccess {
  const parsed = projectPathSchema.safeParse(path);
  if (!parsed.success) {
    return "blocked";
  }

  const safePath = parsed.data;
  if (
    matchesPathOrChild(safePath, ".gradle") ||
    matchesPathOrChild(safePath, "build") ||
    matchesPathOrChild(safePath, "gradle/wrapper") ||
    matchesPathOrChild(safePath, "logs")
  ) {
    return "blocked";
  }

  if (
    matchesPathOrChild(safePath, "src/main/java") ||
    matchesPathOrChild(safePath, "src/test/java") ||
    matchesPathOrChild(safePath, "src/main/deploy")
  ) {
    return "editable";
  }

  if (
    safePath === "build.gradle" ||
    safePath === "settings.gradle" ||
    safePath === "gradle.properties" ||
    matchesPathOrChild(safePath, ".wpilib")
  ) {
    return "readonly";
  }

  return "outside-allowlist";
}

export const writeFileRequestSchema = z.object({
  contents: z.string(),
});

export const createFileRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: projectPathSchema,
    contents: z.string().optional(),
  }),
  z.object({
    kind: z.literal("directory"),
    path: projectPathSchema,
  }),
]);

export const renameFileRequestSchema = z.object({
  from: projectPathSchema,
  to: projectPathSchema,
});

export const heartbeatRequestSchema = z.object({
  closing: z.boolean().optional(),
});

export type ProjectTreeNode = {
  name: string;
  path: string;
  kind: "file" | "directory";
  access: ProjectPathAccess | "root";
  children?: ProjectTreeNode[] | undefined;
};

export const projectTreeNodeSchema: z.ZodType<ProjectTreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(["file", "directory"]),
    access: z.enum(["editable", "readonly", "blocked", "outside-allowlist", "root"]),
    children: z.array(projectTreeNodeSchema).optional(),
  }),
);

export const sessionResponseSchema = z.object({
  user: z.object({
    id: userIdSchema,
    displayName: z.string(),
    slug: workspaceSlugSchema,
  }),
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
});

export const projectTreeResponseSchema = z.object({
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
  tree: projectTreeNodeSchema,
});

export const heartbeatResponseSchema = z.object({
  ok: z.literal(true),
  closing: z.boolean(),
});

export const containerStateSchema = z.enum(["missing", "starting", "running", "stopped", "error"]);
export const simContainerStateSchema = containerStateSchema;

export const containersStatusResponseSchema = z.object({
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
  sim: z.object({
    role: z.literal("sim"),
    state: containerStateSchema,
    image: z.string().min(1),
    containerName: z.string().min(1).nullable(),
    portAllocated: z.boolean(),
    lastUsedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
  lsp: z.object({
    role: z.literal("lsp"),
    state: containerStateSchema,
    image: z.string().min(1),
    containerName: z.string().min(1).nullable(),
    portAllocated: z.boolean(),
    lastUsedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const projectFileResponseSchema = z.object({
  path: projectPathSchema,
  contents: z.string(),
  access: z.enum(["editable", "readonly"]),
});

export const fileMutationResponseSchema = z.object({
  ok: z.literal(true),
  tree: projectTreeResponseSchema,
});

export const runClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("stop") }),
]);

export const runServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    runId: z.string().min(1),
    queueDepth: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("status"),
    status: z.enum(["queued", "stopping", "building", "running", "failed", "stopped"]),
    queueDepth: z.number().int().min(0).optional(),
    queuePosition: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("queue"),
    queueDepth: z.number().int().min(0),
    queuePosition: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("log"),
    stream: z.enum(["stdout", "stderr", "sim"]),
    line: z.string(),
  }),
  z.object({
    type: z.literal("exit"),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;
export type CreateFileRequest = z.infer<typeof createFileRequestSchema>;
export type RenameFileRequest = z.infer<typeof renameFileRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type ProjectTreeResponse = z.infer<typeof projectTreeResponseSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type ContainerRole = "sim" | "lsp";
export type ContainerState = z.infer<typeof containerStateSchema>;
export type SimContainerState = ContainerState;
export type ContainersStatusResponse = z.infer<typeof containersStatusResponseSchema>;
export type ProjectFileResponse = z.infer<typeof projectFileResponseSchema>;
export type FileMutationResponse = z.infer<typeof fileMutationResponseSchema>;
export type RunClientMessage = z.infer<typeof runClientMessageSchema>;
export type RunServerMessage = z.infer<typeof runServerMessageSchema>;

// --- Admin / operator schemas ---

export const adminWorkspaceStatusSchema = z.object({
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
    lastAccessedAt: z.string(),
  }),
  user: z.object({
    displayName: z.string(),
    slug: workspaceSlugSchema,
    lastSeenAt: z.string(),
  }),
  sim: z.object({
    state: containerStateSchema,
    containerName: z.string().nullable(),
    port: z.number().int().nullable(),
  }),
  lsp: z.object({
    state: containerStateSchema,
    containerName: z.string().nullable(),
    port: z.number().int().nullable(),
  }),
  idle: z.boolean(),
  lastActivity: z.string(),
});

export const adminStatusResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(adminWorkspaceStatusSchema),
  idleStopMinutes: z.number().int().min(1),
  runConcurrency: z.number().int().min(1),
  activeBuilds: z.number().int().min(0),
  queueDepth: z.number().int().min(0),
});

export const adminActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.string(),
  workspaceId: workspaceIdSchema,
  detail: z.string().optional(),
});

export type AdminWorkspaceStatus = z.infer<typeof adminWorkspaceStatusSchema>;
export type AdminStatusResponse = z.infer<typeof adminStatusResponseSchema>;
export type AdminActionResponse = z.infer<typeof adminActionResponseSchema>;
