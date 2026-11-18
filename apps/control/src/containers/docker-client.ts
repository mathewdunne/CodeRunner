import type { ExecOptions } from "../runtime";
import type {
	DockerCommandResult,
	DockerInspectContainer,
	DockerRunner,
} from "./types";

export async function runDockerCli(
	dockerPath: string,
	args: string[],
	options: ExecOptions = {},
): Promise<DockerCommandResult> {
	const subprocess = Bun.spawn([dockerPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | null = null;
	if (options.timeoutMs) {
		timeout = setTimeout(() => {
			timedOut = true;
			try {
				subprocess.kill("SIGTERM");
			} catch {
				// best effort
			}
		}, options.timeoutMs);
		timeout.unref?.();
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (timeout) {
		clearTimeout(timeout);
	}
	if (timedOut) {
		return {
			stdout,
			stderr:
				stderr.trim() ||
				`Command timed out after ${Math.round(options.timeoutMs! / 1000)} seconds.`,
			exitCode: 1,
		};
	}

	return { stdout, stderr, exitCode };
}

export async function defaultDockerRunner(
	args: string[],
): Promise<DockerCommandResult> {
	return runDockerCli("docker", args);
}

export function dockerError(
	args: string[],
	result: DockerCommandResult,
): Error {
	const detail =
		result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
	return new Error(`docker ${args.join(" ")} failed: ${detail}`);
}

export function dockerPortBindError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return /port is already allocated|bind for .* failed|address already in use/i.test(
		message,
	);
}

export async function runDocker(
	dockerRunner: DockerRunner,
	args: string[],
	allowFailure = false,
): Promise<DockerCommandResult> {
	const result = await dockerRunner(args);
	if (!allowFailure && result.exitCode !== 0) {
		throw dockerError(args, result);
	}
	return result;
}

export async function inspectContainer(
	dockerRunner: DockerRunner,
	name: string,
): Promise<DockerInspectContainer | null> {
	const result = await runDocker(
		dockerRunner,
		["container", "inspect", name],
		true,
	);
	if (result.exitCode !== 0) {
		return null;
	}

	const parsed = JSON.parse(result.stdout) as DockerInspectContainer[];
	return parsed[0] ?? null;
}

/**
 * Like `inspectContainer`, but throws instead of collapsing every failure to
 * null — including "no such container", which docker reports as a non-zero exit.
 * Callers probing for existence want the collapsed version; startup
 * self-inspection needs the error, since a denied socket carries the stderr that
 * says so and a missing container is not something it can recover from either.
 */
export async function inspectContainerOrThrow(
	dockerRunner: DockerRunner,
	name: string,
): Promise<DockerInspectContainer> {
	const result = await runDocker(dockerRunner, ["container", "inspect", name]);
	const parsed = JSON.parse(result.stdout) as DockerInspectContainer[];
	const container = parsed[0];
	if (!container) {
		throw new Error(`docker container inspect ${name} returned no container`);
	}
	return container;
}

/**
 * Whether the container is running. A missing container is `false`; any other
 * docker failure throws, so a caller deciding whether something is safe to
 * touch doesn't mistake "docker didn't answer" for "not running".
 */
export async function isContainerRunning(
	dockerRunner: DockerRunner,
	name: string,
): Promise<boolean> {
	try {
		const container = await inspectContainerOrThrow(dockerRunner, name);
		return container.State?.Running === true;
	} catch (err) {
		if (err instanceof Error && /no such container/i.test(err.message)) {
			return false;
		}
		throw err;
	}
}

export async function inspectContainers(
	dockerRunner: DockerRunner,
	names: string[],
): Promise<Map<string, DockerInspectContainer>> {
	const byName = new Map<string, DockerInspectContainer>();
	if (names.length === 0) {
		return byName;
	}
	const result = await runDocker(
		dockerRunner,
		["container", "inspect", ...names],
		true,
	);
	// On partial/failed inspect, Docker still prints a JSON array for the names
	// it could resolve. Parse whatever we got; callers tolerate a missing entry
	// (null labels/state). Guard against non-JSON stdout (e.g. all names gone).
	try {
		const parsed = JSON.parse(result.stdout) as DockerInspectContainer[];
		for (const container of parsed) {
			const key = (container.Name ?? "").replace(/^\//u, "");
			if (key) {
				byName.set(key, container);
			}
		}
	} catch {
		// stdout wasn't valid JSON; return what we have (possibly empty).
	}
	return byName;
}
