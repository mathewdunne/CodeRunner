import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile, access, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type ControlApp, type ControlAppOptions } from "./app";
import type { DockerCommandResult, DockerRunner } from "./containers";
import type { RunCommandFactory } from "./runs";
import type { WorkspaceRow } from "./storage";

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

async function createAdvantageScopeDist(root: string): Promise<string> {
  const ascopeDistDir = join(root, "ascope-dist");
  await mkdir(join(ascopeDistDir, "bundles"), { recursive: true });
  await mkdir(join(ascopeDistDir, "bundledAssets", "Robot_Test"), { recursive: true });
  await mkdir(join(ascopeDistDir, "www", "textures"), { recursive: true });
  await writeFile(
    join(ascopeDistDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="bundles/main.js"></script></head><body>AS Lite</body></html>',
    "utf8",
  );
  await writeFile(join(ascopeDistDir, "bundles", "main.js"), "console.log('ascope main');\n", "utf8");
  await writeFile(join(ascopeDistDir, "bundles", "hub.js"), "console.log('ascope hub');\n", "utf8");
  await writeFile(join(ascopeDistDir, "bundledAssets", "Robot_Test", "config.json"), "{\"name\":\"Robot_Test\"}\n", "utf8");
  await writeFile(join(ascopeDistDir, "www", "textures", "example.png"), "fake png\n", "utf8");
  return ascopeDistDir;
}

async function withApp<T>(
  fn: (app: ControlApp, root: string) => Promise<T>,
  options: Partial<ControlAppOptions> = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "frc-v1-control-"));
  const templateDir = await createTemplate(root);
  const webDistDir = await createWebDist(root);
  const advantageScopeDistDir = await createAdvantageScopeDist(root);
  const app = await createApp({
    dataDir: join(root, "data"),
    templateDir,
    webDistDir,
    advantageScopeDistDir,
    sessionSecret: "test-session-secret",
    containerAutoStart: false,
    ...options,
  });

  try {
    return await fn(app, root);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}

type FakeContainer = {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  hostIp: string;
  port: number;
  containerPort: number;
};

function ok(stdout = ""): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function missing(message = "missing"): DockerCommandResult {
  return { exitCode: 1, stdout: "", stderr: message };
}

function dockerInspect(container: FakeContainer): unknown {
  return {
    Name: `/${container.name}`,
    State: {
      Running: container.running,
      Status: container.running ? "running" : "exited",
    },
    Config: {
      Labels: container.labels,
    },
    NetworkSettings: {
      Ports: {
        [`${container.containerPort}/tcp`]: [
          {
            HostIp: container.hostIp,
            HostPort: String(container.port),
          },
        ],
      },
    },
  };
}

