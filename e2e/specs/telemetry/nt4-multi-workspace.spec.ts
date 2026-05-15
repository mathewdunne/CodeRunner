/**
 * Two workspaces' NT4 traffic remains isolated (decision 013).
 */
import { test } from "@playwright/test";

test("NT4 traffic isolated per workspace", async () => {
  test.fixme(true, "Needs richer fake NT4 with topic announce; mock runtime supports per-workspace ports already.");
});
