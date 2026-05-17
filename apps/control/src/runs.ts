import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	RunServerMessage,
	SimRunStatus,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import { getLogger } from "./logging";
import { runActiveDuration, runBuildDuration, runsTotal } from "./metrics";
import type {
	WorkspaceRuntime,
	WorkspaceRuntimeCommand,
	WorkspaceRuntimeProvider,
} from "./runtime";
import type { AppStorage, WorkspaceRow } from "./storage";

const log = getLogger("runs");

export type RunCommand = WorkspaceRuntimeCommand;

export type RunCommandContext = {
	workspace: WorkspaceRow;
	runtime: WorkspaceRuntime;
	runtimeProvider: WorkspaceRuntimeProvider;
	/** @deprecated Use runtime.runtimeName; retained for narrow test compatibility during the provider refactor. */
	containerName: string;
	/** @deprecated Runtime providers own command execution; retained for narrow test compatibility during the provider refactor. */
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
	buildStartedAtMs: number | null;
	runningSinceMs: number | null;
};

export type RunSnapshot = {
	status: SimRunStatus;
	runId: string | null;
};

type RunManagerOptions = {
	commandFactory?: RunCommandFactory | undefined;
};

function randomRunId(): string {
	return `run_${randomBytes(16).toString("hex")}`;
}

function runLogPath(workspace: WorkspaceRow, runId: string): string {
	return resolve(
		dirname(workspace.project_path),
		"logs",
		"runs",
		`${runId}.log`,
	);
}

function lineLooksReady(line: string): boolean {
	return /\b(nt4|networktables)\b/i.test(line) || /listening.+5810/i.test(line);
}

function dockerRunScript(): string {
	return [
		"set -euo pipefail",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS template literal
		'log_file="${SIM_LOG_FILE:-$HOME/sim.log}"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS template literal
		'pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"',
		"trap '/usr/local/bin/stop-sim.sh >/dev/null 2>&1 || true' TERM INT",
		"/usr/local/bin/stop-sim.sh || true",
		"/usr/local/bin/start-sim.sh",
		'pid="$(cat "$pid_file")"',
		'tail --pid="$pid" -n +1 -F "$log_file"',
		'if grep -q "BUILD FAILED" "$log_file" 2>/dev/null; then exit 1; fi',
	].join("\n");
}

