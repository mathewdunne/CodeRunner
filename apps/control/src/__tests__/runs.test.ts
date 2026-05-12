import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ControlAppOptions } from "../app";
import type { DockerRunner } from "../containers";
import type { RunCommandFactory } from "../runs";
import {
  cookieFrom,
  createAdvantageScopeDist,
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

describe("run lifecycle and log streaming", () => {
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

        await waitFor(() => controlled.commands.length === 2);
        expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
        expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
        expect(bobMessages).toContainEqual({ type: "status", status: "building" });

        controlled.commands[0]?.writeStdout("NT4 listening on 5810");
        controlled.commands[0]?.writeStdout("robot periodic tick");
        await waitFor(() => JSON.stringify(aliceMessages).includes("running"));

        const aliceRun = app.storage.getRunJob(aliceRunId);
        expect(aliceRun).toMatchObject({ state: "running", workspace_id: aliceWorkspace.id });
        expect(await readFile(aliceRun?.log_path ?? "", "utf8")).toContain("robot periodic tick");
        expect(app.storage.getRunJob(bobRunId)).toMatchObject({ state: "building" });
        expect(controlled.commands[0]?.killed).toBe(false);
        expect(app.runs.activeBuildCount()).toBe(1);

        app.runs.stopWorkspace(aliceWorkspace.id);
        expect(controlled.commands[0]?.killed).toBe(true);
        await waitFor(() => app.storage.getRunJob(aliceRunId)?.state === "stopped");
        expect(app.storage.getRunJob(aliceRunId)).toMatchObject({ state: "stopped", exit_code: null });
        app.runs.stopWorkspace(bobWorkspace.id);
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        codeImage: "frc-code:test",
        simPortRange: { start: 25820, end: 25829 },
        vscodePortRange: { start: 33020, end: 33029 },
      },
    );
  });

  test("times out a run that never reaches simulator readiness", async () => {
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

        await waitFor(() => controlled.commands.length === 2);
        await waitFor(() => controlled.commands[0]?.killed === true);
        expect(app.storage.getRunJob(aliceRunId)).toMatchObject({ state: "failed", exit_code: null });
        expect(JSON.stringify(aliceMessages)).toContain("timed out before simulator readiness");
        expect(controlled.commands[1]?.context.workspace.slug).toBe("bob");
        expect(bobMessages).toContainEqual({ type: "status", status: "building" });
        app.runs.stopWorkspace(bobWorkspace.id);
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        runBuildTimeoutMs: 20,
        simStartupTimeoutMs: 20,
        codeImage: "frc-code:test",
        simPortRange: { start: 25840, end: 25849 },
        vscodePortRange: { start: 33040, end: 33049 },
      },
    );
  });

  test("replaces an active run for the same workspace", async () => {
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
        await waitFor(() => controlled.commands.length === 1);
        const secondRunId = app.runs.start(workspace, connection);

        await waitFor(() => controlled.commands.length === 2);
        expect(firstRunId).not.toBe(secondRunId);
        expect(controlled.commands[0]?.context.workspace.slug).toBe("alice");
        expect(controlled.commands[0]?.killed).toBe(true);
        expect(controlled.commands[1]?.context.workspace.slug).toBe("alice");
        expect(app.storage.getRunJob(firstRunId)).toMatchObject({ state: "stopped" });
        expect(app.storage.getRunJob(secondRunId)).toMatchObject({ state: "building" });
      },
      {
        dockerRunner: fakeDocker.runner,
        runCommandFactory: controlled.commandFactory,
        codeImage: "frc-code:test",
        simPortRange: { start: 25830, end: 25839 },
        vscodePortRange: { start: 33030, end: 33039 },
      },
    );
  });

  test("control-plane startup marks persisted active runs as stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "frc-v2-control-restart-"));
    const fakeDocker = createFakeDocker();
    const templateDir = await createTemplate(root);
    const webDistDir = await createWebDist(root);
    const advantageScopeDistDir = await createAdvantageScopeDist(root);
    const dataDir = join(root, "data");
    const baseOptions: ControlAppOptions = {
      dataDir,
      templateDir,
      webDistDir,
      advantageScopeDistDir,
      sessionSecret: "test-session-secret",
      containerAutoStart: false,
      dockerRunner: fakeDocker.runner,
      portAvailable: async () => true,
      codeImage: "frc-code:test",
      simPortRange: { start: 25850, end: 25859 },
      vscodePortRange: { start: 33050, end: 33059 },
      halsimPortRange: { start: 34050, end: 34059 },
    };

    let app = await createApp(baseOptions);
    try {
      const loginResponse = await login(app, "alice");
      const cookie = cookieFrom(loginResponse);
      const workspace = workspaceBySlug(app, "alice");
      const run = app.storage.createRunJob({
        id: "run_orphaned",
        workspaceId: workspace.id,
        logPath: join(root, "orphaned.log"),
      });
      app.storage.updateRunJob({ id: run.id, state: "running", started: true });
      app.close();

      app = await createApp(baseOptions);
      expect(app.storage.getRunJob(run.id)).toMatchObject({
        state: "stopped",
        exit_code: null,
      });
      expect(app.storage.getRunJob(run.id)?.finished_at).toBeTruthy();

      const response = await app.fetch(
        new Request("http://localhost/u/alice/api/sim/status", {
          headers: { cookie },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        run: { status: "stopped", runId: run.id },
      });
    } finally {
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
