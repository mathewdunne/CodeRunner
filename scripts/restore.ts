#!/usr/bin/env bun
/**
 * Restore CodeRunner state from a backup created by backup.ts.
 *
 * Usage:
 *   bun scripts/restore.ts <backup-dir> [--data-dir <path>] [--workspace <id>]
 *                                       [--skip-db] [--skip-allowlist] [--skip-assets]
 *                                       [--dry-run]
 *
 * Restores:
 *   - data/app.db                            (from <backup>/app.db, if present)
 *   - data/allowlist.json                    (from <backup>/allowlist.json, if present)
 *   - data/users/<id>/project/               (from <backup>/workspaces/<id>/project.tar.gz)
 *   - data/users/<id>/assets/                (from <backup>/workspaces/<id>/assets.tar.gz)
 *
 * Old-format backups (no top-level app.db, workspaces directly under root) are
 * still supported for the per-workspace data.
 *
 * WARNING: This overwrites existing state. Stop the control plane first.
 */

import {
	copyFile,
	cp,
	mkdir,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Args = {
	backupDir: string;
	dataDir: string;
	dbPath: string;
	workspace: string | null;
	skipDb: boolean;
	skipAllowlist: boolean;
	skipAssets: boolean;
	dryRun: boolean;
};

function parseArgs(): Args {
	const args = process.argv.slice(2);
	let backupDir: string | null = null;
	let dataDir = Bun.env.FRC_DATA_DIR ?? "data";
	let dbPathArg: string | null = null;
	let workspace: string | null = null;
	let skipDb = false;
	let skipAllowlist = false;
	let skipAssets = false;
	let dryRun = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--data-dir" && args[i + 1]) {
			dataDir = args[++i]!;
		} else if (args[i] === "--db-path" && args[i + 1]) {
			dbPathArg = args[++i]!;
		} else if (args[i] === "--workspace" && args[i + 1]) {
			workspace = args[++i]!;
		} else if (args[i] === "--skip-db") {
			skipDb = true;
		} else if (args[i] === "--skip-allowlist") {
			skipAllowlist = true;
		} else if (args[i] === "--skip-assets") {
			skipAssets = true;
		} else if (args[i] === "--dry-run") {
			dryRun = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log("Usage: bun scripts/restore.ts <backup-dir> [options]");
			console.log("");
			console.log(
				"Restores DB, allowlist, and workspace project/assets directories from a backup.",
			);
			console.log("");
			console.log("Options:");
			console.log(
				"  <backup-dir>          Path to backup directory (required)",
			);
			console.log(
				"  --data-dir <path>     Data directory (default: data/ or $FRC_DATA_DIR)",
			);
			console.log(
				"  --db-path <path>      SQLite DB path (default: <data-dir>/app.db or $FRC_DB_PATH)",
			);
			console.log(
				"  --workspace <id>      Restore only this workspace; implies --skip-db --skip-allowlist",
			);
			console.log("  --skip-db             Don't restore app.db");
			console.log("  --skip-allowlist      Don't restore allowlist.json");
			console.log(
				"  --skip-assets         Don't restore per-workspace assets/",
			);
			console.log(
				"  --dry-run             Show what would be restored without writing",
			);
			process.exit(0);
		} else if (!args[i]?.startsWith("-")) {
			backupDir = args[i]!;
		}
	}

	if (!backupDir) {
		console.error("Error: backup directory argument is required.");
		console.error("Usage: bun scripts/restore.ts <backup-dir> [options]");
		process.exit(1);
	}

	if (workspace) {
		skipDb = true;
		skipAllowlist = true;
	}

	const resolvedDataDir = resolve(dataDir);
	const dbPath = resolve(
		dbPathArg ?? Bun.env.FRC_DB_PATH ?? resolve(resolvedDataDir, "app.db"),
	);
	return {
		backupDir: resolve(backupDir),
		dataDir: resolvedDataDir,
		dbPath,
		workspace,
		skipDb,
		skipAllowlist,
		skipAssets,
		dryRun,
	};
}

