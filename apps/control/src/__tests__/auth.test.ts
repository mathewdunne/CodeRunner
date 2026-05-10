import { describe, expect, test } from "bun:test";
import {
  cookieFrom,
  exists,
  login,
  withApp,
  workspaceBySlug,
} from "./helpers";
import { join } from "node:path";

describe("session login and ownership", () => {
  test("new login creates a user, workspace, session, and project files", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/u/alice/");

      const userCount = app.storage.db.query("SELECT COUNT(*) AS count FROM user").get() as { count: number };
      const workspaceCount = app.storage.db.query("SELECT COUNT(*) AS count FROM workspaces").get() as {
        count: number;
      };
      const sessionCount = app.storage.db.query("SELECT COUNT(*) AS count FROM session").get() as {
        count: number;
      };
      const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get("alice") as {
        project_path: string;
      };

      expect(userCount.count).toBe(1);
      expect(workspaceCount.count).toBe(1);
      expect(sessionCount.count).toBe(1);
      expect(await exists(join(workspace.project_path, "src", "main", "java", "frc", "robot", "Robot.java"))).toBe(
        true,
      );
      expect(await exists(join(workspace.project_path, ".wpilib", "wpilib_preferences.json"))).toBe(true);
    });
  });

  test("session cookie redirects to the existing workspace", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const reload = await app.fetch(
        new Request("http://localhost/", {
          headers: { cookie },
        }),
      );
      expect(reload.status).toBe(303);
      expect(reload.headers.get("location")).toBe("/u/alice/");

      const workspace = await app.fetch(
        new Request("http://localhost/u/alice/", {
          headers: { cookie },
        }),
      );
      expect(workspace.status).toBe(200);
      expect(await workspace.text()).toContain("V2 test shell");
    });
  });

  test("rejects bad workspace slugs before serving a workspace page", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const badSlug = await app.fetch(
        new Request("http://localhost/u/alice.bob/", {
          headers: { cookie },
        }),
      );

      expect(badSlug.status).toBe(400);
    });
  });

  test("prevents another session from accessing a different user's workspace", async () => {
    await withApp(async (app) => {
      const alice = await login(app, "alice");
      const aliceCookie = cookieFrom(alice);

      await login(app, "bob");

      // Alice's cookie should not let her access Bob's workspace
      const bobAsAlice = await app.fetch(
        new Request("http://localhost/u/bob/", {
          headers: { cookie: aliceCookie },
        }),
      );
      expect(bobAsAlice.status).toBe(403);
    });
  });

  test("returning user gets a fresh session with same workspace", async () => {
    await withApp(async (app) => {
      const first = await login(app, "alice");
      expect(first.status).toBe(303);
      expect(first.headers.get("location")).toBe("/u/alice/");

      // Second login with same display name → same user + new session
      const second = await login(app, "alice");
      expect(second.status).toBe(303);
      expect(second.headers.get("location")).toBe("/u/alice/");

      // Should have 1 user, 2 sessions, 1 workspace
      const userCount = app.storage.db.query("SELECT COUNT(*) AS count FROM user").get() as { count: number };
      const sessionCount = app.storage.db.query("SELECT COUNT(*) AS count FROM session").get() as {
        count: number;
      };
      const workspaceCount = app.storage.db.query("SELECT COUNT(*) AS count FROM workspaces").get() as {
        count: number;
      };
      expect(userCount.count).toBe(1);
      expect(sessionCount.count).toBe(2);
      expect(workspaceCount.count).toBe(1);
    });
  });
});