function createFakeDocker(options: { failRunPortsOnce?: number[]; onRunPort?: (port: number) => void } = {}) {
  const containers = new Map<string, FakeContainer>();
  const calls: string[][] = [];
  const failRunPortsOnce = new Set(options.failRunPortsOnce ?? []);

  const runner: DockerRunner = async (args) => {
    calls.push([...args]);

    if (args[0] === "image" && args[1] === "inspect") {
      return ok(JSON.stringify([{ Id: "fake-image" }]));
    }

    if (args[0] === "container" && args[1] === "inspect") {
      const container = containers.get(args[2] ?? "");
      return container ? ok(JSON.stringify([dockerInspect(container)])) : missing("No such container");
    }

    if (args[0] === "container" && args[1] === "ls") {
      const workspaceFilter = args.find((arg) => arg.startsWith("label=frc-sim.workspace="));
      const workspaceId = workspaceFilter?.slice("label=frc-sim.workspace=".length);
      const roleFilter = args.find((arg) => arg.startsWith("label=frc-sim.role="));
      const roleValue = roleFilter?.slice("label=frc-sim.role=".length);
      const statusFilter = args.find((arg) => arg.startsWith("status="));
      const statusValue = statusFilter?.slice("status=".length);
      const names = [...containers.values()]
        .filter((container) => {
          if (workspaceId && container.labels["frc-sim.workspace"] !== workspaceId) {
            return false;
          }
          if (roleValue && container.labels["frc-sim.role"] !== roleValue) {
            return false;
          }
          if (statusValue === "exited" && container.running) {
            return false;
          }
          return true;
        })
        .map((container) => container.name);
      return ok(`${names.join("\n")}${names.length ? "\n" : ""}`);
    }

    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const portMapping = args[args.indexOf("-p") + 1] ?? "";
      const portMatch = /^127\.0\.0\.1:(\d+):(\d+)$/u.exec(portMapping);
      const port = Number(portMatch?.[1]);
      const containerPort = Number(portMatch?.[2]);
      if (failRunPortsOnce.has(port)) {
        failRunPortsOnce.delete(port);
        return missing(`Bind for 127.0.0.1:${port} failed: port is already allocated`);
      }
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, value] = (args[index + 1] ?? "").split("=");
          if (key && value) {
            labels[key] = value;
          }
        }
      }
      containers.set(name, {
        name,
        running: true,
        labels,
        hostIp: "127.0.0.1",
        port,
        containerPort,
      });
      options.onRunPort?.(port);
      return ok("fake-container-id\n");
    }

    if (args[0] === "start") {
      const container = containers.get(args[1] ?? "");
      if (!container) {
        return missing("No such container");
      }
      container.running = true;
      return ok(`${container.name}\n`);
    }

    if (args[0] === "rm" && args[1] === "-f") {
      containers.delete(args[2] ?? "");
      return ok();
    }

    if (args[0] === "rm" && args[1] && args[1] !== "-f") {
      containers.delete(args[1]);
      return ok();
    }

    if (args[0] === "stop") {
      const container = containers.get(args[1] ?? "");
      if (!container) {
        return missing("No such container");
      }
      container.running = false;
      return ok(`${container.name}\n`);
    }

    return missing(`unhandled docker args: ${args.join(" ")}`);
  };

  return { runner, containers, calls };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition.");
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

