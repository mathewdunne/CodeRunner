import type {
  AdminStatusResponse,
  AdminWorkspaceStatus,
  AutoChoosersResponse,
  ContainersStatusResponse,
  SimRunStatus,
  SimStatusResponse,
} from "@frc-sim/contracts";
import { CapacityExceededError } from "../containers";
import type { GamepadSessions } from "../gamepad";
import type { HalSimBridge } from "../halsim";
import type { Nt4AutoChooserBridge } from "../nt4-auto";
import type { RunManager } from "../runs";
import type { WorkspaceRuntimeProvider } from "../runtime";
import type { AppStorage, AuthContext } from "../storage";
import type { AuditActor } from "../audit";
import { codeStatusFromRuntime, jsonResponse } from "./responses";

export async function containersStatusResponse(
  runtimeProvider: WorkspaceRuntimeProvider,
  auth: AuthContext,
): Promise<Response> {
  try {
    const runtime = await runtimeProvider.ensureWorkspaceRunning(auth.workspace.id);
    const status: ContainersStatusResponse = {
      workspace: {
        id: auth.workspace.id,
        slug: auth.workspace.slug,
      },
      code: codeStatusFromRuntime(runtime),
    };
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

export function runIsActive(status: SimRunStatus): boolean {
  return status === "building" || status === "running" || status === "stopping";
}

export async function simStatusSnapshot(
  storage: AppStorage,
  runtimeProvider: WorkspaceRuntimeProvider,
  runs: RunManager,
  halsim: HalSimBridge,
  gamepad: GamepadSessions,
  auth: AuthContext,
): Promise<SimStatusResponse> {
  void storage;
  const runtime = await runtimeProvider.ensureWorkspaceRunning(auth.workspace.id);
  const run = runs.getWorkspaceSnapshot(auth.workspace.id);
  const shouldBridgeRun =
    runIsActive(run.status) &&
    runtime.state === "running" &&
    runtime.endpoints.halsim !== null;
  const bridge =
    shouldBridgeRun && runtime.endpoints.halsim !== null
      ? halsim.ensureConnected(auth.workspace.id, runtime.endpoints.halsim.wsUrl)
      : halsim.getSnapshot(auth.workspace.id);
  if (!shouldBridgeRun && !runIsActive(run.status)) {
    halsim.disconnect(auth.workspace.id);
  }

  const canEnable =
    runtime.state === "running" &&
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
      state: runtime.state,
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
    joysticks: gamepad.getStatus(auth.workspace.id),
  };
}

export async function autoChoosersSnapshot(
  storage: AppStorage,
  runtimeProvider: WorkspaceRuntimeProvider,
  runs: RunManager,
  nt4Auto: Nt4AutoChooserBridge,
  auth: AuthContext,
): Promise<AutoChoosersResponse> {
  void storage;
  const runtime = await runtimeProvider.ensureWorkspaceRunning(auth.workspace.id);
  const run = runs.getWorkspaceSnapshot(auth.workspace.id);
  const shouldBridgeRun =
    runIsActive(run.status) &&
    runtime.state === "running" &&
    runtime.endpoints.nt4 !== null;
  if (shouldBridgeRun && runtime.endpoints.nt4 !== null) {
    return nt4Auto.ensureConnected(auth.workspace.id, runtime.endpoints.nt4.wsUrl);
  }
  if (!runIsActive(run.status)) {
    nt4Auto.disconnect(auth.workspace.id);
  }
  return nt4Auto.getSnapshot(auth.workspace.id);
}

export async function simStatusResponse(
  storage: AppStorage,
  runtimeProvider: WorkspaceRuntimeProvider,
  runs: RunManager,
  halsim: HalSimBridge,
  gamepad: GamepadSessions,
  auth: AuthContext,
): Promise<Response> {
  try {
    return jsonResponse(await simStatusSnapshot(storage, runtimeProvider, runs, halsim, gamepad, auth));
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

export function openApiResponse(): Response {
  return jsonResponse({
    openapi: "3.1.0",
    info: {
      title: "CodeRunner Control API",
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

export function adminStatusResponse(storage: AppStorage, runs: RunManager): AdminStatusResponse {
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

export function auditActor(adminResult: { user: { id: string; email: string } }): AuditActor {
  return { userId: adminResult.user.id, email: adminResult.user.email };
}
