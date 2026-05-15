/**
 * T25.1 — valid GitHub URL imports and files appear (happy path).
 * T26 / T27 — size / rate limit (covered at unit level in imports.test.ts).
 * T28.1 — post-import file save (real coverage in Docker tier).
 * T29.1 — restore from backup overwrites project (covered indirectly by the
 *         restoreImportBackup unit/path-traversal tests).
 */
import { test } from "@playwright/test";

test("T25.1 valid GitHub URL imports and files appear", async () => {
  test.fixme(
    true,
    "Needs network-mocking of git clone (or a runtimeExec mock that returns canned " +
      "outputs). Unit-level imports.test.ts already exercises the orchestrator.",
  );
});
