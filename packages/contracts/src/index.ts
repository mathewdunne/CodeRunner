import { z } from "zod";

export const ROUTE_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;
export const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{32}$/;
// Better Auth's default user/session IDs are URL-safe alphanumeric strings;
// keep the bound loose enough to absorb a future generator change.
export const BETTERAUTH_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const workspaceSlugSchema = z.string().regex(ROUTE_SLUG_PATTERN);
export const userIdSchema = z.string().regex(BETTERAUTH_ID_PATTERN);
export const workspaceIdSchema = z.string().regex(WORKSPACE_ID_PATTERN);

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

export type WorkspaceRoute = z.infer<typeof workspaceRouteSchema>;
export type UserId = z.infer<typeof userIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type WorkspaceSlug = z.infer<typeof workspaceSlugSchema>;

export const heartbeatRequestSchema = z.object({
  closing: z.boolean().optional(),
});

export const sessionResponseSchema = z.object({
  user: z.object({
    id: userIdSchema,
    displayName: z.string(),
    email: z.string(),
    slug: workspaceSlugSchema,
    role: z.enum(["student", "admin"]),
  }),
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
});

export const heartbeatResponseSchema = z.object({
  ok: z.literal(true),
  closing: z.boolean(),
});

export const containerStateSchema = z.enum(["missing", "starting", "running", "stopped", "error"]);

export const containersStatusResponseSchema = z.object({
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
  code: z.object({
    role: z.literal("code"),
    state: containerStateSchema,
    image: z.string().min(1),
    containerName: z.string().min(1).nullable(),
    simPortAllocated: z.boolean(),
    vscodePortAllocated: z.boolean(),
    halsimPortAllocated: z.boolean(),
    lastUsedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const runClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("stop") }),
]);

export const runServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    runId: z.string().min(1),
  }),
  z.object({
    type: z.literal("status"),
    status: z.enum(["stopping", "building", "running", "failed", "stopped"]),
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

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type ContainerRole = "sim" | "code" | "halsim";
export type ContainerState = z.infer<typeof containerStateSchema>;
export type ContainersStatusResponse = z.infer<typeof containersStatusResponseSchema>;
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
    email: z.string(),
    role: z.enum(["student", "admin"]),
    slug: workspaceSlugSchema,
    lastSeenAt: z.string(),
  }),
  code: z.object({
    state: containerStateSchema,
    containerName: z.string().nullable(),
    simPort: z.number().int().nullable(),
    vscodePort: z.number().int().nullable(),
    halsimPort: z.number().int().nullable(),
  }),
  idle: z.boolean(),
  lastActivity: z.string(),
});

export const adminStatusResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(adminWorkspaceStatusSchema),
  idleStopMinutes: z.number().int().min(1),
  activeBuilds: z.number().int().min(0),
  maxActiveContainers: z.number().int().min(1).optional(),
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

// --- Import schemas ---

export const importRequestSchema = z.object({
  url: z.string().min(1, "URL is required."),
  branch: z.string().optional(),
  subdir: z.string().optional(),
  backup: z.boolean().optional(),
});

export const importResponseSchema = z.object({
  ok: z.literal(true),
  importId: z.string().min(1),
});

export const importServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    importId: z.string().min(1),
  }),
  z.object({
    type: z.literal("progress"),
    stage: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("log"),
    line: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    success: z.boolean(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export const importBackupMetadataSchema = z.object({
  url: z.string(),
  branch: z.string(),
  subdir: z.string(),
  importedAt: z.string(),
  archiveFile: z.string(),
});

export type ImportRequest = z.infer<typeof importRequestSchema>;
export type ImportResponse = z.infer<typeof importResponseSchema>;
export type ImportServerMessage = z.infer<typeof importServerMessageSchema>;
export type ImportBackupMetadata = z.infer<typeof importBackupMetadataSchema>;
