import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile, access, readFile } from "node:fs/promises";
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

type FakeContainerPort = {
  hostPort: number;
  containerPort: number;
  hostIp: string;
};

type FakeContainer = {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  ports: FakeContainerPort[];
};

function ok(stdout = ""): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function missing(message = "missing"): DockerCommandResult {
  return { exitCode: 1, stdout: "", stderr: message };
}

function dockerInspect(container: FakeContainer): unknown {
  const portsMap: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of container.ports) {
    const key = `${p.containerPort}/tcp`;
    if (!portsMap[key]) {
      portsMap[key] = [];
    }
    portsMap[key].push({ HostIp: p.hostIp, HostPort: String(p.hostPort) });
  }
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
      Ports: portsMap,
    },
  };
}

function createFakeDocker(options: {
  failRunPortsOnce?: number[];
  onRun?: (name: string, ports: FakeContainerPort[]) => void;
} = {}) {
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
      const versionFilter = args.find((arg) => arg.startsWith("label=frc-sim.version="));
      const versionValue = versionFilter?.slice("label=frc-sim.version=".length);
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
          if (versionValue && container.labels["frc-sim.version"] !== versionValue) {
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
      // Parse all -p flags for dual-port support
      const parsedPorts: FakeContainerPort[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "-p") {
          const mapping = args[i + 1] ?? "";
          const portMatch = /^([\d.]+):(\d+):(\d+)$/u.exec(mapping);
          if (portMatch) {
            parsedPorts.push({
              hostIp: portMatch[1]!,
              hostPort: Number(portMatch[2]),
              containerPort: Number(portMatch[3]),
            });
          }
        }
      }
      // Check if any port should trigger a failure
      for (const p of parsedPorts) {
        if (failRunPortsOnce.has(p.hostPort)) {
          failRunPortsOnce.delete(p.hostPort);
          return missing(`Bind for ${p.hostIp}:${p.hostPort} failed: port is already allocated`);
        }
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
        ports: parsedPorts,
      });
      options.onRun?.(name, parsedPorts);
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

  test("returns session and heartbeat for the signed workspace", async () => {
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

describe("V2 code container orchestration", () => {
  test("container status creates a managed code container with dual ports and lease", async () => {
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
          code: {
            role: "code",
            state: "running",
            image: "frc-code:test",
            simPortAllocated: true,
            vscodePortAllocated: true,
            error: null,
          },
        });

        const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get("alice") as {
          id: string;
          project_path: string;
        };
        const expectedName = `frc-v2-code-${workspace.id}`;
        expect(body.code.containerName).toBe(expectedName);
        expect(fakeDocker.containers.has(expectedName)).toBe(true);

        const runCall = fakeDocker.calls.find((call) => call[0] === "run");
        expect(runCall).toBeTruthy();
        expect(runCall).toContain(`frc-sim.workspace=${workspace.id}`);
        expect(runCall).toContain(`frc-sim.version=v2`);
        expect(runCall).toContain(`frc-sim.role=code`);
        expect(runCall).toContain(`type=bind,src=${workspace.project_path},dst=/workspace/project`);
        expect(runCall).toContain(`type=bind,src=${join(app.storage.config.dataDir, "users", workspace.id, "home")},dst=/home/frc`);
        expect(runCall).toContain("127.0.0.1:45910:5810");
        expect(runCall).toContain("127.0.0.1:46000:3000");
        expect(runCall).toContain("--user");
        expect(runCall?.[runCall.indexOf("--user") + 1]).toBe("123:456");

        const lease = app.storage.db.query("SELECT * FROM container_leases WHERE workspace_id = ?").get(workspace.id) as {
          sim_container: string;
          vscode_container: string;
          sim_port: number;
          vscode_port: number;
          state: string;
          code_state: string;
        };
        expect(lease).toMatchObject({
          sim_container: expectedName,
          vscode_container: expectedName,
          sim_port: 45910,
          vscode_port: 46000,
          state: "running",
          code_state: "running",
        });
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 45910, end: 45910 },
        vscodePortRange: { start: 46000, end: 46000 },
        containerUser: "123:456",
      },
    );
  });

  test("opening a workspace kicks off code container startup without blocking the shell", async () => {
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
        codeImage: "frc-code:test",
        simPortRange: { start: 25811, end: 25811 },
        vscodePortRange: { start: 33001, end: 33001 },
      },
    );
  });

  test("code entrypoint runs openvscode-server as primary process", async () => {
    const entrypoint = await readFile(join(process.cwd(), "containers", "code", "entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("openvscode-server");
  });

  test("a restarted control plane rediscovers the labeled code container", async () => {
    const root = await mkdtemp(join(tmpdir(), "frc-v2-control-"));
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
      codeImage: "frc-code:test",
      simPortRange: { start: 25812, end: 25812 },
      vscodePortRange: { start: 33002, end: 33002 },
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
          code: { state: "running", simPortAllocated: true, vscodePortAllocated: true },
        });
        expect(fakeDocker.calls.filter((call) => call[0] === "run").length).toBe(runCount);
      } finally {
        app2.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("app startup removes managed V1 containers", async () => {
    const fakeDocker = createFakeDocker();
    fakeDocker.containers.set("frc-v1-sim-leftover", {
      name: "frc-v1-sim-leftover",
      running: true,
      labels: {
        "frc-sim.managed": "true",
        "frc-sim.version": "v1",
        "frc-sim.role": "sim",
        "frc-sim.workspace": "ws_00000000000000000000000000000000",
      },
      ports: [],
    });

    await withApp(
      async () => {
        expect(fakeDocker.containers.has("frc-v1-sim-leftover")).toBe(false);
        expect(fakeDocker.calls).toContainEqual([
          "container",
          "ls",
          "-a",
          "--filter",
          "label=frc-sim.managed=true",
          "--filter",
          "label=frc-sim.version=v1",
          "--format",
          "{{.Names}}",
        ]);
        expect(fakeDocker.calls).toContainEqual(["rm", "-f", "frc-v1-sim-leftover"]);
      },
      { dockerRunner: fakeDocker.runner },
    );
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
        fakeDocker.containers.delete(firstBody.code.containerName);

        const secondStatus = await app.fetch(
          new Request("http://localhost/u/alice/api/containers/status", {
            headers: { cookie },
          }),
        );
        expect(secondStatus.status).toBe(200);
        expect(await secondStatus.json()).toMatchObject({
          code: { state: "running" },
        });
        expect(await readFile(robotPath, "utf8")).toContain("sentinel");
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25813, end: 25813 },
        vscodePortRange: { start: 33003, end: 33003 },
      },
    );
  });

  test("concurrent workspace startup reserves distinct port pairs", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        await login(app, "bob");
        const aliceWorkspace = workspaceBySlug(app, "alice");
        const bobWorkspace = workspaceBySlug(app, "bob");

        const [aliceStatus, bobStatus] = await Promise.all([
          app.containers.ensureCodeContainer(aliceWorkspace),
          app.containers.ensureCodeContainer(bobWorkspace),
        ]);

        expect(aliceStatus.state).toBe("running");
        expect(bobStatus.state).toBe("running");
        const simPorts = [...fakeDocker.containers.values()]
          .flatMap((c) => c.ports.filter((p) => p.containerPort === 5810).map((p) => p.hostPort));
        const vscodePorts = [...fakeDocker.containers.values()]
          .flatMap((c) => c.ports.filter((p) => p.containerPort === 3000).map((p) => p.hostPort));
        expect(new Set(simPorts).size).toBe(2);
        expect(new Set(vscodePorts).size).toBe(2);
        expect(simPorts.sort()).toEqual([25814, 25815]);
        expect(vscodePorts.sort()).toEqual([33004, 33005]);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25814, end: 25815 },
        vscodePortRange: { start: 33004, end: 33005 },
      },
    );
  });

  test("retries the next port when Docker reports a bind conflict", async () => {
    const fakeDocker = createFakeDocker({ failRunPortsOnce: [25816] });

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        const status = await app.containers.ensureCodeContainer(workspace);

        expect(status.state).toBe("running");
        const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
        expect(runCalls.length).toBe(2);
        expect(app.storage.getContainerLease(workspace.id)).toMatchObject({ sim_port: 25817 });
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25816, end: 25817 },
        vscodePortRange: { start: 33006, end: 33007 },
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
        codeImage: "frc-code:test",
        simPortRange: { start: 25820, end: 25829 },
        vscodePortRange: { start: 33020, end: 33029 },
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
        codeImage: "frc-code:test",
        simPortRange: { start: 25840, end: 25849 },
        vscodePortRange: { start: 33040, end: 33049 },
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
        codeImage: "frc-code:test",
        simPortRange: { start: 25830, end: 25839 },
        vscodePortRange: { start: 33030, end: 33039 },
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
      onRun(_name, ports) {
        const simPort = ports.find((p) => p.containerPort === 5810);
        if (simPort) {
          nt4Servers.push(
            Bun.serve({
              hostname: "127.0.0.1",
              port: simPort.hostPort,
              fetch() {
                return new Response("nt4 alive\n");
              },
            }),
          );
        }
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
          codeImage: "frc-code:test",
          simPortRange: { start: 25910, end: 25910 },
          vscodePortRange: { start: 33100, end: 33100 },
        },
      );
    } finally {
      for (const server of nt4Servers) {
        server.stop(true);
      }
    }
  });
});

