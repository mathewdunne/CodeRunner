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

describe("code container orchestration", () => {
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
        expect(runCall).toContain(`type=bind,src=${join(app.storage.config.dataDir, "users", workspace.id, "home")},dst=/config`);
        expect(runCall).toContain("127.0.0.1:45910:5810");
        expect(runCall).toContain("127.0.0.1:46000:3000");
        expect(runCall).toContain("PUID=123");
        expect(runCall).toContain("PGID=456");

        const lease = app.storage.db.query("SELECT * FROM container_leases WHERE workspace_id = ?").get(workspace.id) as {
          vscode_container: string;
          nt4_port: number;
          vscode_port: number;
          code_state: string;
        };
        expect(lease).toMatchObject({
          vscode_container: expectedName,
          nt4_port: 45910,
          vscode_port: 46000,
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

  test("s6 service script launches openvscode-server as primary process", async () => {
    const serviceScript = await readFile(
      join(process.cwd(), "containers", "code", "root", "etc", "s6-overlay", "s6-rc.d", "svc-openvscode-server", "run"),
      "utf8",
    );
    expect(serviceScript).toContain("openvscode-server");
  });

  test("restarted control plane rediscovers a labeled code container", async () => {
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
      portAvailable: async () => true,
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
        expect(app.storage.getContainerLease(workspace.id)).toMatchObject({ nt4_port: 25817 });
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
