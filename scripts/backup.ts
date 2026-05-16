#!/usr/bin/env bun
/**
 * Backup CodeRunner state.
 *
 * Usage:
 *   bun scripts/backup.ts [--data-dir <path>] [--output <path>] [--projects-only]
 *
 * Backs up:
 *   - data/app.db                            (SQLite snapshot via serialize)
 *   - data/allowlist.json                    (auth allowlist)
 *   - data/users/<workspaceId>/project/      (per-workspace, as project.tar.gz)
 *   - data/users/<workspaceId>/assets/       (per-workspace, as assets.tar.gz)
 *
 * Excludes regenerable per-workspace data (home/, jdtls-data/, logs/).
 *
 * Default output: data/backups/YYYY-MM-DD-HHmmss/
 */

import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

type Args = {
  dataDir: string;
  dbPath: string;
  output: string | null;
  projectsOnly: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let dataDir = Bun.env.FRC_DATA_DIR ?? "data";
  let dbPathArg: string | null = null;
  let output: string | null = null;
  let projectsOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) {
      dataDir = args[++i]!;
    } else if (args[i] === "--db-path" && args[i + 1]) {
      dbPathArg = args[++i]!;
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i]!;
    } else if (args[i] === "--projects-only") {
      projectsOnly = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: bun scripts/backup.ts [--data-dir <path>] [--output <path>] [--projects-only]");
      console.log("");
      console.log("Backs up the SQLite DB, allowlist, and all workspace project + assets directories.");
      console.log("Excludes regenerable home/, jdtls-data/, and logs/.");
      console.log("");
      console.log("Options:");
      console.log("  --data-dir <path>   Data directory (default: data/ or $FRC_DATA_DIR)");
      console.log("  --db-path <path>    SQLite DB path (default: <data-dir>/app.db or $FRC_DB_PATH)");
      console.log("  --output <path>     Output directory (default: <data-dir>/backups/YYYY-MM-DD-HHmmss/)");
      console.log("  --projects-only     Back up only per-workspace project files (legacy mode)");
      process.exit(0);
    }
  }

  const resolvedDataDir = resolve(dataDir);
  const dbPath = resolve(dbPathArg ?? Bun.env.FRC_DB_PATH ?? resolve(resolvedDataDir, "app.db"));
  return { dataDir: resolvedDataDir, dbPath, output, projectsOnly };
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

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function runTar(args: string[]): Promise<void> {
  const subprocess = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
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

async function backupDatabase(dbPath: string, destPath: string): Promise<void> {
  // SQLite's online backup via serialize() — safe to run with an active writer,
  // returns a consistent snapshot of committed state.
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const buffer = db.serialize();
    await writeFile(destPath, buffer);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { dataDir, dbPath, output, projectsOnly } = parseArgs();
  const usersDir = resolve(dataDir, "users");
  const allowlistPath = resolve(dataDir, "allowlist.json");

  const backupRoot = resolve(output ?? resolve(dataDir, "backups", timestamp()));
  await mkdir(backupRoot, { recursive: true });

  let dbBacked = false;
  let allowlistBacked = false;

  if (!projectsOnly) {
    if (await fileExists(dbPath)) {
      try {
        await backupDatabase(dbPath, resolve(backupRoot, "app.db"));
        console.log(`✓ database  (${dbPath})`);
        dbBacked = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(`✗ database: ${detail}`);
      }
    } else {
      console.log(`-  database  (not found at ${dbPath})`);
    }

    if (await fileExists(allowlistPath)) {
      try {
        await copyFile(allowlistPath, resolve(backupRoot, "allowlist.json"));
        console.log(`✓ allowlist (${allowlistPath})`);
        allowlistBacked = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(`✗ allowlist: ${detail}`);
      }
    } else {
      console.log(`-  allowlist (not found at ${allowlistPath})`);
    }
  }

  let projectsBacked = 0;
  let assetsBacked = 0;
  let projectsTotal = 0;

  if (await dirExists(usersDir)) {
    const workspaceIds = await readdir(usersDir);
    const workspacesRoot = resolve(backupRoot, "workspaces");

    for (const workspaceId of workspaceIds) {
      const projectPath = resolve(usersDir, workspaceId, "project");
      const assetsPath = resolve(usersDir, workspaceId, "assets");
      const hasProject = await dirExists(projectPath);
      const hasAssets = !projectsOnly && (await dirExists(assetsPath));

      if (!hasProject && !hasAssets) continue;

      projectsTotal++;
      const workspaceBackupDir = resolve(workspacesRoot, workspaceId);
      await mkdir(workspaceBackupDir, { recursive: true });

      if (hasProject) {
        try {
          await runTar(["-czf", resolve(workspaceBackupDir, "project.tar.gz"), "-C", projectPath, "."]);
          projectsBacked++;
          console.log(`✓ project   ${workspaceId}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          console.error(`✗ project   ${workspaceId}: ${detail}`);
        }
      }

      if (hasAssets) {
        try {
          await runTar(["-czf", resolve(workspaceBackupDir, "assets.tar.gz"), "-C", assetsPath, "."]);
          assetsBacked++;
          console.log(`✓ assets    ${workspaceId}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          console.error(`✗ assets    ${workspaceId}: ${detail}`);
        }
      }
    }
  }

  console.log("");
  console.log(`Backup written to ${backupRoot}`);
  console.log(`  database:  ${dbBacked ? "yes" : "no"}`);
  console.log(`  allowlist: ${allowlistBacked ? "yes" : "no"}`);
  console.log(`  workspaces: ${projectsBacked} project / ${assetsBacked} assets (of ${projectsTotal})`);
}

await main();
