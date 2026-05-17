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