describe("V2 code container status", () => {
  test("container status reports a single code container with dual ports", async () => {
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
          code: {
            role: "code",
            state: "running",
            image: "frc-code:test",
            simPortAllocated: true,
            vscodePortAllocated: true,
            error: null,
          },
        });
        expect(body.code.containerName).toBe(`frc-v2-code-${workspace.id}`);

        const lease = app.storage.getContainerLease(workspace.id);
        expect(lease).toMatchObject({
          vscode_container: `frc-v2-code-${workspace.id}`,
          vscode_port: 33110,
          code_state: "running",
        });
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25950, end: 25950 },
        vscodePortRange: { start: 33110, end: 33110 },
      },
    );
  });
});

describe("V2 idle teardown, recovery, and operator controls", () => {
  test("heartbeat touches container lease activity", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        const response = await login(app, "alice");
        const cookie = cookieFrom(response);
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);

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
        codeImage: "frc-code:test",
        simPortRange: { start: 25980, end: 25980 },
        vscodePortRange: { start: 33120, end: 33120 },
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

  test("admin can restart a code container", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/restart-code`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("restart-code");

        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25981, end: 25982 },
        vscodePortRange: { start: 33121, end: 33122 },
      },
    );
  });

  test("admin can stop all containers for a workspace", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/stop-containers`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; action: string };
        expect(body.ok).toBe(true);
        expect(body.action).toBe("stop-containers");

        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25987, end: 25988 },
        vscodePortRange: { start: 33127, end: 33128 },
      },
    );
  });

  test("admin returns 404 for unknown workspace", async () => {
    await withApp(async (app) => {
      await login(app, "alice");

      const response = await app.fetch(
        new Request("http://localhost/admin/workspaces/ws_0000000000000000deadbeef00000000/restart-code", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  test("admin seed-template copies template into an empty workspace project directory", async () => {
    await withApp(async (app) => {
      await login(app, "alice");
      const workspace = workspaceBySlug(app, "alice");
      const projectPath = workspaceProjectPath(app, "alice");

      // The workspace is seeded on first login, so seed-template should return 409.
      const conflict = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/seed-template`, {
          method: "POST",
        }),
      );
      expect(conflict.status).toBe(409);

      // Clear the project directory contents.
      const { rm: rmFs } = await import("node:fs/promises");
      const entries = await readdir(projectPath);
      for (const entry of entries) {
        await rmFs(join(projectPath, entry), { recursive: true, force: true });
      }

      // Now seed-template should succeed.
      const response = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/seed-template`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string };
      expect(body.ok).toBe(true);
      expect(body.action).toBe("seed-template");

      // Verify the template was copied.
      expect(await exists(join(projectPath, "build.gradle"))).toBe(true);
      expect(await exists(join(projectPath, "src", "main", "java", "frc", "robot", "Robot.java"))).toBe(true);
    });
  });

  test("admin backup creates a backup of a workspace project", async () => {
    await withApp(async (app) => {
      await login(app, "alice");
      const workspace = workspaceBySlug(app, "alice");

      const response = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/backup`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string; detail: string };
      expect(body.ok).toBe(true);
      expect(body.action).toBe("backup");

      // Verify backup archive was created.
      const backupsDir = join(app.storage.config.dataDir, "backups");
      const backupDirs = await readdir(backupsDir);
      expect(backupDirs.length).toBeGreaterThan(0);

      const latestBackup = backupDirs.sort().at(-1)!;
      const backedUpProject = join(backupsDir, latestBackup, workspace.id, "project.tar.gz");
      expect(await exists(backedUpProject)).toBe(true);
    });
  });

  test("admin restore restores a workspace project from backup", async () => {
    await withApp(async (app) => {
      await login(app, "alice");
      const workspace = workspaceBySlug(app, "alice");
      const projectPath = workspaceProjectPath(app, "alice");

      // First backup.
      const backupResponse = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/backup`, {
          method: "POST",
        }),
      );
      expect(backupResponse.status).toBe(200);

      // Write a marker file into the project.
      await writeFile(join(projectPath, "src", "main", "java", "frc", "robot", "Marker.java"), "marker\n", "utf8");
      expect(await exists(join(projectPath, "src", "main", "java", "frc", "robot", "Marker.java"))).toBe(true);

      // Find backup path.
      const backupsDir = join(app.storage.config.dataDir, "backups");
      const backupDirs = await readdir(backupsDir);
      const latestBackup = backupDirs.sort().at(-1)!;
      const restorePath = join(backupsDir, latestBackup, workspace.id, "project.tar.gz");

      // Restore should overwrite project from backup (which has no Marker.java).
      const response = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: restorePath }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string };
      expect(body.ok).toBe(true);
      expect(body.action).toBe("restore");

      // The base template file should still exist.
      expect(await exists(join(projectPath, "build.gradle"))).toBe(true);
      expect(await exists(join(projectPath, "src", "main", "java", "frc", "robot", "Marker.java"))).toBe(false);
    });
  });

  test("admin restore rejects paths outside data/backups/", async () => {
    await withApp(async (app) => {
      await login(app, "alice");
      const workspace = workspaceBySlug(app, "alice");

      const response = await app.fetch(
        new Request(`http://localhost/admin/workspaces/${workspace.id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/tmp/evil" }),
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  test("removed file API routes return 404", async () => {
    await withApp(async (app) => {
      const response = await login(app, "alice");
      const cookie = cookieFrom(response);

      const fileRead = await app.fetch(
        new Request("http://localhost/u/alice/api/files?path=src/main/java/frc/robot/Robot.java", {
          headers: { cookie },
        }),
      );
      expect(fileRead.status).toBe(404);

      const treeRead = await app.fetch(
        new Request("http://localhost/u/alice/api/project/tree", {
          headers: { cookie },
        }),
      );
      expect(treeRead.status).toBe(404);
    });
  });

  test("idle sweep stops containers for idle workspaces", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);

        const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        app.storage.db
          .query("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?")
          .run(pastTime, workspace.id);

        const stopped = await app.idle.sweep();
        expect(stopped).toContain(workspace.id);

        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25989, end: 25990 },
        vscodePortRange: { start: 33129, end: 33130 },
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

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);

        const stopped = await app.idle.sweep();
        expect(stopped).not.toContain(workspace.id);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25991, end: 25992 },
        vscodePortRange: { start: 33131, end: 33132 },
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

        await app.containers.ensureCodeContainer(workspace);

        await app.containers.stopWorkspaceContainers(workspace.id);
        await app.containers.removeCodeContainer(workspace.id);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(false);

        expect(await exists(join(workspace.project_path, "src", "main", "java", "frc", "robot", "Robot.java"))).toBe(true);

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(true);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25993, end: 25994 },
        vscodePortRange: { start: 33133, end: 33134 },
      },
    );
  });

  test("cleanup removes stopped managed containers", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);
        await app.containers.stopCodeContainer(workspace.id);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(false);

        const removed = await app.containers.cleanupStoppedContainers();
        expect(removed).toContain(`frc-v2-code-${workspace.id}`);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(false);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25995, end: 25996 },
        vscodePortRange: { start: 33135, end: 33136 },
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
          app.containers.ensureCodeContainer(aliceWorkspace),
          app.containers.ensureCodeContainer(bobWorkspace),
        ]);

        expect(fakeDocker.containers.get(`frc-v2-code-${aliceWorkspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.get(`frc-v2-code-${bobWorkspace.id}`)?.running).toBe(true);

        const response = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${bobWorkspace.id}/restart-code`, {
            method: "POST",
          }),
        );
        expect(response.status).toBe(200);

        expect(fakeDocker.containers.get(`frc-v2-code-${aliceWorkspace.id}`)?.running).toBe(true);
        expect(fakeDocker.containers.get(`frc-v2-code-${bobWorkspace.id}`)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25800, end: 25809 },
        vscodePortRange: { start: 33140, end: 33149 },
      },
    );
  });
});

// --- V2 Stage 6: Lifecycle, labels, and reconciliation tests ---

describe("V2 Stage 6 reconciliation", () => {
  test("V1 LSP containers are cleaned up at startup", async () => {
    const fakeDocker = createFakeDocker();
    fakeDocker.containers.set("frc-v1-lsp-leftover", {
      name: "frc-v1-lsp-leftover",
      running: true,
      labels: {
        "frc-sim.managed": "true",
        "frc-sim.version": "v1",
        "frc-sim.role": "lsp",
        "frc-sim.workspace": "ws_00000000000000000000000000000001",
      },
      ports: [],
    });

    await withApp(
      async () => {
        expect(fakeDocker.containers.has("frc-v1-lsp-leftover")).toBe(false);
        expect(fakeDocker.calls).toContainEqual(["stop", "frc-v1-lsp-leftover"]);
        expect(fakeDocker.calls).toContainEqual(["rm", "-f", "frc-v1-lsp-leftover"]);
      },
      { dockerRunner: fakeDocker.runner },
    );
  });

  test("adoption rejects a container with non-loopback port bindings", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");
        const name = `frc-v2-code-${workspace.id}`;

        // Pre-create a container with a non-loopback (0.0.0.0) sim port
        fakeDocker.containers.set(name, {
          name,
          running: true,
          labels: {
            "frc-sim.managed": "true",
            "frc-sim.version": "v2",
            "frc-sim.role": "code",
            "frc-sim.workspace": workspace.id,
          },
          ports: [
            { hostPort: 25830, containerPort: 5810, hostIp: "0.0.0.0" },
            { hostPort: 33050, containerPort: 3000, hostIp: "127.0.0.1" },
          ],
        });

        const status = await app.containers.ensureCodeContainer(workspace);
        // The container with non-loopback ports should have been removed and a new one created
        expect(status.state).toBe("running");
        expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
        const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
        expect(runCalls.length).toBeGreaterThan(0);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25830, end: 25831 },
        vscodePortRange: { start: 33050, end: 33051 },
      },
    );
  });

  test("adoption rejects a container with mismatched labels", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");
        const name = `frc-v2-code-${workspace.id}`;

        // Pre-create a container with wrong version label
        fakeDocker.containers.set(name, {
          name,
          running: true,
          labels: {
            "frc-sim.managed": "true",
            "frc-sim.version": "v1",
            "frc-sim.role": "sim",
            "frc-sim.workspace": workspace.id,
          },
          ports: [
            { hostPort: 25832, containerPort: 5810, hostIp: "127.0.0.1" },
            { hostPort: 33052, containerPort: 3000, hostIp: "127.0.0.1" },
          ],
        });

        const status = await app.containers.ensureCodeContainer(workspace);
        expect(status.state).toBe("running");
        // The old mismatched container should have been removed
        expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
        // A new properly-labeled container should have been created
        const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
        expect(runCalls.length).toBeGreaterThan(0);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25832, end: 25833 },
        vscodePortRange: { start: 33052, end: 33053 },
      },
    );
  });

  test("adoption restarts a stopped V2 container instead of creating a new one", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");
        const name = `frc-v2-code-${workspace.id}`;

        // Pre-create a stopped container with correct labels
        fakeDocker.containers.set(name, {
          name,
          running: false,
          labels: {
            "frc-sim.managed": "true",
            "frc-sim.version": "v2",
            "frc-sim.role": "code",
            "frc-sim.workspace": workspace.id,
          },
          ports: [
            { hostPort: 25834, containerPort: 5810, hostIp: "127.0.0.1" },
            { hostPort: 33054, containerPort: 3000, hostIp: "127.0.0.1" },
          ],
        });

        const status = await app.containers.ensureCodeContainer(workspace);
        expect(status.state).toBe("running");
        // Should have started the existing container, not created a new one
        expect(fakeDocker.calls).toContainEqual(["start", name]);
        const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
        expect(runCalls.length).toBe(0);
        expect(fakeDocker.containers.get(name)?.running).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25834, end: 25835 },
        vscodePortRange: { start: 33054, end: 33055 },
      },
    );
  });

  test("lease row exists but container is missing triggers recreation", async () => {
    const fakeDocker = createFakeDocker();

    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");
        const name = `frc-v2-code-${workspace.id}`;

        // Create a lease row without a matching Docker container
        app.storage.upsertCodeContainerLease({
          workspaceId: workspace.id,
          containerName: name,
          simPort: 25836,
          vscodePort: 33056,
          state: "running",
        });

        // ensureCodeContainer should detect the missing container and recreate
        const status = await app.containers.ensureCodeContainer(workspace);
        expect(status.state).toBe("running");
        const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
        expect(runCalls.length).toBe(1);
        expect(fakeDocker.containers.has(name)).toBe(true);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25836, end: 25837 },
        vscodePortRange: { start: 33056, end: 33057 },
      },
    );
  });

  test("idle teardown followed by reload preserves vscode user data directory", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        await login(app, "alice");
        const workspace = workspaceBySlug(app, "alice");

        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.get(`frc-v2-code-${workspace.id}`)?.running).toBe(true);

        // Write a file into the home directory (simulating vscode user data)
        const homePath = join(app.storage.config.dataDir, "users", workspace.id, "home");
        await mkdir(join(homePath, ".openvscode-server", "data", "User"), { recursive: true });
        await writeFile(
          join(homePath, ".openvscode-server", "data", "User", "settings.json"),
          '{"editor.fontSize": 16}',
          "utf8",
        );

        // Idle teardown
        await app.containers.stopWorkspaceContainers(workspace.id);
        await app.containers.removeCodeContainer(workspace.id);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(false);

        // Reload creates new container
        await app.containers.ensureCodeContainer(workspace);
        expect(fakeDocker.containers.has(`frc-v2-code-${workspace.id}`)).toBe(true);

        // User data should persist on the host (bind-mounted home)
        const settingsContent = await readFile(
          join(homePath, ".openvscode-server", "data", "User", "settings.json"),
          "utf8",
        );
        expect(settingsContent).toContain("editor.fontSize");
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 25838, end: 25839 },
        vscodePortRange: { start: 33058, end: 33059 },
      },
    );
  });
});

// --- V2 Stage 2: Editor proxy tests ---

describe("V2 Stage 2 editor proxy", () => {
  test("unauthenticated GET /u/<slug>/vscode/ returns redirect to /", async () => {
    await withApp(async (app) => {
      // Create a user so the workspace exists
      await login(app, "alice");

      // Request without cookie
      const response = await app.fetch(
        new Request("http://localhost/u/alice/vscode/", { method: "GET" }),
      );

      // page kind → 303 redirect to /
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    });
  });

  test("cross-workspace GET /u/<other>/vscode/ returns 403", async () => {
    await withApp(async (app) => {
      const aliceResponse = await login(app, "alice");
      const aliceCookie = cookieFrom(aliceResponse);

      // Create bob workspace
      await login(app, "bob");

      // Alice tries to access bob's vscode
      const response = await app.fetch(
        new Request("http://localhost/u/bob/vscode/", {
          method: "GET",
          headers: { cookie: aliceCookie },
        }),
      );

      expect(response.status).toBe(403);
    });
  });

  test("authenticated GET /u/<slug>/vscode/ returns an error when the image is unavailable", async () => {
    const dockerRunner: DockerRunner = async () => missing("No such image");

    await withApp(
      async (app) => {
        const aliceResponse = await login(app, "alice");
        const aliceCookie = cookieFrom(aliceResponse);

        const response = await app.fetch(
          new Request("http://localhost/u/alice/vscode/", {
            method: "GET",
            headers: { cookie: aliceCookie },
          }),
        );

        expect(response.status).toBe(503);
        expect(await response.text()).toContain("CODE image");
      },
      { dockerRunner },
    );
  });

  test("authenticated GET /u/<slug>/vscode/ proxies to upstream when code container runs", async () => {
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                return new Response(`upstream hit: ${url.pathname}`, {
                  headers: {
                    "content-type": "text/plain",
                    "x-upstream-marker": "openvscode-test",
                  },
                });
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/?folder=/workspace/project", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain("upstream hit: /u/alice/vscode/");
          expect(response.headers.get("x-upstream-marker")).toBe("openvscode-test");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25920, end: 25920 },
          vscodePortRange: { start: 33200, end: 33200 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("authenticated GET /u/<slug>/vscode/ waits for upstream readiness", async () => {
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          setTimeout(() => {
            upstreamServers.push(
              Bun.serve({
                port: vscodePort.hostPort,
                hostname: "127.0.0.1",
                fetch() {
                  return new Response("delayed editor ready", {
                    headers: { "content-type": "text/plain" },
                  });
                },
              }),
            );
          }, 150);
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);
          const startedAt = Date.now();

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(response.status).toBe(200);
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
          expect(await response.text()).toBe("delayed editor ready");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25924, end: 25924 },
          vscodePortRange: { start: 33204, end: 33204 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("hop-by-hop headers are stripped from proxy requests", async () => {
    let receivedHeaders: Record<string, string> = {};
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                receivedHeaders = {};
                request.headers.forEach((value, key) => {
                  receivedHeaders[key] = value;
                });
                return new Response("ok", {
                  headers: {
                    "content-type": "text/plain",
                    "connection": "keep-alive",
                    "keep-alive": "timeout=5",
                    "transfer-encoding": "chunked",
                    "x-real-header": "should-pass",
                  },
                });
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/", {
              method: "GET",
              headers: {
                cookie: aliceCookie,
                connection: "keep-alive, x-custom-hop",
                "keep-alive": "timeout=5",
                "proxy-authorization": "Basic abc",
                "x-custom-hop": "should-be-stripped",
                "x-normal-header": "should-pass-through",
              },
            }),
          );

          expect(response.status).toBe(200);

          expect(receivedHeaders["proxy-authorization"]).toBeUndefined();
          expect(receivedHeaders["x-custom-hop"]).toBeUndefined();
          expect(receivedHeaders["x-normal-header"]).toBe("should-pass-through");

          expect(response.headers.get("connection")).toBeNull();
          expect(response.headers.get("keep-alive")).toBeNull();
          expect(response.headers.get("transfer-encoding")).toBeNull();
          expect(response.headers.get("x-real-header")).toBe("should-pass");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25921, end: 25921 },
          vscodePortRange: { start: 33201, end: 33201 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("vscode proxy passes query strings through", async () => {
    let receivedPath = "";
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                receivedPath = url.pathname + url.search;
                return new Response("ok");
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          await app.fetch(
            new Request("http://localhost/u/alice/vscode/?folder=/workspace/project&some=extra", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(receivedPath).toBe("/u/alice/vscode/?folder=/workspace/project&some=extra");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25922, end: 25922 },
          vscodePortRange: { start: 33202, end: 33202 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("vscode proxy handles sub-paths correctly", async () => {
    let receivedPath = "";
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                receivedPath = url.pathname;
                return new Response("ok");
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          await app.fetch(
            new Request("http://localhost/u/alice/vscode/static/workbench.js", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(receivedPath).toBe("/u/alice/vscode/static/workbench.js");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25923, end: 25923 },
          vscodePortRange: { start: 33203, end: 33203 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });
});

describe("V2 Stage 2 stripHopByHopHeaders", () => {
  test("removes standard hop-by-hop headers", async () => {
    const { stripHopByHopHeaders } = await import("./app");

    const source = new Headers({
      "connection": "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic abc",
      "te": "gzip",
      "trailer": "Expires",
      "transfer-encoding": "chunked",
      "upgrade": "websocket",
      "content-type": "text/html",
      "x-custom": "value",
    });

    const result = stripHopByHopHeaders(source);

    expect(result.get("connection")).toBeNull();
    expect(result.get("keep-alive")).toBeNull();
    expect(result.get("proxy-authenticate")).toBeNull();
    expect(result.get("proxy-authorization")).toBeNull();
    expect(result.get("te")).toBeNull();
    expect(result.get("trailer")).toBeNull();
    expect(result.get("transfer-encoding")).toBeNull();
    expect(result.get("upgrade")).toBeNull();
    expect(result.get("content-type")).toBe("text/html");
    expect(result.get("x-custom")).toBe("value");
  });

  test("removes headers listed in Connection header", async () => {
    const { stripHopByHopHeaders } = await import("./app");

    const source = new Headers({
      "connection": "keep-alive, x-my-hop",
      "x-my-hop": "should-be-stripped",
      "x-normal": "should-remain",
    });

    const result = stripHopByHopHeaders(source);

    expect(result.get("connection")).toBeNull();
    expect(result.get("x-my-hop")).toBeNull();
    expect(result.get("x-normal")).toBe("should-remain");
  });

  test("handles empty headers", async () => {
    const { stripHopByHopHeaders } = await import("./app");

    const source = new Headers();
    const result = stripHopByHopHeaders(source);
    expect([...result.keys()].length).toBe(0);
  });
});
