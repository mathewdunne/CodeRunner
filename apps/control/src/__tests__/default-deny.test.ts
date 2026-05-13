/**
 * Default-deny coverage test — Plan §A.7.6.
 *
 * The router in app.ts doesn't expose a single route table, so instead of
 * enumerating it programmatically we maintain an explicit list of paths
 * here. Any new public route MUST add itself to PUBLIC_PATHS; any new gated
 * route SHOULD add an entry to GATED_PATHS so a missing auth check is
 * caught by CI.
 */
import { describe, expect, test } from "bun:test";
import { withApp } from "./helpers";

const PUBLIC_PATHS: Array<{ path: string; method?: "GET" | "POST" }> = [
  { path: "/" },
  { path: "/login" },
  { path: "/healthz" },
  { path: "/api/openapi.json" },
  { path: "/api/auth/providers" },
  { path: "/coderunner-icon.png" },
  { path: "/favicon.ico" },
  { path: "/assets/app.js" },
  { path: "/scope/" },
  { path: "/scope/index.html" },
];

const GATED_PATHS: Array<{
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** "deny" = expect a 401/403/redirect. */
  expect: "deny";
}> = [
  { path: "/admin", expect: "deny" },
  { path: "/admin/", expect: "deny" },
  { path: "/admin/status", expect: "deny" },
  { path: "/admin/users", expect: "deny" },
  { path: "/admin/allowlist", expect: "deny" },
  { path: "/admin/containers/stats", expect: "deny" },
  { path: "/admin/workspaces/disk-usage", expect: "deny" },
  { path: "/admin/users/anyuser/promote", method: "POST", expect: "deny" },
  { path: "/admin/users/anyuser/demote", method: "POST", expect: "deny" },
  { path: "/admin/users/anyuser", method: "DELETE", expect: "deny" },
  { path: "/admin/allowlist/reload", method: "POST", expect: "deny" },
  { path: "/u/alice/", expect: "deny" },
  { path: "/u/alice/api/session", expect: "deny" },
  { path: "/u/alice/api/sim/status", expect: "deny" },
  { path: "/u/alice/api/sim/run", method: "POST", expect: "deny" },
  { path: "/u/alice/api/sim/driver-station", method: "PATCH", expect: "deny" },
  { path: "/scope/uploadAsset", method: "POST", expect: "deny" },
];

function isDenied(status: number, location: string | null): boolean {
  if (status === 401 || status === 403) return true;
  if ((status === 302 || status === 303 || status === 307 || status === 308) && location?.includes("/login")) {
    return true;
  }
  return false;
}

describe("default-deny route coverage", () => {
  test("declared public paths do not return 401", async () => {
    await withApp(async (app) => {
      for (const entry of PUBLIC_PATHS) {
        const res = await app.fetch(
          new Request(`http://localhost${entry.path}`, { method: entry.method ?? "GET" }),
        );
        expect({ path: entry.path, status: res.status }).toEqual({ path: entry.path, status: res.status });
        expect(res.status, `Public path ${entry.path} unexpectedly returned 401`).not.toBe(401);
      }
    });
  });

  test("declared gated paths reject unauthenticated requests", async () => {
    await withApp(async (app) => {
      for (const entry of GATED_PATHS) {
        const res = await app.fetch(
          new Request(`http://localhost${entry.path}`, { method: entry.method ?? "GET" }),
        );
        const denied = isDenied(res.status, res.headers.get("location"));
        expect(
          { path: entry.path, status: res.status, location: res.headers.get("location"), denied },
          `Gated path ${entry.path} returned ${res.status} (expected 401/403/login-redirect)`,
        ).toMatchObject({ denied: true });
      }
    });
  });
});