function workspaceBySlug(app: ControlApp, slug: string) {
  const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as WorkspaceRow | null;
  expect(workspace).toBeTruthy();
  return workspace!;
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

describe("V1-4 sim container orchestration", () => {
  test("container status creates a managed sim container and lease", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);

        const status = await app.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );

        expect(status.status).toBe(200);
        const body = await status.json();
        expect(body).toMatchObject({
          workspace: { slug: "alice" },
          sim: {
            role: "sim",
            state: "running",
            image: "frc-sim:test",
            portAllocated: true,
            error: null,
          },
        });

        const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get("alice") as {
          id: string;
          project_path: string;
        };
        const expectedName = `frc-v1-sim-${workspace.id}`;
        expect(body.sim.containerName).toBe(expectedName);
        expect(fakeDocker.containers.has(expectedName)).toBe(true);

        const runCall = fakeDocker.calls.find((call) => call[0] === "run");
        expect(runCall).toBeTruthy();
        expect(runCall).toContain(`frc-sim.workspace=${workspace.id}`);
        expect(runCall).toContain(`type=bind,src=${workspace.project_path},dst=/workspace/project`);
        expect(runCall).toContain(`type=bind,src=${join(app.storage.config.dataDir, "users", workspace.id, "home")},dst=/home/frc`);
        expect(runCall).toContain("127.0.0.1:25810:5810");
        expect(runCall).toContain("--user");
        expect(runCall?.[runCall.indexOf("--user") + 1]).toBe("123:456");

        const lease = app.storage.db.query("SELECT * FROM container_leases WHERE workspace_id = ?").get(workspace.id) as {
          sim_container: string;
          sim_port: number;
          state: string;
        };
        expect(lease).toMatchObject({
          sim_container: expectedName,
          sim_port: 25810,
          state: "running",
        });
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25810, end: 25810 },
        containerUser: "123:456",
      },
    );
  });

  test("opening a workspace kicks off sim startup without blocking the shell", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);

        const shell = await app.fetch(
          new Request("http://localhost/u/alice/", {
            headers: { cookie },
          }),
        );
        expect(shell.status).toBe(200);
        await waitFor(() => fakeDocker.calls.some((call) => call[0] === "run"));
        expect(fakeDocker.containers.size).toBe(1);
      },
      {
        dockerRunner: fakeDocker.runner,
        containerAutoStart: true,
        simImage: "frc-sim:test",
        simPortRange: { start: 25811, end: 25811 },
      },
    );
  });

  test("sim entrypoint idles until the run queue starts the sim", async () => {
    const entrypoint = await readFile(join(process.cwd(), "containers", "sim", "entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("Waiting for a queued run request");
    expect(entrypoint).not.toContain("/usr/local/bin/start-sim.sh");
  });

  test("sim Gradle uses a project cache outside the mounted project", async () => {
    const startSim = await readFile(join(process.cwd(), "containers", "sim", "start-sim.sh"), "utf8");
    expect(startSim).toContain("GRADLE_PROJECT_CACHE_DIR");
    expect(startSim).toContain("--project-cache-dir \"$GRADLE_PROJECT_CACHE_DIR\"");
  });

  test("a restarted control plane rediscovers the labeled sim container", async () => {
    const root = await mkdtemp(join(tmpdir(), "frc-v1-control-"));
    const templateDir = await createTemplate(root);
    const webDistDir = await createWebDist(root);
    const fakeDocker = createFakeDocker();
    const config: ControlAppOptions = {
      dataDir: join(root, "data"),
      templateDir,
      webDistDir,
      sessionSecret: "test-session-secret",
      containerAutoStart: false,
      dockerRunner: fakeDocker.runner,
      simImage: "frc-sim:test",
      simPortRange: { start: 25812, end: 25812 },
    };

    const app1 = await createApp(config);
    try {
      const response = await login(app1, "alice");
      const cookie = cookieFrom(response);
      const firstStatus = await app1.fetch(
        new Request("http://localhost/u/alice/api/containers/status", {
          headers: { cookie },
        }),
      );
      expect(firstStatus.status).toBe(200);
      const runCount = fakeDocker.calls.filter((call) => call[0] === "run").length;
      app1.close();

      const app2 = await createApp(config);
      try {
        const secondStatus = await app2.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(secondStatus.status).toBe(200);
        expect(await secondStatus.json()).toMatchObject({
          sim: { state: "running", portAllocated: true },
        });
        expect(fakeDocker.calls.filter((call) => call[0] === "run").length).toBe(runCount);
      } finally {
        app2.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recreating a removed container preserves project files", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);
        const projectPath = workspaceProjectPath(app, "alice");
        const robotPath = join(projectPath, "src", "main", "java", "frc", "robot", "Robot.java");
        await writeFile(robotPath, "package frc.robot;\n// sentinel\n", "utf8");

        const firstStatus = await app.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(firstStatus.status).toBe(200);
        const firstBody = await firstStatus.json();
        fakeDocker.containers.delete(firstBody.sim.containerName);

        const secondStatus = await app.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(secondStatus.status).toBe(200);
        expect(await secondStatus.json()).toMatchObject({
          sim: { state: "running" },
        });
        expect(await readFile(robotPath, "utf8")).toContain("sentinel");
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25813, end: 25813 },
      },
    );
  });

  test("concurrent workspace startup reserves distinct sim ports", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        await login(app, "bob");
        const aliceWorkspace = workspaceBySlug(app, "alice");
        const bobWorkspace = workspaceBySlug(app, "bob");

        const [aliceStatus, bobStatus] = await Promise.all([
          app.containers.ensureSimContainer(aliceWorkspace),
          app.containers.ensureSimContainer(bobWorkspace),
        ]);

        expect(aliceStatus.state).toBe("running");
        expect(bobStatus.state).toBe("running");
        const ports = [...fakeDocker.containers.values()].map((container) => container.port);
        expect(new Set(ports).size).toBe(2);
        expect(ports.sort()).toEqual([25814, 25815]);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25814, end: 25815 },
      },
    );
  });

  test("retries the next sim port when Docker reports a bind conflict", async () => {
    const fakeDocker = createFakeDocker({ failRunPortsOnce: [25816] });

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        const status = await app.containers.ensureSimContainer(workspace);

        expect(status.state).toBe("running");
        const runPorts = fakeDocker.calls
          .filter((call) => call[0] === "run")
          .map((call) => Number(/^127\.0\.0\.1:(\d+):5810$/u.exec(call[call.indexOf("-p") + 1] ?? "")?.[1]));
        expect(runPorts).toEqual([25816, 25817]);
        expect(app.storage.getContainerLease(workspace.id)).toMatchObject({ sim_port: 25817 });
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25816, end: 25817 },
      },
    );
  });
});

