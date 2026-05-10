import { describe, expect, test } from "bun:test";
import {
  isWorkspaceSlug,
  runClientMessageSchema,
  runServerMessageSchema,
} from "./index";

describe("isWorkspaceSlug", () => {
  test("accepts V1 route-safe slugs", () => {
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
  test("parses the V1 run WebSocket contract", () => {
    expect(runClientMessageSchema.parse({ type: "start" })).toEqual({ type: "start" });
    expect(
      runServerMessageSchema.parse({
        type: "status",
        status: "queued",
        queueDepth: 1,
        queuePosition: 0,
      }),
    ).toEqual({
      type: "status",
      status: "queued",
      queueDepth: 1,
      queuePosition: 0,
    });
  });
});
