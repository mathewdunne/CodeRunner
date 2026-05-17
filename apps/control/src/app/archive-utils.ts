import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function runTar(args: string[]): Promise<void> {
	const subprocess = Bun.spawn(["tar", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (exitCode !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
		throw new Error(`tar ${args.join(" ")} failed: ${detail}`);
	}
}

export async function createProjectArchive(
	projectDir: string,
	archivePath: string,
): Promise<void> {
	await runTar(["-czf", archivePath, "-C", projectDir, "."]);
}

export async function restoreProjectArchive(
	projectDir: string,
	archivePath: string,
): Promise<void> {
	const parentDir = dirname(projectDir);
	const tempDir = resolve(
		parentDir,
		`.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
	try {
		await runTar(["-xzf", archivePath, "-C", tempDir]);
		await rm(projectDir, { recursive: true, force: true });
		await rename(tempDir, projectDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

export async function directorySizeBytes(root: string): Promise<number> {
	let total = 0;
	async function walk(path: string): Promise<void> {
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch {
			return;
		}

		if (info.isSymbolicLink()) {
			return;
		}
		if (info.isFile()) {
			total += info.size;
			return;
		}
		if (!info.isDirectory()) {
			return;
		}

		const entries = await readdir(path).catch(() => []);
		for (const entry of entries) {
			await walk(resolve(path, entry));
		}
	}

	await walk(root);
	return total;
}
