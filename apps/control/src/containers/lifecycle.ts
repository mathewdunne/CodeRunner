import type { WorkspaceId } from "@frc-sim/contracts";
import { getLogger } from "../logging";
import type { AppStorage } from "../storage";
import { parseDockerStatsLine } from "./converters";
import { inspectContainer, runDocker } from "./docker-client";
import { codeContainerName, containerRuntimeState } from "./metadata";
import type { DockerRunner, ManagedContainerStats } from "./types";

const log = getLogger("containers");

export async function stopCodeContainer(
	storage: AppStorage,
	dockerRunner: DockerRunner,
	workspaceId: WorkspaceId,
): Promise<void> {
	const name = codeContainerName(workspaceId);
	const existing = await inspectContainer(dockerRunner, name);
	if (existing?.State?.Running) {
		log.info("stopping container", { workspaceId, name });
		await runDocker(dockerRunner, ["stop", name], true);
	} else {
		log.debug("stopCodeContainer: not running", { workspaceId, name });
	}
	const lease = storage.getContainerLease(workspaceId);
	if (lease) {
		storage.upsertCodeContainerLease({
			workspaceId,
			containerName: name,
			simPort: lease.nt4_port,
			vscodePort: lease.vscode_port,
			halsimPort: lease.halsim_port,
			state: "stopped",
		});
	}
}

export async function stopWorkspaceSim(
	dockerRunner: DockerRunner,
	workspaceId: WorkspaceId,
): Promise<boolean> {
	const name = codeContainerName(workspaceId);
	const existing = await inspectContainer(dockerRunner, name);
	if (!existing?.State?.Running) {
		return false;
	}

	const result = await runDocker(
		dockerRunner,
		["exec", name, "/usr/local/bin/stop-sim.sh"],
		true,
	);
	return result.exitCode === 0;
}

export async function removeCodeContainer(
	storage: AppStorage,
	dockerRunner: DockerRunner,
	workspaceId: WorkspaceId,
): Promise<void> {
	const name = codeContainerName(workspaceId);
	log.info("removing container", { workspaceId, name });
	await runDocker(dockerRunner, ["rm", "-f", name], true);
	const lease = storage.getContainerLease(workspaceId);
	if (lease) {
		storage.upsertCodeContainerLease({
			workspaceId,
			containerName: name,
			simPort: null,
			vscodePort: null,
			halsimPort: null,
			state: "missing",
		});
	}
}

export async function stopWorkspaceContainers(
	storage: AppStorage,
	dockerRunner: DockerRunner,
	workspaceId: WorkspaceId,
): Promise<void> {
	await stopCodeContainer(storage, dockerRunner, workspaceId);
}

export async function countRunningContainers(
	dockerRunner: DockerRunner,
): Promise<number> {
	const result = await runDocker(
		dockerRunner,
		[
			"container",
			"ls",
			"--filter",
			"label=frc-sim.managed=true",
			"--filter",
			"label=frc-sim.version=v2",
			"--filter",
			"status=running",
			"--format",
			"{{.Names}}",
		],
		true,
	);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return 0;
	}
	return result.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean).length;
}

export async function cleanupStoppedContainers(
	dockerRunner: DockerRunner,
): Promise<string[]> {
	const result = await runDocker(
		dockerRunner,
		[
			"container",
			"ls",
			"-a",
			"--filter",
			"label=frc-sim.managed=true",
			"--filter",
			"status=exited",
			"--format",
			"{{.Names}}",
		],
		true,
	);
	if (result.exitCode !== 0) {
		return [];
	}

	const names = result.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);

	const removed: string[] = [];
	for (const name of names) {
		const removeResult = await runDocker(dockerRunner, ["rm", name], true);
		if (removeResult.exitCode === 0) {
			removed.push(name);
		} else {
			log.warn("failed to remove stopped container", {
				name,
				exitCode: removeResult.exitCode,
			});
		}
	}
	if (removed.length > 0) {
		log.info("cleaned up stopped containers", { count: removed.length });
	}
	return removed;
}

export async function managedContainerStats(
	dockerRunner: DockerRunner,
): Promise<ManagedContainerStats[]> {
	const list = await runDocker(
		dockerRunner,
		[
			"container",
			"ls",
			"-a",
			"--filter",
			"label=frc-sim.managed=true",
			"--format",
			"{{.Names}}",
		],
		true,
	);
	if (list.exitCode !== 0 || !list.stdout.trim()) {
		return [];
	}

	const names = list.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (names.length === 0) {
		return [];
	}

	const statsByName = new Map<string, Partial<ManagedContainerStats>>();
	const stats = await runDocker(
		dockerRunner,
		["stats", "--no-stream", "--format", "{{json .}}", ...names],
		true,
	);
	if (stats.exitCode === 0) {
		for (const line of stats.stdout.split(/\r?\n/u)) {
			const parsed = parseDockerStatsLine(line.trim());
			if (parsed?.name) {
				statsByName.set(parsed.name, parsed);
			}
		}
	}

	const output: ManagedContainerStats[] = [];
	for (const name of names) {
		const inspected = await inspectContainer(dockerRunner, name);
		const labels = inspected?.Config?.Labels ?? {};
		const runtime = inspected ? containerRuntimeState(inspected) : null;
		const stat = statsByName.get(name);
		output.push({
			name,
			id: stat?.id ?? null,
			workspaceId: labels["frc-sim.workspace"] ?? null,
			role: labels["frc-sim.role"] ?? null,
			state: runtime,
			cpuPercent: stat?.cpuPercent ?? null,
			memoryUsage: stat?.memoryUsage ?? null,
			memoryLimit: stat?.memoryLimit ?? null,
			memoryPercent: stat?.memoryPercent ?? null,
		});
	}
	return output;
}