describe("V1-5 run queue and log streaming", () => {
  function createControlledRunCommands() {
    const encoder = new TextEncoder();
    const commands: Array<{
      context: Parameters<RunCommandFactory>[0];
      killed: boolean;
      writeStdout(line: string): void;
      writeStderr(line: string): void;
      exit(code: number | null, signal?: string | null): void;
    }> = [];

    const commandFactory: RunCommandFactory = (context) => {
      let stdoutController: ReadableStreamDefaultController<Uint8Array>;
      let stderrController: ReadableStreamDefaultController<Uint8Array>;
      let resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => {};
      let finished = false;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = resolve;
      });

      const command = {
        context,
        killed: false,
        writeStdout(line: string) {
          stdoutController.enqueue(encoder.encode(`${line}\n`));
        },
        writeStderr(line: string) {
          stderrController.enqueue(encoder.encode(`${line}\n`));
        },
        exit(code: number | null, signal: string | null = null) {
          if (finished) {
            return;
          }
          finished = true;
          stdoutController.close();
          stderrController.close();
          resolveExit({ code, signal });
        },
      };

      commands.push(command);
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            stdoutController = controller;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            stderrController = controller;
          },
        }),
        exited,
        kill() {
          command.killed = true;
          command.exit(null, "SIGTERM");
        },
      };
    };

    return { commands, commandFactory };
  }

  test("streams logs, persists run jobs, and releases the build slot after readiness", async () => {
    const fakeDocker = createFakeDocker();
    const controlled = createControlledRunCommands();

    await withApp(
      async (app) => {
        const aliceLogin = await login(app, "alice");
        const bobLogin = await login(app, "bob");
        expect(aliceLogin.status).toBe(303);
        expect(bobLogin.status).toBe(303);

        const aliceWorkspace = workspaceBySlug(app, "alice");
        const bobWorkspace = workspaceBySlug(app, "bob");
        const aliceMessages: unknown[] = [];
        const bobMessages: unknown[] = [];
        const aliceConnection = app.runs.connect(aliceWorkspace, (message) => aliceMessages.push(message));
        const bobConnection = app.runs.connect(bobWorkspace, (message) => bobMessages.push(message));

        const aliceRunId = app.runs.start(aliceWorkspace, aliceConnection);
        const bobRunId = app.runs.start(bobWorkspace, bobConnection);

        await waitFor(() => controlled.commands.length === 1);
        expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
        expect(bobMessages).toContainEqual({ type: "queue", queueDepth: 1, queuePosition: 0 });

        controlled.commands[0]?.writeStdout("NT4 listening on 5810");
        controlled.commands[0]?.writeStdout("robot periodic tick");
        await waitFor(() => JSON.stringify(aliceMessages).includes("running"));

        const aliceRun = app.storage.getRunJob(aliceRunId);
        expect(aliceRun).toMatchObject({ state: "running", workspace_id: aliceWorkspace.id });
        expect(await readFile(aliceRun?.log_path ?? "", "utf8")).toContain("robot periodic tick");
        await waitFor(() => controlled.commands.length === 2);
        expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
        expect(app.storage.getRunJob(bobRunId)).toMatchObject({ state: "building" });
        expect(controlled.commands[0]?.killed).toBe(false);

        app.runs.stopWorkspace(aliceWorkspace.id);
        expect(controlled.commands[0]?.killed).toBe(true);
        await waitFor(() => app.storage.getRunJob(aliceRunId)?.state === "stopped");
        expect(app.storage.getRunJob(aliceRunId)).toMatchObject({ state: "stopped", exit_code: null });
        app.runs.stopWorkspace(bobWorkspace.id);
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        runConcurrency: 1,
        simImage: "frc-sim:test",
        simPortRange: { start: 25820, end: 25829 },
      },
    );
  });

  test("times out a run that never reaches simulator readiness and pumps the queue", async () => {
    const fakeDocker = createFakeDocker();
    const controlled = createControlledRunCommands();

    await withApp(
      async (app) => {
        await login(app, "alice");
        await login(app, "bob");
        const aliceWorkspace = workspaceBySlug(app, "alice");
        const bobWorkspace = workspaceBySlug(app, "bob");
        const aliceMessages: unknown[] = [];
        const bobMessages: unknown[] = [];
        const aliceConnection = app.runs.connect(aliceWorkspace, (message) => aliceMessages.push(message));
        const bobConnection = app.runs.connect(bobWorkspace, (message) => bobMessages.push(message));

        const aliceRunId = app.runs.start(aliceWorkspace, aliceConnection);
        app.runs.start(bobWorkspace, bobConnection);

        await waitFor(() => controlled.commands[0]?.killed === true);
        await waitFor(() => controlled.commands.length === 2);
        expect(app.storage.getRunJob(aliceRunId)).toMatchObject({ state: "failed", exit_code: null });
        expect(JSON.stringify(aliceMessages)).toContain("timed out before simulator readiness");
        expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
        expect(bobMessages).toContainEqual({ type: "status", status: "building" });
        app.runs.stopWorkspace(bobWorkspace.id);
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        runConcurrency: 1,
        runBuildTimeoutMs: 20,
        simStartupTimeoutMs: 20,
        simImage: "frc-sim:test",
        simPortRange: { start: 25840, end: 25849 },
      },
    );
  });

  test("replaces a queued run for the same workspace", async () => {
    const fakeDocker = createFakeDocker();
    const controlled = createControlledRunCommands();

    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        expect(response.status).toBe(303);
        const workspace = workspaceBySlug(app, "alice");
        const messages: unknown[] = [];
        const connection = app.runs.connect(workspace, (message) => messages.push(message));

        const firstRunId = app.runs.start(workspace, connection);
        const secondRunId = app.runs.start(workspace, connection);

        await waitFor(() => controlled.commands.length === 1);
        expect(firstRunId).not.toBe(secondRunId);
        expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
        expect(app.storage.getRunJob(firstRunId)).toMatchObject({ state: "stopped" });
        expect(app.storage.getRunJob(secondRunId)).toMatchObject({ state: "building" });
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        runConcurrency: 1,
        simImage: "frc-sim:test",
        simPortRange: { start: 25830, end: 25839 },
      },
    );
  });
});

