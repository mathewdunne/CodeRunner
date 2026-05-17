import { mkdir } from "node:fs/promises";
import type { ContainersStatusResponse, WorkspaceId } from "@frc-sim/contracts";
import { getLogger } from "../logging";
import { containerStartDuration } from "../metrics";
import type {
	ExecOptions,
	ExecResult,
	ManagedWorkspaceRuntime,
	WorkspaceRuntime,
	WorkspaceRuntimeCommand,
	WorkspaceRuntimeProvider,
} from "../runtime";
import type { AppStorage, WorkspaceRow } from "../storage";
import { runtimeFromLease, statusFromLease } from "./converters";
import {
	dockerPortBindError,
	inspectContainer as inspectContainerCli,
	runDockerCli,
	runDocker as runDockerCommand,
} from "./docker-client";
import { CapacityExceededError } from "./errors";
import {
	cleanupStoppedContainers,
	countRunningContainers,
	managedContainerStats,
	removeCodeContainer,
	stopCodeContainer,
	stopWorkspaceContainers,
	stopWorkspaceSim,
} from "./lifecycle";
import {
	codeContainerName,
	containerRuntimeState,
	publishedPortFor,
	v2LabelsMatch,
	workspaceHomePath,
} from "./metadata";
import { allocatePortFromRange, portIsFree } from "./ports";
import {
	type CodeContainerStatus,
	type ContainerOrchestratorOptions,
	type DockerCommandResult,
	type DockerInspectContainer,
	type DockerRunner,
	HALSIM_CONTAINER_PORT,
	type ManagedContainerStats,
	SIM_CONTAINER_PORT,
	VSCODE_CONTAINER_PORT,
} from "./types";

const log = getLogger("containers");

export class LocalDockerRuntimeProvider implements WorkspaceRuntimeProvider {
	private readonly dockerRunner: DockerRunner;
	private readonly customDockerRunner: DockerRunner | null;
	private readonly portAvailable: (port: number) => Promise<boolean>;
	private readonly activeEnsures = new Map<
		string,
		Promise<CodeContainerStatus>
	>();
	private portReservationLock: Promise<void> = Promise.resolve();
	private admissionLock: Promise<void> = Promise.resolve();
	private pendingCreates = 0;

	constructor(
		private readonly storage: AppStorage,
		options: ContainerOrchestratorOptions = {},
	) {
		this.customDockerRunner = options.dockerRunner ?? null;
		this.dockerRunner =
			options.dockerRunner ??
			((args) => runDockerCli(this.storage.config.dockerPath, args));
		this.portAvailable = options.portAvailable ?? portIsFree;
	}

	startWorkspaceContainers(workspace: WorkspaceRow): void {
		if (!this.storage.config.containerAutoStart) {
			return;
		}

		void this.ensureCodeContainer(workspace).catch((err: unknown) => {
			// The status endpoint exposes startup failures; opening the IDE should not be blocked by Docker.
			log.warn("background ensureCodeContainer failed", {
				workspaceId: workspace.id,
				err: err instanceof Error ? err : new Error(String(err)),
			});
		});
	}

	async containersStatus(
		workspace: WorkspaceRow,
	): Promise<ContainersStatusResponse> {
		const code = await this.ensureCodeContainer(workspace);
		return {
			workspace: {
				id: workspace.id,
				slug: workspace.slug,
			},
			code,
		};
	}

	async ensureWorkspaceRunning(
		workspaceId: WorkspaceId,
	): Promise<WorkspaceRuntime> {
		const workspace = this.requireWorkspace(workspaceId);
		const code = await this.ensureCodeContainer(workspace);
		const lease = this.storage.getContainerLease(workspaceId);
		return runtimeFromLease(
			this.storage.config.codeImage,
			workspace,
			lease,
			code.state,
			code.error,
		);
	}