async function dirExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function runTar(args: string[]): Promise<void> {
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

async function restoreArchive(
	dest: string,
	archivePath: string,
): Promise<void> {
	const parentDir = dirname(dest);
	const tempDir = resolve(
		parentDir,
		`.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
	try {
		await runTar(["-xzf", archivePath, "-C", tempDir]);
		await rm(dest, { recursive: true, force: true });
		await mkdir(dirname(dest), { recursive: true });
		await rename(tempDir, dest);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

async function restoreDirectory(
	dest: string,
	sourceDir: string,
): Promise<void> {
	await rm(dest, { recursive: true, force: true });
	await mkdir(dirname(dest), { recursive: true });
	await cp(sourceDir, dest, { recursive: true });
}

async function restoreDb(
	backupDbPath: string,
	destDbPath: string,
): Promise<void> {
	// Remove any stale WAL/SHM so SQLite doesn't try to replay them against the new DB.
	await rm(destDbPath, { force: true });
	await rm(`${destDbPath}-wal`, { force: true });
	await rm(`${destDbPath}-shm`, { force: true });
	await mkdir(dirname(destDbPath), { recursive: true });
	await copyFile(backupDbPath, destDbPath);
}

type WorkspaceRestore = {
	workspaceId: string;
	projectArchive: string | null;
	projectLegacyDir: string | null;
	assetsArchive: string | null;
};

async function discoverWorkspaces(
	backupDir: string,
): Promise<WorkspaceRestore[]> {
	// New format: backup/workspaces/<id>/{project.tar.gz,assets.tar.gz}
	// Legacy format: backup/<id>/{project.tar.gz | project/}
	const candidates: Array<{ id: string; dir: string }> = [];
	const workspacesRoot = resolve(backupDir, "workspaces");
	if (await dirExists(workspacesRoot)) {
		for (const id of await readdir(workspacesRoot)) {
			candidates.push({ id, dir: resolve(workspacesRoot, id) });
		}
	} else {
		for (const id of await readdir(backupDir)) {
			// Skip known top-level files (legacy roots only contained workspace subdirs).
			if (id === "app.db" || id === "allowlist.json" || id === "workspaces")
				continue;
			const candidatePath = resolve(backupDir, id);
			if (await dirExists(candidatePath)) {
				candidates.push({ id, dir: candidatePath });
			}
		}
	}

	const results: WorkspaceRestore[] = [];
	for (const { id, dir } of candidates) {
		const projectArchive = resolve(dir, "project.tar.gz");
		const projectLegacyDir = resolve(dir, "project");
		const assetsArchive = resolve(dir, "assets.tar.gz");
		results.push({
			workspaceId: id,
			projectArchive: (await fileExists(projectArchive))
				? projectArchive
				: null,
			projectLegacyDir: (await dirExists(projectLegacyDir))
				? projectLegacyDir
				: null,
			assetsArchive: (await fileExists(assetsArchive)) ? assetsArchive : null,
		});
	}
	return results;
}

async function main(): Promise<void> {
	const args = await parseArgs();
	const {
		backupDir,
		dataDir,
		dbPath,
		workspace,
		skipDb,
		skipAllowlist,
		skipAssets,
		dryRun,
	} = args;

	if (!(await dirExists(backupDir))) {
		console.error(`Backup directory not found: ${backupDir}`);
		process.exit(1);
	}

	if (!dryRun) {
		console.log(
			"WARNING: Stop the control plane before restoring to avoid conflicts.",
		);
	}

	const usersDir = resolve(dataDir, "users");
	const allowlistPath = resolve(dataDir, "allowlist.json");
	const backupDbPath = resolve(backupDir, "app.db");
	const backupAllowlistPath = resolve(backupDir, "allowlist.json");

	// --- Database ---
	if (!skipDb && (await fileExists(backupDbPath))) {
		if (dryRun) {
			console.log(`  database  ${backupDbPath} → ${dbPath}`);
		} else {
			try {
				await restoreDb(backupDbPath, dbPath);
				console.log(`✓ database  ${dbPath}`);
			} catch (error) {
				const detail = error instanceof Error ? error.message : "unknown error";
				console.error(`✗ database: ${detail}`);
			}
		}
	}

	// --- Allowlist ---
	if (!skipAllowlist && (await fileExists(backupAllowlistPath))) {
		if (dryRun) {
			console.log(`  allowlist ${backupAllowlistPath} → ${allowlistPath}`);
		} else {
			try {
				await mkdir(dirname(allowlistPath), { recursive: true });
				await copyFile(backupAllowlistPath, allowlistPath);
				console.log(`✓ allowlist ${allowlistPath}`);
			} catch (error) {
				const detail = error instanceof Error ? error.message : "unknown error";
				console.error(`✗ allowlist: ${detail}`);
			}
		}
	}

	// --- Workspaces ---
	let workspaces = await discoverWorkspaces(backupDir);
	if (workspace) {
		workspaces = workspaces.filter((w) => w.workspaceId === workspace);
		if (workspaces.length === 0) {
			console.error(`Workspace ${workspace} not found in backup.`);
			process.exit(1);
		}
	}

	if (workspaces.length === 0) {
		console.log("No workspace projects found in the backup.");
		return;
	}

	let projectsDone = 0;
	let assetsDone = 0;

	for (const w of workspaces) {
		const projectDest = resolve(usersDir, w.workspaceId, "project");
		const assetsDest = resolve(usersDir, w.workspaceId, "assets");

		if (w.projectArchive || w.projectLegacyDir) {
			if (dryRun) {
				const src = w.projectArchive ?? w.projectLegacyDir!;
				console.log(`  project   ${src} → ${projectDest}`);
				projectsDone++;
			} else {
				try {
					if (w.projectArchive) {
						await restoreArchive(projectDest, w.projectArchive);
					} else if (w.projectLegacyDir) {
						await restoreDirectory(projectDest, w.projectLegacyDir);
					}
					console.log(`✓ project   ${w.workspaceId}`);
					projectsDone++;
				} catch (error) {
					const detail =
						error instanceof Error ? error.message : "unknown error";
					console.error(`✗ project   ${w.workspaceId}: ${detail}`);
				}
			}
		}

		if (!skipAssets && w.assetsArchive) {
			if (dryRun) {
				console.log(`  assets    ${w.assetsArchive} → ${assetsDest}`);
				assetsDone++;
			} else {
				try {
					await restoreArchive(assetsDest, w.assetsArchive);
					console.log(`✓ assets    ${w.workspaceId}`);
					assetsDone++;
				} catch (error) {
					const detail =
						error instanceof Error ? error.message : "unknown error";
					console.error(`✗ assets    ${w.workspaceId}: ${detail}`);
				}
			}
		}
	}

	console.log("");
	console.log(
		`${dryRun ? "[DRY RUN] " : ""}Restore complete: ${projectsDone} project / ${assetsDone} assets across ${workspaces.length} workspace(s).`,
	);
}

await main();
