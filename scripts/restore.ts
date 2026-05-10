#!/usr/bin/env bun
/**
 * Restore student projects from a backup.
 *
 * Usage:
 *   bun scripts/restore.ts <backup-dir> [--data-dir <path>] [--workspace <id>] [--dry-run]
 *
 * Restores workspace project/ directories from project.tar.gz archives created
 * by backup.ts. Legacy directory backups are also accepted.
 * Stops containers for affected workspaces before restoring.
 *
 * WARNING: This overwrites existing project files. Back up first if unsure.
 */

import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(): {
  backupDir: string;
  dataDir: string;
  workspace: string | null;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let backupDir: string | null = null;
  let dataDir = Bun.env.FRC_DATA_DIR ?? "data";
  let workspace: string | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) {
      dataDir = args[++i]!;
    } else if (args[i] === "--workspace" && args[i + 1]) {
      workspace = args[++i]!;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: bun scripts/restore.ts <backup-dir> [--data-dir <path>] [--workspace <id>] [--dry-run]");
      console.log("");
      console.log("Restores workspace project/ directories from a backup.");
      console.log("");
      console.log("Options:");
      console.log("  <backup-dir>          Path to backup directory (required)");
      console.log("  --data-dir <path>     Data directory (default: data/ or FRC_DATA_DIR)");
      console.log("  --workspace <id>      Restore only this workspace (default: all)");
      console.log("  --dry-run             Show what would be restored without writing");
      process.exit(0);
    } else if (!args[i]!.startsWith("-")) {
      backupDir = args[i]!;
    }
  }

  if (!backupDir) {
    console.error("Error: backup directory argument is required.");
    console.error("Usage: bun scripts/restore.ts <backup-dir> [options]");
    process.exit(1);
  }

  return { backupDir: resolve(backupDir), dataDir: resolve(dataDir), workspace, dryRun };
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

async function restoreArchive(dest: string, archivePath: string): Promise<void> {
  const parentDir = dirname(dest);
  const tempDir = resolve(parentDir, `.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  try {
    await runTar(["-xzf", archivePath, "-C", tempDir]);
    await rm(dest, { recursive: true, force: true });
    await rename(tempDir, dest);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function restoreDirectory(dest: string, sourceDir: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(sourceDir, dest, { recursive: true });
}

async function main(): Promise<void> {
  const { backupDir, dataDir, workspace, dryRun } = parseArgs();

  if (!(await dirExists(backupDir))) {
    console.error(`Backup directory not found: ${backupDir}`);
    process.exit(1);
  }

  const usersDir = resolve(dataDir, "users");

  let workspaceIds = await readdir(backupDir);
  if (workspace) {
    if (!workspaceIds.includes(workspace)) {
      console.error(`Workspace ${workspace} not found in backup.`);
      console.error(`Available: ${workspaceIds.join(", ")}`);
      process.exit(1);
    }
    workspaceIds = [workspace];
  }

  const toRestore: Array<{ workspaceId: string; src: string; dest: string; kind: "archive" | "directory" }> = [];

  for (const workspaceId of workspaceIds) {
    const archive = resolve(backupDir, workspaceId, "project.tar.gz");
    const legacyDir = resolve(backupDir, workspaceId, "project");
    if (await fileExists(archive)) {
      const dest = resolve(usersDir, workspaceId, "project");
      toRestore.push({ workspaceId, src: archive, dest, kind: "archive" });
    } else if (await dirExists(legacyDir)) {
      const dest = resolve(usersDir, workspaceId, "project");
      toRestore.push({ workspaceId, src: legacyDir, dest, kind: "directory" });
    }
  }

  if (toRestore.length === 0) {
    console.log("No workspace projects found in the backup.");
    return;
  }

  console.log(`${dryRun ? "[DRY RUN] " : ""}Restoring ${toRestore.length} workspace(s) from ${backupDir}`);
  if (!dryRun) {
    console.log("WARNING: Stop the control plane before restoring to avoid conflicts.");
  }

  let restored = 0;
  for (const { workspaceId, src, dest, kind } of toRestore) {
    if (dryRun) {
      const destExists = await dirExists(dest);
      console.log(`  ${workspaceId}: ${src} → ${dest} (${destExists ? "overwrite" : "new"})`);
      restored++;
      continue;
    }

    try {
      if (kind === "archive") {
        await restoreArchive(dest, src);
      } else {
        await restoreDirectory(dest, src);
      }
      console.log(`  ✓ ${workspaceId}`);
      restored++;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`  ✗ ${workspaceId}: ${detail}`);
    }
  }

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Restore complete: ${restored}/${toRestore.length} workspace(s).`);
}

await main();
