import { dirname, resolve } from "node:path";
import type { ContainerState, WorkspaceId } from "@frc-coderunner/contracts";
import type { WorkspaceRow } from "../storage";
import {
	CODE_NAME_PREFIX,
	type DockerInspectContainer,
	type PublishedPort,
} from "./types";

export function codeContainerName(workspaceId: WorkspaceId): string {
	return `${CODE_NAME_PREFIX}${workspaceId}`;
}

export function workspaceHomePath(workspace: WorkspaceRow): string {
	return resolve(dirname(workspace.project_path), "home");
}

export function isLoopbackHost(hostIp: string): boolean {
	return (
		hostIp === "127.0.0.1" ||
		hostIp === "::1" ||
		hostIp.toLowerCase() === "localhost"
	);
}

export function publishedPortFor(
	container: DockerInspectContainer,
	port: number,
): PublishedPort | null {
	const bindings = container.NetworkSettings?.Ports?.[`${port}/tcp`];
	const binding = Array.isArray(bindings) ? bindings[0] : null;
	const hostPort = Number(binding?.HostPort);
	if (
		!binding ||
		!Number.isInteger(hostPort) ||
		hostPort < 1 ||
		hostPort > 65535
	) {
		return null;
	}

	const hostIp = binding.HostIp ?? "";
	return {
		port: hostPort,
		hostIp,
		loopback: isLoopbackHost(hostIp),
	};
}

export function containerRuntimeState(
	container: DockerInspectContainer,
): ContainerState {
	if (container.State?.Running) {
		return "running";
	}
	return "stopped";
}

export function v2LabelsMatch(
	container: DockerInspectContainer,
	workspaceId: WorkspaceId,
): boolean {
	const labels = container.Config?.Labels ?? {};
	return (
		labels["frc-sim.managed"] === "true" &&
		labels["frc-sim.version"] === "v2" &&
		labels["frc-sim.role"] === "code" &&
		labels["frc-sim.workspace"] === workspaceId
	);
}
