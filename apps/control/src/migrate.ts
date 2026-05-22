import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadControlConfig } from "./config";
import {
	configureLogging,
	defaultLogFormat,
	defaultLogLevel,
	getLogger,
} from "./logging";
import { applyMigrations, migrationStatus } from "./migrations";

await configureLogging(defaultLogLevel(), defaultLogFormat());
const log = getLogger("migrate");

const command = Bun.argv[2] ?? "apply";
const config = loadControlConfig();

await mkdir(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA foreign_keys = ON;");

try {
	if (command === "apply") {
		const applied = await applyMigrations(db, config.migrationsDir);
		if (applied.length === 0) {
			log.info("no pending migrations");
		} else {
			for (const migration of applied) {
				log.info("applied migration", { name: migration.name });
			}
		}
	} else if (command === "status") {
		const statuses = await migrationStatus(db, config.migrationsDir);
		for (const status of statuses) {
			log.info("migration status", {
				name: status.name,
				applied: status.applied,
				appliedAt: status.appliedAt ?? null,
			});
		}
	} else {
		log.error("unknown migration command", { command });
		process.exitCode = 1;
	}
} finally {
	db.close();
}
