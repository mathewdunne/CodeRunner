import { mkdir } from "node:fs/promises";
import type {
	ContainersStatusResponse,
	WorkspaceId,
} from "@frc-coderunner/contracts";
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
import { listWorkspaceDiskLimitDevices } from "./block-devices";
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
	removeCodeVolume,
	stopCodeContainer,
	stopWorkspaceContainers,
	stopWorkspaceSim,
} from "./lifecycle";
import {
	codeContainerName,
	codeVolumeName,
	configMountType,
	containerAttachedToNetwork,
	containerHasPublishedPorts,
	containerRuntimeState,
	publishedPortFor,
	v2LabelsMatch,
	workspaceHomePath,
} from "./metadata";
import { toHostPath } from "./paths";
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
	private readonly blockDevices: string[];
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
		this.blockDevices =
			this.storage.config.codeDiskReadLimit === null
				? []
				: (options.blockDevices ?? listWorkspaceDiskLimitDevices());
	}

	/**
	 * Non-null when workspace containers join a shared Docker network instead
	 * of publishing loopback host ports (the containerized-control-plane mode).
	 */
	private get containerNetwork(): string | null {
		return this.storage.config.containerNetwork;
	}

	/**
	 * The control plane's compose project, propagated onto workspace containers
	 * so they nest under it in tools that group by `com.docker.compose.project`
	 * (Portainer, `docker compose ls`). Null on the host / when unread, in which
	 * case no compose label is stamped.
	 */
	private get composeProject(): string | null {
		return this.storage.config.composeProject;
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
			this.containerNetwork,
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
			this.containerNetwork,
			workspace,
			lease,
			code.state,
			code.error,
		);
	}

	async removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await removeCodeContainer(this.storage, this.dockerRunner, workspaceId);
		// Deletion, not recycling — so the demo-mode /config volume goes too.
		await removeCodeVolume(this.dockerRunner, workspaceId);
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
			this.containerNetwork,
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

	/**
	 * Created explicitly rather than letting `--mount type=volume` auto-create it,
	 * because `--mount` cannot set the labels cleanup reaps by. Idempotent.
	 */
	private async ensureConfigVolume(
		volume: string,
		workspaceId: WorkspaceId,
	): Promise<void> {
		await this.runDocker([
			"volume",
			"create",
			"--label",
			"frc-sim.managed=true",
			"--label",
			"frc-sim.version=v2",
			"--label",
			"frc-sim.role=code",
			"--label",
			`frc-sim.workspace=${workspaceId}`,
			volume,
		]);
	}

	private async ensureImage(): Promise<void> {
		const image = this.storage.config.codeImage;
		const result = await this.runDocker(["image", "inspect", image], true);
		if (result.exitCode !== 0) {
			log.error("code image not available", { image });
			throw new Error(
				`CODE image ${image} is not available. Build it with bun run docker:build:workspace.`,
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

	/**
	 * Validate that an existing container matches the current connection mode
	 * and return the lease ports to persist (all-null in network mode). Returns
	 * null when the container is unusable and must be recreated — including
	 * leftovers from the other mode after an operator switches deployments.
	 */
	private adoptablePorts(container: DockerInspectContainer): {
		simPort: number | null;
		vscodePort: number | null;
		halsimPort: number | null;
	} | null {
		const network = this.containerNetwork;
		if (network !== null) {
			if (
				!containerAttachedToNetwork(container, network) ||
				containerHasPublishedPorts(container)
			) {
				return null;
			}
			return { simPort: null, vscodePort: null, halsimPort: null };
		}

		const simPublished = publishedPortFor(container, SIM_CONTAINER_PORT);
		const vscodePublished = publishedPortFor(container, VSCODE_CONTAINER_PORT);
		const halsimPublished = publishedPortFor(container, HALSIM_CONTAINER_PORT);
		if (
			!simPublished?.loopback ||
			!vscodePublished?.loopback ||
			!halsimPublished?.loopback
		) {
			return null;
		}
		return {
			simPort: simPublished.port,
			vscodePort: vscodePublished.port,
			halsimPort: halsimPublished.port,
		};
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

		// Demo mode backs /config with a named volume, every other mode with a host
		// bind. Adopting across that boundary would silently leave the container on
		// the previous mode's storage forever, since the mount is fixed at create.
		// A container with no mount data reported is left adoptable.
		const expectedConfigMount = this.storage.config.demo ? "volume" : "bind";
		const actualConfigMount = configMountType(container);
		if (
			actualConfigMount !== null &&
			actualConfigMount !== expectedConfigMount
		) {
			log.info("recreating code container for changed /config mount", {
				workspaceId: workspace.id,
				from: actualConfigMount,
				to: expectedConfigMount,
			});
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		const adoptedPorts = this.adoptablePorts(container);
		if (!adoptedPorts) {
			await this.runDocker(["rm", "-f", name], true);
			return null;
		}

		if (container.State?.Running) {
			const lease = this.storage.upsertCodeContainerLease({
				workspaceId: workspace.id,
				containerName: name,
				...adoptedPorts,
				state: "running",
			});
			return statusFromLease(
				this.storage.config.codeImage,
				this.containerNetwork,
				lease,
				"running",
			);
		}

		// Restarting a stopped container consumes a capacity slot, exactly like a
		// fresh create. Without this, a reconnect storm after an idle sweep (which
		// stops but does not remove containers) can exceed MAX_ACTIVE_CONTAINERS.
		await this.withAdmissionLock(async () => {
			await this.checkCapacity();
		});
		try {
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

			const restartedPorts = this.adoptablePorts(restarted);
			if (!restartedPorts) {
				await this.runDocker(["rm", "-f", name], true);
				return null;
			}

			const lease = this.storage.upsertCodeContainerLease({
				workspaceId: workspace.id,
				containerName: name,
				...restartedPorts,
				state: containerRuntimeState(restarted),
			});
			return statusFromLease(
				this.storage.config.codeImage,
				this.containerNetwork,
				lease,
				lease.code_state,
			);
		} finally {
			this.pendingCreates = Math.max(0, this.pendingCreates - 1);
		}
	}

	private async createCodeContainer(
		workspace: WorkspaceRow,
		simPort: number | null,
		vscodePort: number | null,
		halsimPort: number | null,
	): Promise<CodeContainerStatus> {
		await this.ensureImage();
		const config = this.storage.config;
		const homePath = workspaceHomePath(workspace);
		await mkdir(homePath, { recursive: true, mode: 0o700 });

		const name = codeContainerName(workspace.id);
		// /config holds only regenerable state (Gradle caches, extensions, editor
		// state, build output). Demo mode puts it on a named volume so it stays off
		// the host filesystem, where a bind mount crossing the Docker Desktop VM
		// boundary makes seeding and startup drastically slower. Real deployments
		// keep the bind mount, which lands the caches on CODERUNNER_HOST_DATA_DIR
		// and leaves them visible to the operator.
		const configVolume = config.demo ? codeVolumeName(workspace.id) : null;
		if (configVolume) {
			await this.ensureConfigVolume(configVolume, workspace.id);
		}
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
			// Mount sources are resolved by the Docker daemon against the HOST
			// filesystem, so they go through toHostPath (a no-op outside the
			// containerized deployment). Docker requires -v for SELinux relabeling;
			// :z permits access by both the workspace and the control plane.
			"-v",
			`${toHostPath(config, workspace.project_path)}:/workspace/project:z`,
			configVolume ? "--mount" : "-v",
			configVolume
				? `type=volume,src=${configVolume},dst=/config`
				: `${toHostPath(config, homePath)}:/config:z`,
		];

		// Nest workspace containers under the control plane's compose project in
		// Portainer / `docker compose ls`. Note this makes `docker compose down
		// --remove-orphans` (or a Portainer "remove stack") select them too;
		// their real lifecycle owner is still the frc-sim.managed reconciler.
		if (this.composeProject !== null) {
			args.push("--label", `com.docker.compose.project=${this.composeProject}`);
		}

		if (this.containerNetwork !== null) {
			args.push("--network", this.containerNetwork);
		} else {
			args.push(
				"-p",
				`127.0.0.1:${vscodePort}:${VSCODE_CONTAINER_PORT}`,
				"-p",
				`127.0.0.1:${simPort}:${SIM_CONTAINER_PORT}`,
				"-p",
				`127.0.0.1:${halsimPort}:${HALSIM_CONTAINER_PORT}`,
			);
		}

		args.push(
			"--memory",
			this.storage.config.codeMemoryLimit,
			"-e",
			`VSCODE_BASE_PATH=/u/${workspace.slug}/vscode/`,
		);

		// A container thrashing against its memory limit re-reads its page cache
		// from disk indefinitely; without a read cap that saturates the host's
		// provisioned disk throughput and stalls everything on the VM. Demo mode
		// runs a single workspace on someone's own machine, so there is no shared
		// throughput to protect and the cap only slows seeding and builds down.
		const diskReadLimit = config.demo
			? null
			: this.storage.config.codeDiskReadLimit;
		if (diskReadLimit !== null) {
			for (const device of this.blockDevices) {
				args.push("--device-read-bps", `${device}:${diskReadLimit}`);
			}
		}

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
			configMount: configVolume
				? `volume ${configVolume} (demo mode)`
				: `bind ${toHostPath(config, homePath)}`,
			diskReadLimit: config.demo
				? "(demo mode: uncapped)"
				: diskReadLimit === null
					? "(disabled)"
					: this.blockDevices.length === 0
						? "(no devices)"
						: `${diskReadLimit} × ${this.blockDevices.join(", ")}`,
		});
		await this.runDocker(args);

		const created = await this.inspectContainer(name);
		const createdSim =
			created && this.containerNetwork === null
				? publishedPortFor(created, SIM_CONTAINER_PORT)
				: null;
		const createdVscode =
			created && this.containerNetwork === null
				? publishedPortFor(created, VSCODE_CONTAINER_PORT)
				: null;
		const createdHalsim =
			created && this.containerNetwork === null
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
			this.containerNetwork,
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
		// Network mode has no host port allocation, so port-bind conflicts cannot
		// happen and there is nothing to retry.
		if (this.containerNetwork !== null) {
			return this.createCodeContainer(workspace, null, null, null);
		}

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
			this.containerNetwork,
			lease,
			"error",
			message,
		);
	}
}
