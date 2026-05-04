import { describe, expect, test } from "bun:test";
import { isWorkspaceSlug } from "./index";

describe("isWorkspaceSlug", () => {
  test("accepts V1 route-safe slugs", () => {
    expect(isWorkspaceSlug("alice")).toBe(true);
    expect(isWorkspaceSlug("team_6328-2026")).toBe(true);
  });

  test("rejects path-like or empty slugs", () => {
    expect(isWorkspaceSlug("")).toBe(false);
    expect(isWorkspaceSlug("../alice")).toBe(false);
    expect(isWorkspaceSlug("alice/bob")).toBe(false);
  });
});
