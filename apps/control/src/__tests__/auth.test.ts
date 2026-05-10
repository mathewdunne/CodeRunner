import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ControlAppOptions } from "../app";
import type { DockerRunner } from "../containers";
import type { RunCommandFactory } from "../runs";
import {
  cookieFrom,
  createFakeDocker,
  createTemplate,
  createWebDist,
  exists,
  login,
  missing,
  waitFor,
  withApp,
  workspaceBySlug,
  workspaceProjectPath,
} from "./helpers";

describe("session login and ownership", () => {
  test("new login creates a user, workspace, session, and project files", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/u/alice/");

      const userCount = app.storage.db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number };
      const workspaceCount = app.storage.db.query("SELECT COUNT(*) AS count FROM workspaces").get() as {
        count: number;
      };
      const sessionCount = app.storage.db.query("SELECT COUNT(*) AS count FROM sessions").get() as {
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

  test("signed cookie redirects to the existing workspace", async () => {
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

  test("prevents another session from claiming or opening a user's workspace", async () => {
    await withApp(async (app) => {
      const alice = await login(app, "alice");
      const aliceCookie = cookieFrom(alice);

      const bob = await login(app, "bob");
      expect(bob.status).toBe(303);

      const bobAsAlice = await app.fetch(
        new Request("http://localhost/u/bob/", {
          headers: { cookie: aliceCookie },
        }),
      );
      expect(bobAsAlice.status).toBe(403);

      const secondAlice = await login(app, "alice");
      expect(secondAlice.status).toBe(409);
      expect(await secondAlice.text()).toContain("already taken");
    });
  });
});
