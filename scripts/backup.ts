#!/usr/bin/env bun
/**
 * Backup student projects.
 *
 * Usage:
 *   bun scripts/backup.ts [--data-dir <path>] [--output <path>]
 *
 * Creates a date-stamped backup of all workspace project/ directories as
 * per-workspace project.tar.gz archives.
 * Excludes regenerable data (home/, jdtls-data/, logs/).
 *
 * Default output: data/backups/YYYY-MM-DD-HHmmss/
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(): { dataDir: string; output: string | null } {
  const args = process.argv.slice(2);
  let dataDir = Bun.env.FRC_DATA_DIR ?? "data";
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) {
      dataDir = args[++i]!;
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i]!;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: bun scripts/backup.ts [--data-dir <path>] [--output <path>]");
      console.log("");
      console.log("Backs up all workspace project/ directories.");
      console.log("Excludes regenerable home/, jdtls-data/, and logs/.");
      console.log("");
      console.log("Options:");
      console.log("  --data-dir <path>   Data directory (default: data/ or FRC_DATA_DIR)");
      console.log("  --output <path>     Output directory (default: data/backups/YYYY-MM-DD-HHmmss/)");
      process.exit(0);
    }
  }

  return { dataDir: resolve(dataDir), output };
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
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

async function main(): Promise<void> {
  const { dataDir, output } = parseArgs();
  const usersDir = resolve(dataDir, "users");

  if (!(await dirExists(usersDir))) {
    console.log(`No users directory found at ${usersDir}. Nothing to back up.`);
    return;
  }

  const workspaceIds = await readdir(usersDir);
  const toBackup: Array<{ workspaceId: string; projectPath: string }> = [];

  for (const workspaceId of workspaceIds) {
    const projectPath = resolve(usersDir, workspaceId, "project");
    if (await dirExists(projectPath)) {
      toBackup.push({ workspaceId, projectPath });
    }
  }

  if (toBackup.length === 0) {
    console.log("No workspace projects found to back up.");
    return;
  }

  const backupRoot = resolve(output ?? resolve(dataDir, "backups", timestamp()));
  await mkdir(backupRoot, { recursive: true });

  console.log(`Backing up ${toBackup.length} workspace(s) to ${backupRoot}`);

  let backed = 0;
  for (const { workspaceId, projectPath } of toBackup) {
    const workspaceBackupDir = resolve(backupRoot, workspaceId);
    const dest = resolve(workspaceBackupDir, "project.tar.gz");
    try {
      await mkdir(workspaceBackupDir, { recursive: true });
      await runTar(["-czf", dest, "-C", projectPath, "."]);
      console.log(`  ✓ ${workspaceId}`);
      backed++;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`  ✗ ${workspaceId}: ${detail}`);
    }
  }

  console.log(`\nBackup complete: ${backed}/${toBackup.length} workspace(s) saved to ${backupRoot}`);
}

await main();
