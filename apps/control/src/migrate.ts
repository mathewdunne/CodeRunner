import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadControlConfig } from "./config";
import { applyMigrations, migrationStatus } from "./migrations";

const command = Bun.argv[2] ?? "apply";
const config = loadControlConfig();

await mkdir(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA foreign_keys = ON;");

try {
  if (command === "apply") {
    const applied = await applyMigrations(db, config.migrationsDir);
    if (applied.length === 0) {
      console.log("No pending migrations.");
    } else {
      for (const migration of applied) {
        console.log(`Applied ${migration.name}`);
      }
    }
  } else if (command === "status") {
    const statuses = await migrationStatus(db, config.migrationsDir);
    for (const status of statuses) {
      const marker = status.applied ? "applied" : "pending";
      const timestamp = status.appliedAt ? ` at ${status.appliedAt}` : "";
      console.log(`${marker.padEnd(7)} ${status.name}${timestamp}`);
    }
  } else {
    console.error(`Unknown migration command: ${command}`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
