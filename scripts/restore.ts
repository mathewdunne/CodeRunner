#!/usr/bin/env bun
/**
 * Restore student projects from a backup.
 *
 * Usage:
 *   bun scripts/restore.ts <backup-dir> [--data-dir <path>] [--workspace <id>] [--dry-run]
 *
 * Restores workspace project/ directories from a backup created by backup.ts.
 * Stops containers for affected workspaces before restoring.
 *
 * WARNING: This overwrites existing project files. Back up first if unsure.
 */

import { cp, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

  const toRestore: Array<{ workspaceId: string; src: string; dest: string }> = [];

  for (const workspaceId of workspaceIds) {
    const src = resolve(backupDir, workspaceId, "project");
    if (await dirExists(src)) {
      const dest = resolve(usersDir, workspaceId, "project");
      toRestore.push({ workspaceId, src, dest });
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
  for (const { workspaceId, src, dest } of toRestore) {
    if (dryRun) {
      const destExists = await dirExists(dest);
      console.log(`  ${workspaceId}: ${src} → ${dest} (${destExists ? "overwrite" : "new"})`);
      restored++;
      continue;
    }

    try {
      await cp(src, dest, { recursive: true, force: true });
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
