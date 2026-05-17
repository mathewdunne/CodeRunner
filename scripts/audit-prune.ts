#!/usr/bin/env bun
import { Database } from "bun:sqlite";
/**
 * Prune audit log entries older than a given date.
 *
 * Usage:
 *   bun run audit:prune --before 2024-01-01
 *   bun run audit:prune --before 2024-06-15 --dry-run
 */
import { resolve } from "node:path";

const args = process.argv.slice(2);
const beforeIndex = args.indexOf("--before");
const dryRun = args.includes("--dry-run");

if (beforeIndex === -1 || !args[beforeIndex + 1]) {
	console.error("Usage: bun run audit:prune --before YYYY-MM-DD [--dry-run]");
	process.exit(1);
}

const beforeDate = args[beforeIndex + 1]!;
const beforeMs = Date.parse(beforeDate);
if (Number.isNaN(beforeMs)) {
	console.error(`Invalid date: ${beforeDate}`);
	process.exit(1);
}

const dataDir =
	process.env.FRC_DATA_DIR ?? resolve(import.meta.dir, "..", "data");
const dbPath = process.env.FRC_DB_PATH ?? resolve(dataDir, "app.db");

const db = new Database(dbPath, { create: false });

const countResult = db
	.query("SELECT COUNT(*) AS count FROM audit_log WHERE occurred_at < ?")
	.get(beforeMs) as { count: number };

if (dryRun) {
	console.log(
		`[dry-run] Would delete ${countResult.count} audit log entries before ${beforeDate}.`,
	);
} else {
	db.query("DELETE FROM audit_log WHERE occurred_at < ?").run(beforeMs);
	console.log(
		`Deleted ${countResult.count} audit log entries before ${beforeDate}.`,
	);
}

db.close();