describe("V1-6 AdvantageScope Lite and NT4 routing", () => {
  test("serves AdvantageScope Lite under /scope with assets manifest and www redirect", async () => {
    await withApp(async (app) => {
      const index = await app.fetch(new Request("http://localhost/scope/"));
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("AS Lite");

      const main = await app.fetch(new Request("http://localhost/scope/bundles/main.js"));
      expect(main.status).toBe(200);
      expect(main.headers.get("content-type")).toContain("text/javascript");
      expect(await main.text()).toContain("ascope main");

      const manifest = await app.fetch(new Request("http://localhost/scope/assets"));
      expect(manifest.status).toBe(200);
      expect(await manifest.json()).toMatchObject({
        "Robot_Test/config.json": { name: "Robot_Test" },
      });

      const asset = await app.fetch(new Request("http://localhost/scope/assets/Robot_Test/config.json"));
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("Robot_Test");

      const redirect = await app.fetch(new Request("http://localhost/scope/www/www/textures/example.png"));
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/scope/www/textures/example.png");
    });
  });

  test("proxies authenticated sim alive checks to the workspace sim port", async () => {
    const nt4Servers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRunPort(port) {
        nt4Servers.push(
          Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch() {
              return new Response("nt4 alive\n");
            },
          }),
        );
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceLogin = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceLogin);
          const bobLogin = await login(app, "bob");
          const bobCookie = cookieFrom(bobLogin);

          const alive = await app.fetch(
            new Request("http://localhost/u/alice/sim/alive", {
              headers: { cookie: aliceCookie },
            }),
          );
          expect(alive.status).toBe(200);
          expect(await alive.text()).toContain("ok");

          const bobReadsAlice = await app.fetch(
            new Request("http://localhost/u/alice/sim/alive", {
              headers: { cookie: bobCookie },
            }),
          );
          expect(bobReadsAlice.status).toBe(403);
        },
        {
          dockerRunner: fakeDocker.runner,
          simImage: "frc-sim:test",
          simPortRange: { start: 25910, end: 25910 },
        },
      );
    } finally {
      for (const server of nt4Servers) {
        server.stop(true);
      }
    }
  });
});

