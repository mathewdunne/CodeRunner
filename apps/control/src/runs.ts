import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunServerMessage, WorkspaceId } from "@frc-sim/contracts";
import type { ContainerOrchestrator } from "./containers";
import type { AppStorage, WorkspaceRow } from "./storage";

type RunExit = {
  code: number | null;
  signal: string | null;
};

export type RunCommand = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<RunExit>;
  kill(signal?: string): void;
};

export type RunCommandContext = {
  workspace: WorkspaceRow;
  containerName: string;
  dockerPath: string;
};

export type RunCommandFactory = (context: RunCommandContext) => RunCommand;

export type RunConnection = {
  id: string;
  workspaceId: WorkspaceId;
  send(message: RunServerMessage): void;
};

type RunJob = {
  id: string;
  workspace: WorkspaceRow;
  state: "building" | "running" | "failed" | "stopped";
  logPath: string;
  clients: Set<RunConnection>;
  command: RunCommand | null;
  canceled: boolean;
  reportedRunning: boolean;
  buildSlotHeld: boolean;
  finished: boolean;
  readinessTimer: ReturnType<typeof setTimeout> | null;
};

type RunManagerOptions = {
  commandFactory?: RunCommandFactory | undefined;
};

function randomRunId(): string {
  return `run_${randomBytes(16).toString("hex")}`;
}

function runLogPath(workspace: WorkspaceRow, runId: string): string {
  return resolve(dirname(workspace.project_path), "logs", "runs", `${runId}.log`);
}

function lineLooksReady(line: string): boolean {
  return /\b(nt4|networktables)\b/i.test(line) || /listening.+5810/i.test(line);
}

function dockerRunScript(): string {
  return [
    "set -euo pipefail",
    "log_file=\"${SIM_LOG_FILE:-$HOME/sim.log}\"",
    "pid_file=\"${SIM_PID_FILE:-$HOME/sim.pid}\"",
    "trap '/usr/local/bin/stop-sim.sh >/dev/null 2>&1 || true' TERM INT",
    "/usr/local/bin/stop-sim.sh || true",
    "/usr/local/bin/start-sim.sh",
    "pid=\"$(cat \"$pid_file\")\"",
    "tail --pid=\"$pid\" -n +1 -F \"$log_file\"",
    "if grep -q \"BUILD FAILED\" \"$log_file\" 2>/dev/null; then exit 1; fi",
  ].join("\n");
}

export function defaultRunCommandFactory(context: RunCommandContext): RunCommand {
  const subprocess = Bun.spawn(
    [context.dockerPath, "exec", context.containerName, "bash", "-lc", dockerRunScript()],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  let stopRequested = false;

  return {
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited.then((code) => ({ code, signal: null })),
    kill(signal = "SIGTERM") {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      const forwardedSignal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";

      const stop = Bun.spawn([context.dockerPath, "exec", context.containerName, "/usr/local/bin/stop-sim.sh"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      void stop.exited.finally(() => {
        try {
          subprocess.kill(forwardedSignal);
        } catch {
          // The docker exec wrapper may have exited naturally after the sim stopped.
        }
      });

      const fallback = setTimeout(() => {
        try {
          subprocess.kill(forwardedSignal);
        } catch {
          // best effort
        }
      }, 12_000);
      fallback.unref?.();
    },
  };
}

async function consumeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffered += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const newline = buffered.search(/\r?\n/u);
      if (newline < 0) {
        break;
      }
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(buffered[newline] === "\r" ? newline + 2 : newline + 1);
      await onLine(line);
    }
  }

  buffered += decoder.decode();
  if (buffered.length > 0) {
    await onLine(buffered);
  }
}

export class RunManager {
  private readonly commandFactory: RunCommandFactory;
  private readonly activeBuilds = new Set<string>();
  private readonly jobsByWorkspace = new Map<WorkspaceId, RunJob>();

  constructor(
    private readonly storage: AppStorage,
    private readonly containers: ContainerOrchestrator,
    options: RunManagerOptions = {},
  ) {
    this.commandFactory = options.commandFactory ?? defaultRunCommandFactory;
  }

  connect(workspace: WorkspaceRow, send: (message: RunServerMessage) => void): RunConnection {
    const connection: RunConnection = {
      id: randomBytes(8).toString("hex"),
      workspaceId: workspace.id,
      send,
    };
    const current = this.jobsByWorkspace.get(workspace.id) ?? null;
    if (current) {
      current.clients.add(connection);
    }

    connection.send({
      type: "hello",
      runId: current?.id ?? "idle",
    });
    if (current) {
      this.sendCurrentStatus(current, connection);
    }
    return connection;
  }

  disconnect(connection: RunConnection): void {
    const current = this.jobsByWorkspace.get(connection.workspaceId);
    current?.clients.delete(connection);
  }

  activeBuildCount(): number {
    return this.activeBuilds.size;
  }

