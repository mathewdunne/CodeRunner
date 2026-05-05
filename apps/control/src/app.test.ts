import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile, access, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type ControlApp, type ControlAppOptions } from "./app";
import type { DockerCommandResult, DockerRunner } from "./containers";

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

async function withApp<T>(
  fn: (app: ControlApp, root: string) => Promise<T>,
  options: Partial<ControlAppOptions> = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "frc-v1-control-"));
  const templateDir = await createTemplate(root);
  const webDistDir = await createWebDist(root);
  const app = await createApp({
    dataDir: join(root, "data"),
    templateDir,
    webDistDir,
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
        "5810/tcp": [
          {
            HostIp: container.hostIp,
            HostPort: String(container.port),
          },
        ],
      },
    },
  };
}

function createFakeDocker() {
  const containers = new Map<string, FakeContainer>();
  const calls: string[][] = [];

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
      const names = [...containers.values()]
        .filter((container) => container.labels["frc-sim.workspace"] === workspaceId)
        .map((container) => container.name);
      return ok(`${names.join("\n")}${names.length ? "\n" : ""}`);
    }

    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const portMapping = args[args.indexOf("-p") + 1] ?? "";
      const port = Number(/^127\.0\.0\.1:(\d+):5810$/u.exec(portMapping)?.[1]);
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
      });
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
});
