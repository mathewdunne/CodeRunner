import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile, access, readFile, symlink } from "node:fs/promises";
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

function workspaceProjectPath(app: ControlApp, slug: string): string {
  const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as {
    project_path: string;
  } | null;
  expect(workspace).toBeTruthy();
  return workspace?.project_path ?? "";
}

async function tryCreateSymlink(target: string, path: string, type: "file" | "dir"): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
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

describe("V1-3 project file APIs", () => {
  test("creates, edits, reloads, renames, and deletes allowlisted project files", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);
      const authHeaders = {
        cookie,
        "content-type": "application/json",
      };

      const createDirectory = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ kind: "directory", path: "src/main/java/frc/robot/subsystems" }),
        }),
      );
      expect(createDirectory.status).toBe(200);

      const filePath = "src/main/java/frc/robot/subsystems/ExampleSubsystem.java";
      const createFile = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            kind: "file",
            path: filePath,
            contents: "package frc.robot.subsystems;\n\npublic class ExampleSubsystem {}\n",
          }),
        }),
      );
      expect(createFile.status).toBe(200);

      const write = await app.fetch(
        new Request(`http://localhost/u/alice/api/files?path=${encodeURIComponent(filePath)}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({
            contents: "package frc.robot.subsystems;\n\npublic final class ExampleSubsystem {}\n",
          }),
        }),
      );
      expect(write.status).toBe(200);

      const read = await app.fetch(
        new Request(`http://localhost/u/alice/api/files?path=${encodeURIComponent(filePath)}`, {
          headers: { cookie },
        }),
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        path: filePath,
        contents: "package frc.robot.subsystems;\n\npublic final class ExampleSubsystem {}\n",
        access: "editable",
      });

      const projectPath = workspaceProjectPath(app, "alice");
      expect(await readFile(join(projectPath, ...filePath.split("/")), "utf8")).toContain("final class");
      const parentEntries = await readdir(join(projectPath, "src", "main", "java", "frc", "robot", "subsystems"));
      expect(parentEntries.some((entry) => entry.startsWith(".frc-sim-write-"))).toBe(false);

      const renamedPath = "src/main/java/frc/robot/subsystems/RenamedSubsystem.java";
      const renameResponse = await app.fetch(
        new Request("http://localhost/u/alice/api/files/rename", {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ from: filePath, to: renamedPath }),
        }),
      );
      expect(renameResponse.status).toBe(200);

      const deleteResponse = await app.fetch(
        new Request(`http://localhost/u/alice/api/files?path=${encodeURIComponent(renamedPath)}`, {
          method: "DELETE",
          headers: authHeaders,
        }),
      );
      expect(deleteResponse.status).toBe(200);
    });
  });

  test("deletes empty directories and rejects non-empty directories", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);
      const authHeaders = {
        cookie,
        "content-type": "application/json",
      };

      const emptyPath = "src/main/java/frc/robot/empty";
      const createEmpty = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ kind: "directory", path: emptyPath }),
        }),
      );
      expect(createEmpty.status).toBe(200);

      const deleteEmpty = await app.fetch(
        new Request(`http://localhost/u/alice/api/files?path=${encodeURIComponent(emptyPath)}`, {
          method: "DELETE",
          headers: authHeaders,
        }),
      );
      expect(deleteEmpty.status).toBe(200);

      const nonEmptyPath = "src/main/java/frc/robot/nonempty";
      const createNonEmpty = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ kind: "directory", path: nonEmptyPath }),
        }),
      );
      expect(createNonEmpty.status).toBe(200);

      const createChild = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ kind: "file", path: `${nonEmptyPath}/Child.java`, contents: "" }),
        }),
      );
      expect(createChild.status).toBe(200);

      const deleteNonEmpty = await app.fetch(
        new Request(`http://localhost/u/alice/api/files?path=${encodeURIComponent(nonEmptyPath)}`, {
          method: "DELETE",
          headers: authHeaders,
        }),
      );
      expect(deleteNonEmpty.status).toBe(409);
    });
  });

  test("rejects symlink targets in allowlisted file paths", async () => {
    await withApp(async (app, root) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);
      const projectPath = workspaceProjectPath(app, "alice");
      const outsidePath = join(root, "outside.txt");
      const linkPath = join(projectPath, "src", "main", "java", "frc", "robot", "Linked.java");
      await writeFile(outsidePath, "outside\n", "utf8");

      const symlinkCreated = await tryCreateSymlink(outsidePath, linkPath, "file");
      if (!symlinkCreated) {
        return;
      }

      const read = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/Linked.java", {
          headers: { cookie },
        }),
      );
      expect(read.status).toBe(403);
    });
  });

  test("rejects read and write through symlinked ancestor directories", async () => {
    await withApp(async (app, root) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);
      const projectPath = workspaceProjectPath(app, "alice");
      const outsideDir = join(root, "outside-dir");
      const linkDir = join(projectPath, "src", "main", "java", "frc", "robot", "linked");
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "Escape.java"), "outside\n", "utf8");

      const symlinkCreated = await tryCreateSymlink(outsideDir, linkDir, "dir");
      if (!symlinkCreated) {
        return;
      }

      const read = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/linked/Escape.java", {
          headers: { cookie },
        }),
      );
      expect(read.status).toBe(403);

      const write = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/linked/Escape.java", {
          method: "PUT",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ contents: "package frc.robot;\n" }),
        }),
      );
      expect(write.status).toBe(403);
    });
  });

  test("omits leftover atomic write temp files from the project tree", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);
      const projectPath = workspaceProjectPath(app, "alice");
      await writeFile(
        join(projectPath, "src", "main", "java", "frc", "robot", ".frc-sim-write-deadbeef.tmp"),
        "temporary\n",
        "utf8",
      );

      const tree = await app.fetch(
        new Request("http://localhost/u/alice/api/project/tree", {
          headers: { cookie },
        }),
      );
      expect(tree.status).toBe(200);
      expect(JSON.stringify(await tree.json())).not.toContain(".frc-sim-write-deadbeef.tmp");
    });
  });

  test("does not let another session read or mutate a workspace's files", async () => {
    await withApp(async (app) => {
      const alice = await login(app, "alice");
      const bob = await login(app, "bob");
      const bobCookie = cookieFrom(bob);
      const aliceCookie = cookieFrom(alice);

      const bobReadsAlice = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/Robot.java", {
          headers: { cookie: bobCookie },
        }),
      );
      expect(bobReadsAlice.status).toBe(403);

      const bobMutatesAlice = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: {
            cookie: bobCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ kind: "file", path: "src/main/java/frc/robot/Bob.java" }),
        }),
      );
      expect(bobMutatesAlice.status).toBe(403);

      const aliceReadsAlice = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/Robot.java", {
          headers: { cookie: aliceCookie },
        }),
      );
      expect(aliceReadsAlice.status).toBe(200);
    });
  });

  test("rejects hidden, generated, readonly, and outside-allowlist paths", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const hiddenRead = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=gradle/wrapper/gradle-wrapper.jar", {
          headers: { cookie },
        }),
      );
      expect(hiddenRead.status).toBe(403);

      const generatedRead = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=build/classes/Robot.class", {
          headers: { cookie },
        }),
      );
      expect(generatedRead.status).toBe(403);

      const readonlyWrite = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=build.gradle", {
          method: "PUT",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ contents: "plugins {}\n" }),
        }),
      );
      expect(readonlyWrite.status).toBe(403);

      const outsideCreate = await app.fetch(
        new Request("http://localhost/u/alice/api/files", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ kind: "file", path: "vendordeps/Extra.json" }),
        }),
      );
      expect(outsideCreate.status).toBe(403);

      const badPath = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=../Robot.java", {
          headers: { cookie },
        }),
      );
      expect(badPath.status).toBe(400);
    });
  });
});