describe("V1-7 Java LSP container and proxy", () => {
  test("container status reports per-workspace sim and LSP containers", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);

        const status = await app.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(status.status).toBe(200);

        const body = await status.json();
        const workspace = workspaceBySlug(app, "alice");
        expect(body).toMatchObject({
          sim: {
            role: "sim",
            state: "running",
            image: "frc-sim:test",
            portAllocated: true,
            error: null,
          },
          lsp: {
            role: "lsp",
            state: "running",
            image: "frc-lsp:test",
            portAllocated: true,
            error: null,
          },
        });
        expect(body.sim.containerName).toBe(`frc-v1-sim-${workspace.id}`);
        expect(body.lsp.containerName).toBe(`frc-v1-lsp-${workspace.id}`);

        const lspRunCall = fakeDocker.calls.find(
          (call) => call[0] === "run" && call.includes("frc-sim.role=lsp"),
        );
        expect(lspRunCall).toBeTruthy();
        expect(lspRunCall).toContain(`frc-sim.workspace=${workspace.id}`);
        expect(lspRunCall).toContain(
          `type=bind,src=${join(app.storage.config.dataDir, "users", workspace.id, "jdtls-data")},dst=/workspace/jdtls-data`,
        );
        expect(lspRunCall).toContain("127.0.0.1:30003:30003");
        expect(lspRunCall).toContain("frc-lsp:test");

        const lease = app.storage.getContainerLease(workspace.id);
        expect(lease).toMatchObject({
          lsp_container: `frc-v1-lsp-${workspace.id}`,
          lsp_port: 30003,
          lsp_state: "running",
        });
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25950, end: 25950 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30003, end: 30003 },
      },
    );
  });

  test("a restarted control plane rediscovers the labeled LSP container", async () => {
    const root = await mkdtemp(join(tmpdir(), "frc-v1-lsp-"));
    const templateDir = await createTemplate(root);
    const webDistDir = await createWebDist(root);
    const fakeDocker = createFakeDocker();
    const config: ControlAppOptions = {
      dataDir: join(root, "data"),
      templateDir,
      webDistDir,
      sessionSecret: "test-session-secret",
      containerAutoStart: false,
      dockerRunner: fakeDocker.runner,
      simImage: "frc-sim:test",
      simPortRange: { start: 25960, end: 25960 },
      lspImage: "frc-lsp:test",
      lspPortRange: { start: 30013, end: 30013 },
    };

    const app1 = await createApp(config);
    try {
      const response = await login(app1, "alice");
      const cookie = cookieFrom(response);
      const firstStatus = await app1.fetch(
        new Request("http://localhost/u/alice/api/containers/status", {
          headers: { cookie },
        }),
      );
      expect(firstStatus.status).toBe(200);
      const lspRunsBefore = fakeDocker.calls.filter(
        (call) => call[0] === "run" && call.includes("frc-sim.role=lsp"),
      ).length;
      app1.close();

      const app2 = await createApp(config);
      try {
        const secondStatus = await app2.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(secondStatus.status).toBe(200);
        expect(await secondStatus.json()).toMatchObject({
          lsp: { state: "running", portAllocated: true },
        });
        const lspRunsAfter = fakeDocker.calls.filter(
          (call) => call[0] === "run" && call.includes("frc-sim.role=lsp"),
        ).length;
        expect(lspRunsAfter).toBe(lspRunsBefore);
      } finally {
        app2.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects /ws/lsp upgrade for another workspace", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        const aliceLogin = await login(app, "alice");
        const aliceCookie = cookieFrom(aliceLogin);
        const bobLogin = await login(app, "bob");
        expect(bobLogin.status).toBe(303);

        const bobReadsAlice = await app.fetch(
          new Request("http://localhost/u/bob/ws/lsp", {
            headers: {
              cookie: aliceCookie,
              upgrade: "websocket",
              connection: "upgrade",
            },
          }),
        );
        expect(bobReadsAlice.status).toBe(403);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25970, end: 25970 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30023, end: 30023 },
      },
    );
  });
});