  start(workspace: WorkspaceRow, connection?: RunConnection | null): string {
    this.cancelWorkspace(workspace.id);

    const runId = randomRunId();
    const logPath = runLogPath(workspace, runId);
    const job: RunJob = {
      id: runId,
      workspace,
      state: "building",
      logPath,
      clients: new Set(connection ? [connection] : []),
      command: null,
      canceled: false,
      reportedRunning: false,
      buildSlotHeld: false,
      finished: false,
      readinessTimer: null,
    };

    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `Run ${runId} requested for workspace ${workspace.slug}\n`, "utf8");
    this.storage.createRunJob({ id: runId, workspaceId: workspace.id, logPath });
    this.jobsByWorkspace.set(workspace.id, job);
    this.activeBuilds.add(job.id);
    job.buildSlotHeld = true;
    void this.runJob(job);
    return runId;
  }

  stopWorkspace(workspaceId: WorkspaceId): boolean {
    return this.cancelWorkspace(workspaceId);
  }

  private stopContainerSim(workspaceId: WorkspaceId): void {
    void this.containers.stopWorkspaceSim(workspaceId).catch(() => {
      // Best effort. The run job still transitions through command exit, and
      // stale/missing containers are surfaced by container status endpoints.
    });
  }

  private cancelWorkspace(workspaceId: WorkspaceId): boolean {
    const job = this.jobsByWorkspace.get(workspaceId);
    if (!job) {
      this.stopContainerSim(workspaceId);
      return false;
    }

    job.canceled = true;
    this.broadcast(job, { type: "status", status: "stopping" });
    this.stopContainerSim(workspaceId);
    job.command?.kill("SIGTERM");
    return true;
  }

  private async runJob(job: RunJob): Promise<void> {
    try {
      this.setJobState(job, "building", { started: true });
      this.broadcast(job, { type: "status", status: "building" });
      if (job.canceled) {
        this.finishJob(job, "stopped", null);
        return;
      }

      const code = await this.containers.ensureCodeContainer(job.workspace);
      if (code.state !== "running" || !code.containerName) {
        throw new Error(code.error ?? "Code container is not running.");
      }
      if (job.canceled) {
        this.finishJob(job, "stopped", null);
        return;
      }

      const command = this.commandFactory({
        workspace: job.workspace,
        containerName: code.containerName,
        dockerPath: this.storage.config.dockerPath,
      });
      job.command = command;
      this.armReadinessTimeout(job);

      const stdoutDone = consumeLines(command.stdout, (line) => this.recordLog(job, "stdout", line));
      const stderrDone = consumeLines(command.stderr, (line) => this.recordLog(job, "stderr", line));
      const exit = await command.exited;
      await Promise.all([stdoutDone, stderrDone]);

      if (job.finished) {
        return;
      }

      if (job.canceled) {
        this.finishJob(job, "stopped", null, exit.signal);
      } else if (exit.code === 0) {
        this.finishJob(job, job.reportedRunning ? "stopped" : "failed", exit.code, exit.signal);
      } else {
        this.finishJob(job, "failed", exit.code, exit.signal);
      }
    } catch (error) {
      await this.recordLog(job, "stderr", error instanceof Error ? error.message : "Run failed.");
      this.finishJob(job, job.canceled ? "stopped" : "failed", null);
    } finally {
      this.releaseBuildSlot(job);
    }
  }

  private armReadinessTimeout(job: RunJob): void {
    const timeoutMs = this.storage.config.runBuildTimeoutMs + this.storage.config.simStartupTimeoutMs;
    job.readinessTimer = setTimeout(() => {
      void this.timeoutBeforeReadiness(job, timeoutMs);
    }, timeoutMs);
  }

  private async timeoutBeforeReadiness(job: RunJob, timeoutMs: number): Promise<void> {
    if (job.finished || job.reportedRunning) {
      return;
    }

    job.canceled = true;
    await this.recordLog(
      job,
      "stderr",
      `Run timed out before simulator readiness after ${Math.round(timeoutMs / 1000)} seconds.`,
    );
    job.command?.kill("SIGTERM");
    this.finishJob(job, "failed", null);
  }

  private async recordLog(job: RunJob, stream: "stdout" | "stderr" | "sim", line: string): Promise<void> {
    await appendFile(job.logPath, `[${stream}] ${line}\n`, "utf8").catch(() => {
      // The browser still gets the log line; disk-full recovery is handled by the operator path in later phases.
    });
    this.broadcast(job, { type: "log", stream, line });

    if (!job.finished && !job.canceled && !job.reportedRunning && lineLooksReady(line)) {
      job.reportedRunning = true;
      this.setJobState(job, "running");
      this.broadcast(job, { type: "status", status: "running" });
      this.releaseBuildSlot(job);
    }
  }

  private releaseBuildSlot(job: RunJob): void {
    if (job.readinessTimer !== null) {
      clearTimeout(job.readinessTimer);
      job.readinessTimer = null;
    }
    if (!job.buildSlotHeld) {
      return;
    }

    job.buildSlotHeld = false;
    this.activeBuilds.delete(job.id);
  }

  private setJobState(
    job: RunJob,
    state: RunJob["state"],
    flags: { started?: boolean; finished?: boolean; exitCode?: number | null } = {},
  ): void {
    job.state = state;
    const update: {
      id: string;
      state: RunJob["state"];
      started?: boolean;
      finished?: boolean;
      exitCode?: number | null;
    } = {
      id: job.id,
      state,
    };
    if (flags.started !== undefined) {
      update.started = flags.started;
    }
    if (flags.finished !== undefined) {
      update.finished = flags.finished;
    }
    if (flags.exitCode !== undefined) {
      update.exitCode = flags.exitCode;
    }
    this.storage.updateRunJob(update);
  }

  private finishJob(job: RunJob, state: "failed" | "stopped", code: number | null, signal: string | null = null): void {
    if (job.finished) {
      return;
    }
    job.finished = true;
    this.releaseBuildSlot(job);
    this.setJobState(job, state, { finished: true, exitCode: code });
    this.broadcast(job, { type: "status", status: state });
    this.broadcast(job, { type: "exit", code, signal });
    if (this.jobsByWorkspace.get(job.workspace.id)?.id === job.id) {
      this.jobsByWorkspace.delete(job.workspace.id);
    }
  }

  private sendCurrentStatus(job: RunJob, connection: RunConnection): void {
    connection.send({ type: "status", status: job.state });
  }

  private broadcast(job: RunJob, message: RunServerMessage): void {
    for (const client of job.clients) {
      client.send(message);
    }
  }
}
