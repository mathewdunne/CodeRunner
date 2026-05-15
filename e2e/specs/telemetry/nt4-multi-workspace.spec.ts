/**
 * T35.1 — two workspaces' NT4 traffic remains isolated (decision 013).
 */
import { test } from "@playwright/test";

test("T35.1 NT4 traffic isolated per workspace", async () => {
  test.fixme(true, "Needs richer fake NT4 with topic announce; mock runtime supports per-workspace ports already.");
});