describe("V1-8 idle teardown, recovery, and operator controls", () => {
  test("heartbeat touches container lease activity", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);

        const leaseBefore = app.storage.getContainerLease(workspace.id);
        expect(leaseBefore).toBeTruthy();
        const lastUsedBefore = leaseBefore!.last_used_at;

        await Bun.sleep(20);

        const heartbeat = await app.fetch(
          new Request("http://localhost/u/alice/api/heartbeat", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: "{}",
          }),
        );
        expect(heartbeat.status).toBe(200);
        const body = (await heartbeat.json()) as { ok: boolean };
        expect(body.ok).toBe(true);

        const leaseAfter = app.storage.getContainerLease(workspace.id);
        expect(leaseAfter).toBeTruthy();
        expect(leaseAfter!.last_used_at >= lastUsedBefore).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25980, end: 25980 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30030, end: 30030 },
      },
    );
  });

  test("heartbeat accepts a closing flag", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const heartbeat = await app.fetch(
        new Request("http://localhost/u/alice/api/heartbeat", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ closing: true }),
        }),
      );
      expect(heartbeat.status).toBe(200);
      const body = (await heartbeat.json()) as { ok: boolean; closing: boolean };
      expect(body.ok).toBe(true);
      expect(body.closing).toBe(true);
    });
  });

  test("admin status returns workspace and container info", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        await login(app, "bob");

        const status = await app.fetch(new Request("http://localhost/admin/status"));
        expect(status.status).toBe(200);
        const body = (await status.json()) as {
          ok: boolean;
          workspaces: Array<{ workspace: { slug: string }; user: { displayName: string } }>;
          idleStopMinutes: number;
          runConcurrency: number;
          activeBuilds: number;
          queueDepth: number;
        };
        expect(body.ok).toBe(true);
        expect(body.workspaces.length).toBe(2);
        const slugs = body.workspaces.map((w) => w.workspace.slug).sort();
        expect(slugs).toEqual(["alice", "bob"]);
        expect(body.idleStopMinutes).toBe(30);
        expect(body.runConcurrency).toBe(2);
        expect(body.activeBuilds).toBe(0);
        expect(body.queueDepth).toBe(0);
      },
      { dockerRunner: fakeDocker.runner },
    );
  });

  test("admin status is rejected with wrong token when adminToken is configured", async () => {
    await withApp(
      async (app) => {
        await login(app, "alice");

        const noToken = await app.fetch(new Request("http://localhost/admin/status"));
        expect(noToken.status).toBe(401);

        const wrongToken = await app.fetch(
          new Request("http://localhost/admin/status", {
            headers: { authorization: "Bearer wrong-token" },
          }),
        );
        expect(wrongToken.status).toBe(401);

        const correctToken = await app.fetch(
          new Request("http://localhost/admin/status", {
            headers: { authorization: "Bearer test-admin-token" },
          }),
        );
        expect(correctToken.status).toBe(200);
      },
      { adminToken: "test-admin-token" },
    );
  });

  test("admin can restart a sim container", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v1-sim-${workspace.id}`)).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/restart-sim`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("restart-sim");

        expect(fakeDocker.containers.has(`frc-v1-sim-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25981, end: 25982 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30031, end: 30032 },
      },
    );
  });

  test("admin can restart an LSP container", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureLspContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v1-lsp-${workspace.id}`)).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/restart-lsp`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("restart-lsp");

        expect(fakeDocker.containers.has(`frc-v1-lsp-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25983, end: 25984 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30033, end: 30034 },
      },
    );
  });

  test("admin can reset LSP data without deleting project files", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureLspContainer(workspace);

        const jdtlsDataDir = join(workspace.project_path, "..", "jdtls-data");
        await writeFile(join(jdtlsDataDir, "test-cache.txt"), "cached data");

        const robotFile = join(workspace.project_path, "src", "main", "java", "frc", "robot", "Robot.java");
        await writeFile(robotFile, "// modified by test");

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/reset-lsp-data`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("reset-lsp-data");

        expect(await exists(jdtlsDataDir)).toBe(true);
        expect(await exists(join(jdtlsDataDir, "test-cache.txt"))).toBe(false);

        expect(await readFile(robotFile, "utf8")).toBe("// modified by test");
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25985, end: 25986 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30035, end: 30036 },
      },
    );
  });

  test("admin can stop all containers for a workspace", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        await app.containers.ensureLspContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${workspace.id}`)?.running).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/stop-containers`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("stop-containers");

        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(false);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${workspace.id}`)?.running).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25987, end: 25988 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30037, end: 30038 },
      },
    );
  });

  test("admin returns 404 for unknown workspace", async () => {
    await withApp(async (app) => {
      await login(app, "alice");

      const response = await app.fetch(
        new Request("http://localhost/admin/workspaces/ws_0000000000000000deadbeef00000000/restart-sim", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  test("idle sweep stops containers for idle workspaces", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        await app.containers.ensureLspContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);

        const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        app.storage.db
          .query("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?")
          .run(pastTime, workspace.id);

        const stopped = await app.idle.sweep();
        expect(stopped).toContain(workspace.id);

        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(false);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${workspace.id}`)?.running).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25989, end: 25990 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30039, end: 30040 },
        idleStopMinutes: 30,
      },
    );
  });

  test("idle sweep does not stop active workspaces", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);

        const stopped = await app.idle.sweep();
        expect(stopped).not.toContain(workspace.id);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25991, end: 25992 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30041, end: 30042 },
        idleStopMinutes: 30,
      },
    );
  });

  test("returning user gets new containers after idle teardown", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        await app.containers.ensureLspContainer(workspace);

        await app.containers.stopWorkspaceContainers(workspace.id);
        await app.containers.removeContainer("sim", workspace.id);
        await app.containers.removeContainer("lsp", workspace.id);
        expect(fakeDocker.containers.has(`frc-v1-sim-${workspace.id}`)).toBe(false);
        expect(fakeDocker.containers.has(`frc-v1-lsp-${workspace.id}`)).toBe(false);

        expect(await exists(join(workspace.project_path, "src", "main", "java", "frc", "robot", "Robot.java"))).toBe(true);

        await app.containers.ensureSimContainer(workspace);
        await app.containers.ensureLspContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v1-sim-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.has(`frc-v1-lsp-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25993, end: 25994 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30043, end: 30044 },
      },
    );
  });

  test("cleanup removes stopped managed containers", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureSimContainer(workspace);
        await app.containers.stopContainer("sim", workspace.id);
        expect(fakeDocker.containers.get(`frc-v1-sim-${workspace.id}`)?.running).toBe(false);

        const removed = await app.containers.cleanupStoppedContainers();
        expect(removed).toContain(`frc-v1-sim-${workspace.id}`);
        expect(fakeDocker.containers.has(`frc-v1-sim-${workspace.id}`)).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25995, end: 25996 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30045, end: 30046 },
      },
    );
  });

  test("operator restart does not affect other student's containers", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        await login(app, "bob");
        const aliceWorkspace = workspaceBySlug(app, "alice");
        const bobWorkspace = workspaceBySlug(app, "bob");

        await Promise.all([
          app.containers.ensureLspContainer(aliceWorkspace),
          app.containers.ensureLspContainer(bobWorkspace),
        ]);

        expect(fakeDocker.containers.get(`frc-v1-lsp-${aliceWorkspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${bobWorkspace.id}`)?.running).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${bobWorkspace.id}/restart-lsp`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);

        expect(fakeDocker.containers.get(`frc-v1-lsp-${aliceWorkspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.get(`frc-v1-lsp-${bobWorkspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        simImage: "frc-sim:test",
        simPortRange: { start: 25800, end: 25809 },
        lspImage: "frc-lsp:test",
        lspPortRange: { start: 30050, end: 30059 },
      },
    );
  });
});
