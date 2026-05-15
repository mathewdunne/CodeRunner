/**
 * T3.1 / T3.1b — allowlist blocks unauthorized emails.
 *
 * These tests exercise the `isEmailAllowed` gate indirectly by checking that
 * a request with a session for an off-roster user is rejected. Full OAuth
 * callback simulation is captured in `oauth-callback.spec.ts`.
 */
import { test, expect } from "../../fixtures/app";
import { addAllowlistEntry, saveAllowlist, isEmailAllowed } from "../../../apps/control/src/auth/allowlist";

test("T3.1 isEmailAllowed rejects non-roster emails when allowlist is configured", async ({ app }) => {
  void app; // app fixture triggers setAllowlistPath via createApp
  await saveAllowlist({ emails: ["alice@allowed.test"], domains: [] });
  expect(isEmailAllowed("alice@allowed.test")).toBe(true);
  expect(isEmailAllowed("evil@blocked.test")).toBe(false);
});

test("T3.1b removing email from allowlist marks it not-allowed", async ({ app }) => {
  void app;
  await saveAllowlist({ emails: ["alice@allowed.test"], domains: [] });
  expect(isEmailAllowed("alice@allowed.test")).toBe(true);
  await saveAllowlist({ emails: [], domains: [] });
  expect(isEmailAllowed("alice@allowed.test")).toBe(false);
});

test("domain allowlist matches @-suffix and ignores case", async ({ app }) => {
  void app;
  await saveAllowlist({ emails: [], domains: ["allowed.test"] });
  expect(isEmailAllowed("anyone@allowed.test")).toBe(true);
  expect(isEmailAllowed("ANYONE@ALLOWED.TEST")).toBe(true);
  expect(isEmailAllowed("anyone@blocked.test")).toBe(false);
});

test("addAllowlistEntry persists and is reflected by isEmailAllowed", async ({ app }) => {
  void app;
  await saveAllowlist({ emails: [], domains: [] });
  await addAllowlistEntry("email", "newkid@allowed.test");
  expect(isEmailAllowed("newkid@allowed.test")).toBe(true);
});