	async stopWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await stopWorkspaceContainers(this.storage, this.dockerRunner, workspaceId);
	}

	async restartWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceRuntime> {
		const workspace = this.requireWorkspace(workspaceId);
		const code = await this.restartCodeContainer(workspace);
		const lease = this.storage.getContainerLease(workspaceId);
		return runtimeFromLease(
			this.storage.config.codeImage,
			workspace,
			lease,
			code.state,
			code.error,
		);
	}

	async removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await removeCodeContainer(this.storage, this.dockerRunner, workspaceId);
	}

	async getWorkspaceStatus(
		workspaceId: WorkspaceId,
	): Promise<WorkspaceRuntime> {
		const workspace = this.requireWorkspace(workspaceId);
		const lease = this.storage.getContainerLease(workspaceId);
		const name = lease?.vscode_container ?? codeContainerName(workspaceId);
		const inspected = await this.inspectContainer(name);
		const state = inspected
			? containerRuntimeState(inspected)
			: (lease?.code_state ?? "missing");
		return runtimeFromLease(
			this.storage.config.codeImage,
			workspace,
			lease,
			state,
		);
	}

	async exec(
		workspaceId: WorkspaceId,
		command: string[],
		options: ExecOptions = {},
	): Promise<ExecResult> {
		const name = codeContainerName(workspaceId);
		if (!this.customDockerRunner) {
			return runDockerCli(
				this.storage.config.dockerPath,
				["exec", name, ...command],
				options,
			);
		}
		const run = this.runDocker(["exec", name, ...command], true);
		if (!options.timeoutMs) {
			return run;
		}
		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				run,
				new Promise<ExecResult>((resolveTimeout) => {
					timeout = setTimeout(() => {
						resolveTimeout({
							exitCode: 1,
							stdout: "",
							stderr: `Command timed out after ${Math.round(options.timeoutMs! / 1000)} seconds.`,
						});
					}, options.timeoutMs);
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	execStream(
		workspaceId: WorkspaceId,
		command: string[],
		options: ExecOptions = {},
	): WorkspaceRuntimeCommand {
		const name = codeContainerName(workspaceId);
		const subprocess = Bun.spawn(
			[this.storage.config.dockerPath, "exec", name, ...command],
			{
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		let timeout: ReturnType<typeof setTimeout> | null = null;
		if (options.timeoutMs) {
			timeout = setTimeout(() => {
				try {
					subprocess.kill("SIGTERM");
				} catch {
					// best effort
				}
			}, options.timeoutMs);
			timeout.unref?.();
		}
		return {
			stdout: subprocess.stdout,
			stderr: subprocess.stderr,
			exited: subprocess.exited.then((code) => {
				if (timeout) {
					clearTimeout(timeout);
				}
				return { code, signal: null };
			}),
			kill(signal = "SIGTERM") {
				try {
					subprocess.kill(signal as NodeJS.Signals);
				} catch {
					// best effort
				}
			},
		};
	}

	async listRuntimes(): Promise<ManagedWorkspaceRuntime[]> {
		return this.managedContainerStats();
	}

	async cleanupStoppedRuntimes(): Promise<string[]> {
		return this.cleanupStoppedContainers();
	}

	async countRunningWorkspaces(): Promise<number> {
		return this.countRunningContainers();
	}

	async stopCodeContainer(workspaceId: WorkspaceId): Promise<void> {
		await stopCodeContainer(this.storage, this.dockerRunner, workspaceId);
	}

	async stopWorkspaceSim(workspaceId: WorkspaceId): Promise<boolean> {
		return stopWorkspaceSim(this.dockerRunner, workspaceId);
	}

	async removeCodeContainer(workspaceId: WorkspaceId): Promise<void> {
		await removeCodeContainer(this.storage, this.dockerRunner, workspaceId);
	}

	async stopWorkspaceContainers(workspaceId: WorkspaceId): Promise<void> {
		await stopWorkspaceContainers(this.storage, this.dockerRunner, workspaceId);
	}

	async restartCodeContainer(
		workspace: WorkspaceRow,
	): Promise<CodeContainerStatus> {
		await this.stopCodeContainer(workspace.id);
		await this.removeCodeContainer(workspace.id);
		this.activeEnsures.delete(`code:${workspace.id}`);
		return this.ensureCodeContainer(workspace);
	}

	async countRunningContainers(): Promise<number> {
		return countRunningContainers(this.dockerRunner);
	}

	async cleanupStoppedContainers(): Promise<string[]> {
		return cleanupStoppedContainers(this.dockerRunner);
	}

	async managedContainerStats(): Promise<ManagedContainerStats[]> {
		return managedContainerStats(this.dockerRunner);
	}

	async ensureCodeContainer(
		workspace: WorkspaceRow,
	): Promise<CodeContainerStatus> {
		const key = `code:${workspace.id}`;
		const existing = this.activeEnsures.get(key);
		if (existing) {
			return existing;
		}

		const pending = this.ensureCodeContainerInner(workspace).catch((error) => {
			if (error instanceof CapacityExceededError) {
				throw error;
			}
			return this.recordError(workspace, error);
		});
		this.activeEnsures.set(key, pending);
		try {
			return await pending;
		} finally {
			this.activeEnsures.delete(key);
		}
	}

	private async runDocker(
		args: string[],
		allowFailure = false,
	): Promise<DockerCommandResult> {
		return runDockerCommand(this.dockerRunner, args, allowFailure);
	}

	private requireWorkspace(workspaceId: WorkspaceId): WorkspaceRow {
		const workspace = this.storage.findWorkspaceById(workspaceId);
		if (!workspace) {
			throw new Error(`Workspace ${workspaceId} not found.`);
		}
		return workspace;
	}

	private async inspectContainer(
		name: string,
	): Promise<DockerInspectContainer | null> {
		return inspectContainerCli(this.dockerRunner, name);
	}

	private async ensureImage(): Promise<void> {
		const image = this.storage.config.codeImage;
		const result = await this.runDocker(["image", "inspect", image], true);
		if (result.exitCode !== 0) {
			log.error("code image not available", { image });
			throw new Error(
				`CODE image ${image} is not available. Build it with bun run docker:build:code.`,
			);
		}
	}

	private async withPortReservationLock<T>(
		action: () => Promise<T>,
	): Promise<T> {
		const previous = this.portReservationLock;
		let release!: () => void;
		this.portReservationLock = new Promise<void>((resolveLock) => {
			release = resolveLock;
		});

		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}

	private async reserveCodePorts(
		workspace: WorkspaceRow,
		rejectedSimPorts: Set<number>,
		rejectedVscodePorts: Set<number>,
		rejectedHalsimPorts: Set<number>,
	): Promise<{ simPort: number; vscodePort: number; halsimPort: number }> {
		return await this.withPortReservationLock(async () => {
			const lease = this.storage.getContainerLease(workspace.id);
			const simPort = await allocatePortFromRange(
				this.storage,
				this.portAvailable,
				"sim",
				workspace.id,
				lease?.nt4_port ?? null,
				rejectedSimPorts,
			);
			const vscodePort = await allocatePortFromRange(
				this.storage,
				this.portAvailable,
				"code",
				workspace.id,
				lease?.vscode_port ?? null,
				rejectedVscodePorts,
			);
			const halsimPort = await allocatePortFromRange(
				this.storage,
				this.portAvailable,
				"halsim",
				workspace.id,
				lease?.halsim_port ?? null,
				rejectedHalsimPorts,
			);
			const name = codeContainerName(workspace.id);
			this.storage.upsertCodeContainerLease({
				workspaceId: workspace.id,
				containerName: name,
				simPort,
				vscodePort,
				halsimPort,
				state: "starting",
			});
			return { simPort, vscodePort, halsimPort };
		});
	}

	private async adoptCodeContainer(
		workspace: WorkspaceRow,
		name: string,
		container: DockerInspectContainer,
	): Promise<CodeContainerStatus | null> {
		if (!v2LabelsMatch(container, workspace.id)) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		const simPublished = publishedPortFor(container, SIM_CONTAINER_PORT);
		const vscodePublished = publishedPortFor(container, VSCODE_CONTAINER_PORT);
		const halsimPublished = publishedPortFor(container, HALSIM_CONTAINER_PORT);
		if (
			!simPublished?.loopback ||
			!vscodePublished?.loopback ||
			!halsimPublished?.loopback
		) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		if (container.State?.Running) {
			const lease = this.storage.upsertCodeContainerLease({
				workspaceId: workspace.id,
				containerName: name,
				simPort: simPublished.port,
				vscodePort: vscodePublished.port,
				halsimPort: halsimPublished.port,
				state: "running",
			});
			return statusFromLease(this.storage.config.codeImage, lease, "running");
		}

		const start = await this.runDocker(["start", name], true);
		if (start.exitCode !== 0) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		const restarted = await this.inspectContainer(name);
		if (!restarted || !v2LabelsMatch(restarted, workspace.id)) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		const rSim = publishedPortFor(restarted, SIM_CONTAINER_PORT);
		const rVscode = publishedPortFor(restarted, VSCODE_CONTAINER_PORT);
		const rHalsim = publishedPortFor(restarted, HALSIM_CONTAINER_PORT);
		if (!rSim?.loopback || !rVscode?.loopback || !rHalsim?.loopback) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		const lease = this.storage.upsertCodeContainerLease({
			workspaceId: workspace.id,
			containerName: name,
			simPort: rSim.port,
			vscodePort: rVscode.port,
			halsimPort: rHalsim.port,
			state: containerRuntimeState(restarted),
		});
		return statusFromLease(
			this.storage.config.codeImage,
			lease,
			lease.code_state,
		);
	}

	private async createCodeContainer(
		workspace: WorkspaceRow,
		simPort: number,
		vscodePort: number,
		halsimPort: number,
	): Promise<CodeContainerStatus> {
		await this.ensureImage();
		const homePath = workspaceHomePath(workspace);
		await mkdir(homePath, { recursive: true, mode: 0o700 });

		const name = codeContainerName(workspace.id);
		this.storage.upsertCodeContainerLease({
			workspaceId: workspace.id,
			containerName: name,
			simPort,
			vscodePort,
			halsimPort,
			state: "starting",
		});

		const args = [
			"run",
			"-d",
			"--name",
			name,
			"--label",
			"frc-sim.managed=true",
			"--label",
			"frc-sim.version=v2",
			"--label",
			"frc-sim.role=code",
			"--label",
			`frc-sim.workspace=${workspace.id}`,
			"--mount",
			`type=bind,src=${workspace.project_path},dst=/workspace/project`,
			"--mount",
			`type=bind,src=${homePath},dst=/config`,
			"-p",
			`127.0.0.1:${vscodePort}:${VSCODE_CONTAINER_PORT}`,
			"-p",
			`127.0.0.1:${simPort}:${SIM_CONTAINER_PORT}`,
			"-p",
			`127.0.0.1:${halsimPort}:${HALSIM_CONTAINER_PORT}`,
			"--memory",
			this.storage.config.codeMemoryLimit,
			"-e",
			`VSCODE_BASE_PATH=/u/${workspace.slug}/vscode/`,
		];

		if (this.storage.config.containerUser) {
			const [puid, pgid] = this.storage.config.containerUser.split(":");
			if (puid) {
				args.push("-e", `PUID=${puid}`);
			}
			if (pgid) {
				args.push("-e", `PGID=${pgid}`);
			}
		}

		args.push(this.storage.config.codeImage);
		log.info("creating code container", {
			workspaceId: workspace.id,
			name,
			image: this.storage.config.codeImage,
			simPort,
			vscodePort,
			halsimPort,
		});
		await this.runDocker(args);

		const created = await this.inspectContainer(name);
		const createdSim = created
			? publishedPortFor(created, SIM_CONTAINER_PORT)
			: null;
		const createdVscode = created
			? publishedPortFor(created, VSCODE_CONTAINER_PORT)
			: null;
		const createdHalsim = created
			? publishedPortFor(created, HALSIM_CONTAINER_PORT)
			: null;
		const lease = this.storage.upsertCodeContainerLease({
			workspaceId: workspace.id,
			containerName: name,
			simPort: createdSim?.port ?? simPort,
			vscodePort: createdVscode?.port ?? vscodePort,
			halsimPort: createdHalsim?.port ?? halsimPort,
			state: created ? containerRuntimeState(created) : "starting",
		});

		return statusFromLease(
			this.storage.config.codeImage,
			lease,
			lease.code_state,
		);
	}

	private async withAdmissionLock<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.admissionLock;
		let release!: () => void;
		this.admissionLock = new Promise<void>((resolveLock) => {
			release = resolveLock;
		});

		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}

	private async checkCapacity(): Promise<void> {
		const cap = this.storage.getEffectiveMaxActiveContainers();
		const running = await this.countRunningContainers();
		const active = running + this.pendingCreates;
		if (active >= cap) {
			log.warn("capacity exceeded", {
				cap,
				active,
				pending: this.pendingCreates,
			});
			throw new CapacityExceededError(cap, active);
		}
		log.debug("capacity admitted", { cap, active: active + 1 });
		this.pendingCreates += 1;
	}

	private async ensureCodeContainerInner(
		workspace: WorkspaceRow,
	): Promise<CodeContainerStatus> {
		const expectedName = codeContainerName(workspace.id);
		const existing = await this.inspectContainer(expectedName);
		if (existing) {
			const adopted = await this.adoptCodeContainer(
				workspace,
				expectedName,
				existing,
			);
			if (adopted) {
				return adopted;
			}
		}

		// Admission control: serialize capacity check + pending increment
		await this.withAdmissionLock(async () => {
			await this.checkCapacity();
		});

		const createdAt = performance.now();
		let createdOk = false;
		try {
			const result = await this.createWithRetries(workspace);
			createdOk = true;
			return result;
		} finally {
			if (createdOk) {
				containerStartDuration.observe((performance.now() - createdAt) / 1000);
			}
			this.pendingCreates = Math.max(0, this.pendingCreates - 1);
		}
	}

	private async createWithRetries(
		workspace: WorkspaceRow,
	): Promise<CodeContainerStatus> {
		const simRange = this.storage.config.simPortRange;
		const vscodeRange = this.storage.config.vscodePortRange;
		const halsimRange = this.storage.config.halsimPortRange;
		const maxAttempts = Math.max(
			simRange.end - simRange.start + 1,
			vscodeRange.end - vscodeRange.start + 1,
			halsimRange.end - halsimRange.start + 1,
		);
		const rejectedSimPorts = new Set<number>();
		const rejectedVscodePorts = new Set<number>();
		const rejectedHalsimPorts = new Set<number>();

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const { simPort, vscodePort, halsimPort } = await this.reserveCodePorts(
				workspace,
				rejectedSimPorts,
				rejectedVscodePorts,
				rejectedHalsimPorts,
			);
			try {
				return await this.createCodeContainer(
					workspace,
					simPort,
					vscodePort,
					halsimPort,
				);
			} catch (error) {
				if (!dockerPortBindError(error)) {
					throw error;
				}
				rejectedSimPorts.add(simPort);
				rejectedVscodePorts.add(vscodePort);
				rejectedHalsimPorts.add(halsimPort);
				this.storage.clearReservedPort("sim", workspace.id, simPort);
				this.storage.clearReservedPort("code", workspace.id, vscodePort);
				this.storage.clearReservedPort("halsim", workspace.id, halsimPort);
			}
		}

		log.error("no free ports for code container", {
			workspaceId: workspace.id,
			simRange: `${simRange.start}-${simRange.end}`,
			vscodeRange: `${vscodeRange.start}-${vscodeRange.end}`,
			halsimRange: `${halsimRange.start}-${halsimRange.end}`,
		});
		throw new Error("No free ports are available for the code container.");
	}

	private recordError(
		workspace: WorkspaceRow,
		error: unknown,
	): CodeContainerStatus {
		const message =
			error instanceof Error
				? error.message
				: "Unable to start code container.";
		log.error("code container start failed", {
			workspaceId: workspace.id,
			err: error instanceof Error ? error : new Error(message),
		});
		const previous = this.storage.getContainerLease(workspace.id);
		const name = codeContainerName(workspace.id);
		const lease = this.storage.upsertCodeContainerLease({
			workspaceId: workspace.id,
			containerName: name,
			simPort: previous?.nt4_port ?? null,
			vscodePort: previous?.vscode_port ?? null,
			halsimPort: previous?.halsim_port ?? null,
			state: "error",
		});
		return statusFromLease(
			this.storage.config.codeImage,
			lease,
			"error",
			message,
		);
	}
}
