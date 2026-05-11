import { describe, expect, test } from "bun:test";
import {
  driverStationPatchSchema,
  isWorkspaceSlug,
  runClientMessageSchema,
  runServerMessageSchema,
  simRunCommandRequestSchema,
  simStatusResponseSchema,
} from "./index";

describe("isWorkspaceSlug", () => {
  test("accepts route-safe workspace slugs", () => {
    expect(isWorkspaceSlug("alice")).toBe(true);
    expect(isWorkspaceSlug("team_6328-2026")).toBe(true);
  });

  test("rejects path-like or empty slugs", () => {
    expect(isWorkspaceSlug("")).toBe(false);
    expect(isWorkspaceSlug("../alice")).toBe(false);
    expect(isWorkspaceSlug("alice/bob")).toBe(false);
    expect(isWorkspaceSlug("alice.bob")).toBe(false);
    expect(isWorkspaceSlug("a".repeat(41))).toBe(false);
  });
});

describe("run message schemas", () => {
  test("parses the run WebSocket contract", () => {
    expect(runClientMessageSchema.parse({ type: "start" })).toEqual({ type: "start" });
    expect(
      runServerMessageSchema.parse({
        type: "status",
        status: "building",
      }),
    ).toEqual({
      type: "status",
      status: "building",
    });
  });
});

describe("simulation API schemas", () => {
  test("parses sim command and Driver Station patch payloads", () => {
    expect(simRunCommandRequestSchema.parse({ action: "restart" })).toEqual({ action: "restart" });
    expect(driverStationPatchSchema.parse({ enabled: false, mode: "teleop" })).toEqual({
      enabled: false,
      mode: "teleop",
    });
    expect(driverStationPatchSchema.safeParse({}).success).toBe(false);
    expect(simRunCommandRequestSchema.safeParse({ action: "toggle" }).success).toBe(false);
  });

  test("parses a full sim status snapshot", () => {
    expect(
      simStatusResponseSchema.parse({
        ok: true,
        workspace: { id: "ws_0123456789abcdef0123456789abcdef", slug: "alice" },
        container: { state: "running" },
        run: { status: "running", runId: "run_abc" },
        halsim: {
          connection: "connected",
          connected: true,
          stale: false,
          lastMessageAt: new Date(0).toISOString(),
          error: null,
        },
        driverStation: {
          enabled: false,
          mode: "teleop",
          eStopped: false,
          alliance: "red1",
        },
        comms: { canEnable: true },
        joysticks: { status: "unknown" },
      }),
    ).toMatchObject({
      run: { status: "running" },
      driverStation: { mode: "teleop" },
    });
  });
});
