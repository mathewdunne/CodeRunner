#!/usr/bin/env bun
/**
 * Remove all managed V2 workspace containers and clear their leases.
 *
 * Usage:
 *   bun scripts/rebuild-workspaces.ts [--dry-run]
 *
 * Student projects and editor homes are bind-mounted under data/users/...; this
 * only removes disposable Docker containers and releases their published ports.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export type DockerCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type DockerRunner = (args: string[]) => Promise<DockerCommandResult>;

export type RebuildWorkspacesOptions = {
	dbPath: string;
	dockerRunner: DockerRunner;
	dryRun?: boolean;
	logger?: Pick<Console, "error" | "log">;
};

export type RebuildWorkspacesResult = {
	found: string[];
	removed: string[];
	leasesCleared: number;
	dryRun: boolean;
};

const dockerPath = Bun.env.FRC_DOCKER_PATH ?? "docker";

async function runDockerCli(args: string[]): Promise<DockerCommandResult> {
	const subprocess = Bun.spawn([dockerPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	return { stdout, stderr, exitCode };
}

function parseContainerNames(stdout: string): string[] {
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function clearContainerLeases(dbPath: string): number {
	const db = new Database(dbPath);
	try {
		const timestamp = new Date().toISOString();
		const transaction = db.transaction(() => {
			const result = db
				.query(
					`
						UPDATE container_leases
						SET vscode_container = NULL,
								nt4_port = NULL,
								vscode_port = NULL,
								halsim_port = NULL,
								code_state = 'missing',
								last_used_at = ?
					`,
				)
				.run(timestamp);
			return result.changes;
		});
		return transaction() as number;
	} finally {
		db.close();
	}
}

export async function rebuildWorkspaces(
	options: RebuildWorkspacesOptions,
): Promise<RebuildWorkspacesResult> {
	const logger = options.logger ?? console;
	const dryRun = options.dryRun ?? false;

	const list = await options.dockerRunner([
		"container",
		"ls",
		"-a",
		"--filter",
		"label=frc-sim.managed=true",
		"--filter",
		"label=frc-sim.version=v2",
		"--format",
		"{{.Names}}",
	]);
	if (list.exitCode !== 0) {
		const detail = list.stderr.trim() || list.stdout.trim() || "unknown error";
		throw new Error(`Failed to list managed V2 containers: ${detail}`);
	}

	const names = parseContainerNames(list.stdout);
	logger.log(`Found ${names.length} managed V2 workspace container(s).`);
	for (const name of names) {
		logger.log(`  ${name}`);
	}

	if (dryRun) {
		logger.log("--dry-run: no containers removed and no leases changed.");
		return { found: names, removed: [], leasesCleared: 0, dryRun };
	}

	const removed: string[] = [];
	for (const name of names) {
		const result = await options.dockerRunner(["rm", "-f", name]);
		if (result.exitCode !== 0) {
			const detail =
				result.stderr.trim() || result.stdout.trim() || "unknown error";
			throw new Error(`Failed to remove container ${name}: ${detail}`);
		}
		logger.log(`  Removed ${name}`);
		removed.push(name);
	}

	const leasesCleared = clearContainerLeases(options.dbPath);
	logger.log(`Cleared ${leasesCleared} container lease(s).`);

	return { found: names, removed, leasesCleared, dryRun };
}

function dbPathFromEnv(): string {
	return (
		Bun.env.FRC_DB_PATH ?? resolve(Bun.env.FRC_DATA_DIR ?? "data", "app.db")
	);
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	try {
		await rebuildWorkspaces({
			dbPath: dbPathFromEnv(),
			dockerRunner: runDockerCli,
			dryRun,
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
