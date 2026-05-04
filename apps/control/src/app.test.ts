import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type ControlApp } from "./app";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createTemplate(root: string): Promise<string> {
  const templateDir = join(root, "template");
  await mkdir(join(templateDir, "src", "main", "java", "frc", "robot"), { recursive: true });
  await mkdir(join(templateDir, ".wpilib"), { recursive: true });
  await mkdir(join(templateDir, "gradle", "wrapper"), { recursive: true });
  await writeFile(join(templateDir, "build.gradle"), "plugins {}\n", "utf8");
  await writeFile(join(templateDir, "src", "main", "java", "frc", "robot", "Robot.java"), "package frc.robot;\n", "utf8");
  await writeFile(join(templateDir, ".wpilib", "wpilib_preferences.json"), "{}\n", "utf8");
  await writeFile(join(templateDir, "gradle", "wrapper", "gradle-wrapper.jar"), "hidden\n", "utf8");
  return templateDir;
}

async function createWebDist(root: string): Promise<string> {
  const webDistDir = join(root, "web-dist");
  await mkdir(join(webDistDir, "assets"), { recursive: true });
  await writeFile(
    join(webDistDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body>V1 test shell</body></html>',
    "utf8",
  );
  await writeFile(join(webDistDir, "assets", "app.js"), "console.log('v1 shell');\n", "utf8");
  return webDistDir;
}

async function withApp<T>(fn: (app: ControlApp, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "frc-v1-control-"));
  const templateDir = await createTemplate(root);
  const webDistDir = await createWebDist(root);
  const app = await createApp({
    dataDir: join(root, "data"),
    templateDir,
    webDistDir,
    sessionSecret: "test-session-secret",
  });

  try {
    return await fn(app, root);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function login(app: ControlApp, displayName: string, cookie?: string): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (cookie) {
    headers.set("cookie", cookie);
  }

  return app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers,
      body: new URLSearchParams({ displayName }),
    }),
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie?.split(";")[0] ?? "";
}

describe("V1-1 session skeleton", () => {
  test("creating alice writes user, workspace, session, and project files", async () => {
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

  test("reloading with the signed cookie redirects to the existing workspace", async () => {
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
      expect(await workspace.text()).toContain("V1 test shell");
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

  test("does not let a different session claim or open another user's workspace", async () => {
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

describe("V1-2 routing and shell APIs", () => {
  test("serves the Vite shell and workspace-prefixed assets after auth", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const shell = await app.fetch(
        new Request("http://localhost/u/alice/", {
          headers: { cookie },
        }),
      );
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain("V1 test shell");

      const asset = await app.fetch(
        new Request("http://localhost/u/alice/assets/app.js", {
          headers: { cookie },
        }),
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("v1 shell");
    });
  });

  test("returns session, project tree, and heartbeat for the signed workspace", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const session = await app.fetch(
        new Request("http://localhost/u/alice/api/session", {
          headers: { cookie },
        }),
      );
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({
        user: { displayName: "alice" },
        workspace: { slug: "alice" },
      });

      const tree = await app.fetch(
        new Request("http://localhost/u/alice/api/project/tree", {
          headers: { cookie },
        }),
      );
      expect(tree.status).toBe(200);
      const treeText = JSON.stringify(await tree.json());
      expect(treeText).toContain("Robot.java");
      expect(treeText).not.toContain("gradle-wrapper.jar");

      const heartbeat = await app.fetch(
        new Request("http://localhost/u/alice/api/heartbeat", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ closing: true }),
        }),
      );
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toEqual({ ok: true, closing: true });
    });
  });

  test("rejects API access to another workspace", async () => {
    await withApp(async (app) => {
      const alice = await login(app, "alice");
      const aliceCookie = cookieFrom(alice);
      const bob = await login(app, "bob");
      const bobCookie = cookieFrom(bob);

      const aliceAsBob = await app.fetch(
        new Request("http://localhost/u/bob/api/session", {
          headers: { cookie: aliceCookie },
        }),
      );
      expect(aliceAsBob.status).toBe(403);

      const bobSession = await app.fetch(
        new Request("http://localhost/u/bob/api/session", {
          headers: { cookie: bobCookie },
        }),
      );
      expect(bobSession.status).toBe(200);
      expect(await bobSession.json()).toMatchObject({
        user: { displayName: "bob" },
        workspace: { slug: "bob" },
      });
    });
  });
});