export function defaultRunCommandFactory(
	context: RunCommandContext,
): RunCommand {
	return context.runtimeProvider.execStream(context.workspace.id, [
		"bash",
		"-lc",
		dockerRunScript(),
	]);
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
			buffered = buffered.slice(
				buffered[newline] === "\r" ? newline + 2 : newline + 1,
			);
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
	private readonly lastStatusByWorkspace = new Map<WorkspaceId, RunSnapshot>();
	private readonly connectionsByWorkspace = new Map<
		WorkspaceId,
		Set<RunConnection>
	>();

	constructor(
		private readonly storage: AppStorage,
		private readonly runtimeProvider: WorkspaceRuntimeProvider,
		options: RunManagerOptions = {},
	) {
		this.commandFactory = options.commandFactory ?? defaultRunCommandFactory;
	}

	connect(
		workspace: WorkspaceRow,
		send: (message: RunServerMessage) => void,
	): RunConnection {
		const connection: RunConnection = {
			id: randomBytes(8).toString("hex"),
			workspaceId: workspace.id,
			send,
		};
		const current = this.jobsByWorkspace.get(workspace.id) ?? null;
		let workspaceConnections = this.connectionsByWorkspace.get(workspace.id);
		if (!workspaceConnections) {
			workspaceConnections = new Set<RunConnection>();
			this.connectionsByWorkspace.set(workspace.id, workspaceConnections);
		}
		workspaceConnections.add(connection);
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
		const workspaceConnections = this.connectionsByWorkspace.get(
			connection.workspaceId,
		);
		workspaceConnections?.delete(connection);
		if (workspaceConnections?.size === 0) {
			this.connectionsByWorkspace.delete(connection.workspaceId);
		}
		const current = this.jobsByWorkspace.get(connection.workspaceId);
		current?.clients.delete(connection);
	}

	activeBuildCount(): number {
		return this.activeBuilds.size;
	}

	reconcileOrphanedRuns(): number {
		const orphaned = this.storage.listOrphanableRunJobs();
		let reconciled = 0;
		for (const row of orphaned) {
			if (this.jobsByWorkspace.has(row.workspace_id)) {
				continue;
			}
			this.storage.updateRunJob({
				id: row.id,
				state: "stopped",
				finished: true,
				exitCode: null,
			});
			this.lastStatusByWorkspace.set(row.workspace_id, {
				status: "stopped",
				runId: row.id,
			});
			this.stopContainerSim(row.workspace_id);
			reconciled += 1;
		}
		return reconciled;
	}

	getWorkspaceSnapshot(workspaceId: WorkspaceId): RunSnapshot {
		const current = this.jobsByWorkspace.get(workspaceId);
		if (current) {
			return {
				status:
					current.canceled && !current.finished ? "stopping" : current.state,
				runId: current.id,
			};
		}

		const recent = this.lastStatusByWorkspace.get(workspaceId);
		if (recent) {
			return recent;
		}

		const row = this.storage.getLatestRunJobForWorkspace(workspaceId);
		if (row) {
			return {
				status: row.state,
				runId: row.id,
			};
		}

		return { status: "idle", runId: null };
	}

	start(workspace: WorkspaceRow, connection?: RunConnection | null): string {
		this.cancelWorkspace(workspace.id);

		const runId = randomRunId();
		const logPath = runLogPath(workspace, runId);
		const existingConnections =
			this.connectionsByWorkspace.get(workspace.id) ?? new Set<RunConnection>();
		const job: RunJob = {
			id: runId,
			workspace,
			state: "building",
			logPath,
			clients: new Set(
				connection ? [...existingConnections, connection] : existingConnections,
			),
			command: null,
			canceled: false,
			reportedRunning: false,
			buildSlotHeld: false,
			finished: false,
			readinessTimer: null,
			buildStartedAtMs: null,
			runningSinceMs: null,
		};

		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(
			logPath,
			`Run ${runId} requested for workspace ${workspace.slug}\n`,
			"utf8",
		);
		this.storage.createRunJob({
			id: runId,
			workspaceId: workspace.id,
			logPath,
		});
		this.jobsByWorkspace.set(workspace.id, job);
		this.rememberStatus(job, "building");
		this.activeBuilds.add(job.id);
		job.buildSlotHeld = true;
		log.info("run queued", {
			workspaceId: workspace.id,
			runId,
			slug: workspace.slug,
		});
		void this.runJob(job);
		return runId;
	}

	stopWorkspace(workspaceId: WorkspaceId): boolean {
		return this.cancelWorkspace(workspaceId);
	}

	private stopContainerSim(workspaceId: WorkspaceId): void {
		void this.runtimeProvider
			.exec(workspaceId, ["/usr/local/bin/stop-sim.sh"])
			.catch((err) => {
				// Best effort. The run job still transitions through command exit, and
				// stale/missing runtimes are surfaced by runtime status endpoints.
				log.debug("stop-sim best-effort failed", {
					workspaceId,
					err: err as unknown,
				});
			});
	}

	private cancelWorkspace(workspaceId: WorkspaceId): boolean {
		const job = this.jobsByWorkspace.get(workspaceId);
		if (!job) {
			this.stopContainerSim(workspaceId);
			this.lastStatusByWorkspace.set(workspaceId, {
				status: "stopped",
				runId: null,
			});
			return false;
		}

		job.canceled = true;
		this.rememberStatus(job, "stopping");
		this.broadcast(job, { type: "status", status: "stopping" });
		log.info("run canceling", { workspaceId, runId: job.id });
		this.stopContainerSim(workspaceId);
		job.command?.kill("SIGTERM");
		return true;
	}

	private async runJob(job: RunJob): Promise<void> {
		const startedAt = performance.now();
		job.buildStartedAtMs = startedAt;
		try {
			this.setJobState(job, "building", { started: true });
			this.broadcast(job, { type: "status", status: "building" });
			log.info("build started", {
				workspaceId: job.workspace.id,
				runId: job.id,
			});
			if (job.canceled) {
				this.finishJob(job, "stopped", null);
				return;
			}

			const runtime = await this.runtimeProvider.ensureWorkspaceRunning(
				job.workspace.id,
			);
			if (runtime.state !== "running") {
				log.error("workspace runtime not running", {
					workspaceId: job.workspace.id,
					runId: job.id,
					state: runtime.state,
					err: new Error(runtime.error ?? "Workspace runtime is not running."),
				});
				throw new Error(runtime.error ?? "Workspace runtime is not running.");
			}
			if (job.canceled) {
				this.finishJob(job, "stopped", null);
				return;
			}

			const command = this.commandFactory({
				workspace: job.workspace,
				runtime,
				runtimeProvider: this.runtimeProvider,
				containerName: runtime.runtimeName ?? "",
				dockerPath: this.storage.config.dockerPath,
			});
			job.command = command;
			this.armReadinessTimeout(job);

			const stdoutDone = consumeLines(command.stdout, (line) =>
				this.recordLog(job, "stdout", line),
			);
			const stderrDone = consumeLines(command.stderr, (line) =>
				this.recordLog(job, "stderr", line),
			);
			const exit = await command.exited;
			await Promise.all([stdoutDone, stderrDone]);

			if (job.finished) {
				return;
			}

			const durationMs = Math.round(performance.now() - startedAt);
			if (job.canceled) {
				log.info("run finished", {
					workspaceId: job.workspace.id,
					runId: job.id,
					status: "stopped",
					durationMs,
					signal: exit.signal,
				});
				this.finishJob(job, "stopped", null, exit.signal);
			} else if (exit.code === 0) {
				const status = job.reportedRunning ? "stopped" : "failed";
				log.info("run finished", {
					workspaceId: job.workspace.id,
					runId: job.id,
					status,
					durationMs,
					exitCode: exit.code,
					signal: exit.signal,
				});
				this.finishJob(job, status, exit.code, exit.signal);
			} else {
				log.warn("run finished", {
					workspaceId: job.workspace.id,
					runId: job.id,
					status: "failed",
					durationMs,
					exitCode: exit.code,
					signal: exit.signal,
				});
				this.finishJob(job, "failed", exit.code, exit.signal);
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			log.error("run threw", {
				workspaceId: job.workspace.id,
				runId: job.id,
				err,
			});
			await this.recordLog(job, "stderr", err.message);
			this.finishJob(job, job.canceled ? "stopped" : "failed", null);
		} finally {
			this.releaseBuildSlot(job);
		}
	}

	private armReadinessTimeout(job: RunJob): void {
		const timeoutMs =
			this.storage.config.runBuildTimeoutMs +
			this.storage.config.simStartupTimeoutMs;
		job.readinessTimer = setTimeout(() => {
			void this.timeoutBeforeReadiness(job, timeoutMs);
		}, timeoutMs);
	}

	private async timeoutBeforeReadiness(
		job: RunJob,
		timeoutMs: number,
	): Promise<void> {
		if (job.finished || job.reportedRunning) {
			return;
		}

		log.warn("run timed out before readiness", {
			workspaceId: job.workspace.id,
			runId: job.id,
			timeoutMs,
		});
		job.canceled = true;
		await this.recordLog(
			job,
			"stderr",
			`Run timed out before simulator readiness after ${Math.round(timeoutMs / 1000)} seconds.`,
		);
		job.command?.kill("SIGTERM");
		this.finishJob(job, "failed", null);
	}

	private async recordLog(
		job: RunJob,
		stream: "stdout" | "stderr" | "sim",
		line: string,
	): Promise<void> {
		await appendFile(job.logPath, `[${stream}] ${line}\n`, "utf8").catch(
			(err: unknown) => {
				// The browser still gets the log line; disk-full recovery is handled by the operator path in later phases.
				log.warn("failed to append run log line to disk", {
					workspaceId: job.workspace.id,
					runId: job.id,
					logPath: job.logPath,
					err: err instanceof Error ? err : new Error(String(err)),
				});
			},
		);
		log.trace("run log line", { runId: job.id, stream, line });
		this.broadcast(job, { type: "log", stream, line });

		if (
			!job.finished &&
			!job.canceled &&
			!job.reportedRunning &&
			lineLooksReady(line)
		) {
			job.reportedRunning = true;
			const now = performance.now();
			job.runningSinceMs = now;
			if (job.buildStartedAtMs !== null) {
				runBuildDuration.observe((now - job.buildStartedAtMs) / 1000);
			}
			this.setJobState(job, "running");
			log.info("sim started", { workspaceId: job.workspace.id, runId: job.id });
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
		flags: {
			started?: boolean;
			finished?: boolean;
			exitCode?: number | null;
		} = {},
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
		this.rememberStatus(job, state);
	}

	private finishJob(
		job: RunJob,
		state: "failed" | "stopped",
		code: number | null,
		signal: string | null = null,
	): void {
		if (job.finished) {
			return;
		}
		job.finished = true;
		this.releaseBuildSlot(job);
		this.setJobState(job, state, { finished: true, exitCode: code });
		this.rememberStatus(job, state);
		this.broadcast(job, { type: "status", status: state });
		this.broadcast(job, { type: "exit", code, signal });
		const terminalStatus = job.canceled ? "canceled" : state;
		runsTotal.inc({ terminal_status: terminalStatus });
		if (job.runningSinceMs !== null) {
			runActiveDuration.observe(
				{ terminal_status: terminalStatus },
				(performance.now() - job.runningSinceMs) / 1000,
			);
		}
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

	private rememberStatus(job: RunJob, status: SimRunStatus): void {
		this.lastStatusByWorkspace.set(job.workspace.id, {
			status,
			runId: status === "idle" ? null : job.id,
		});
	}
}
