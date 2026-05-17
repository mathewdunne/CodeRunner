#!/usr/bin/env bun
/**
 * Cleanup stopped managed containers (V1 and V2).
 *
 * Usage:
 *   bun scripts/cleanup-containers.ts [--dry-run]
 *
 * Removes all Docker containers that have:
 *   - label frc-sim.managed=true
 *   - status=exited
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const dockerPath = Bun.env.FRC_DOCKER_PATH ?? "docker";

async function run(
	args: string[],
): Promise<{ stdout: string; exitCode: number }> {
	const subprocess = Bun.spawn([dockerPath, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(subprocess.stdout).text();
	const exitCode = await subprocess.exited;
	return { stdout, exitCode };
}

async function main(): Promise<void> {
	console.log("Scanning for stopped managed containers...");

	const list = await run([
		"container",
		"ls",
		"-a",
		"--filter",
		"label=frc-sim.managed=true",
		"--filter",
		"status=exited",
		"--format",
		"{{.Names}}\t{{.Status}}",
	]);

	if (list.exitCode !== 0) {
		console.error("Failed to list containers.");
		process.exit(1);
	}

	const lines = list.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length === 0) {
		console.log("No stopped managed containers found.");
		return;
	}

	console.log(`Found ${lines.length} stopped container(s):`);
	for (const line of lines) {
		console.log(`  ${line}`);
	}

	if (dryRun) {
		console.log("\n--dry-run: no containers removed.");
		return;
	}

	let removed = 0;
	for (const line of lines) {
		const name = line.split("\t")[0]?.trim();
		if (!name) {
			continue;
		}
		const result = await run(["rm", name]);
		if (result.exitCode === 0) {
			console.log(`  Removed ${name}`);
			removed += 1;
		} else {
			console.error(`  Failed to remove ${name}`);
		}
	}

	console.log(`\nRemoved ${removed} of ${lines.length} container(s).`);
}

await main();
