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

export const authProviderSchema = z.enum(["github", "google"]);

export const authProvidersResponseSchema = z.object({
  providers: z.array(authProviderSchema),
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

export const simRunStatusSchema = z.enum(["idle", "building", "running", "stopping", "failed", "stopped", "error"]);
export const simRunCommandSchema = z.enum(["start", "stop", "restart"]);
export const dsModeSchema = z.enum(["auto", "teleop", "test"]);
export const allianceStationSchema = z.enum(["red1", "red2", "red3", "blue1", "blue2", "blue3"]);
export const bridgeConnectionSchema = z.enum(["connected", "reconnecting", "disconnected"]);

export const simRunCommandRequestSchema = z.object({
  action: simRunCommandSchema,
});

export const driverStationPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: dsModeSchema.optional(),
    eStopped: z.boolean().optional(),
    alliance: allianceStationSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one Driver Station field is required.",
  });

export const autoChooserSchema = z.object({
  key: z.string().min(1),
  displayKey: z.string().min(1),
  options: z.array(z.string()),
  default: z.string().nullable(),
  active: z.string().nullable(),
  selected: z.string().nullable(),
});

export const autoChoosersResponseSchema = z.object({
  ok: z.literal(true),
  nt4: z.object({
    connection: bridgeConnectionSchema,
    connected: z.boolean(),
    stale: z.boolean(),
    lastMessageAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
  choosers: z.array(autoChooserSchema),
});

export const autoChooserPatchSchema = z.object({
  key: z.string().min(1),
  selected: z.string().min(1),
});

export const simStatusResponseSchema = z.object({
  ok: z.literal(true),
  workspace: z.object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
  }),
  container: z.object({
    state: containerStateSchema,
  }),
  run: z.object({
    status: simRunStatusSchema,
    runId: z.string().min(1).nullable(),
  }),
  halsim: z.object({
    connection: bridgeConnectionSchema,
    connected: z.boolean(),
    stale: z.boolean(),
    lastMessageAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
  driverStation: z.object({
    enabled: z.boolean(),
    mode: dsModeSchema,
    eStopped: z.boolean(),
    alliance: allianceStationSchema,
  }),
  comms: z.object({
    canEnable: z.boolean(),
  }),
  joysticks: z.object({
    status: z.enum(["unknown", "connected", "disconnected"]),
  }),
});

export const simRunCommandResponseSchema = z.object({
  ok: z.literal(true),
  action: simRunCommandSchema,
  runId: z.string().min(1).nullable(),
  status: simRunStatusSchema,
});

export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type AuthProvider = z.infer<typeof authProviderSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type ContainerRole = "sim" | "code" | "halsim";
export type ContainerState = z.infer<typeof containerStateSchema>;
export type ContainersStatusResponse = z.infer<typeof containersStatusResponseSchema>;
export type RunClientMessage = z.infer<typeof runClientMessageSchema>;
export type RunServerMessage = z.infer<typeof runServerMessageSchema>;
export type SimRunStatus = z.infer<typeof simRunStatusSchema>;
export type SimRunCommand = z.infer<typeof simRunCommandSchema>;
export type DsMode = z.infer<typeof dsModeSchema>;
export type AllianceStation = z.infer<typeof allianceStationSchema>;
export type BridgeConnection = z.infer<typeof bridgeConnectionSchema>;
export type SimRunCommandRequest = z.infer<typeof simRunCommandRequestSchema>;
export type DriverStationPatch = z.infer<typeof driverStationPatchSchema>;
export type AutoChooser = z.infer<typeof autoChooserSchema>;
export type AutoChoosersResponse = z.infer<typeof autoChoosersResponseSchema>;
export type AutoChooserPatch = z.infer<typeof autoChooserPatchSchema>;
export type SimStatusResponse = z.infer<typeof simStatusResponseSchema>;
export type SimRunCommandResponse = z.infer<typeof simRunCommandResponseSchema>;

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
