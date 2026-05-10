import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export type Migration = {
  name: string;
  checksum: string;
  sql: string;
};

export type MigrationStatus = Migration & {
  applied: boolean;
  appliedAt: string | null;
};

type AppliedMigrationRow = {
  name: string;
  checksum: string;
  applied_at: string;
};

export async function loadMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ name, checksum, sql });
  }

  return migrations;
}

export function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function listAppliedMigrations(db: Database): AppliedMigrationRow[] {
  ensureMigrationTable(db);
  return db
    .query("SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name")
    .all() as AppliedMigrationRow[];
}

export function verifyAppliedMigrationChecksums(db: Database, migrations: Migration[]): void {
  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));

  for (const applied of listAppliedMigrations(db)) {
    const migration = migrationsByName.get(applied.name);
    if (!migration) {
      throw new Error(`Applied migration ${applied.name} is missing from disk.`);
    }

    if (migration.checksum !== applied.checksum) {
      throw new Error(
        `Applied migration ${applied.name} checksum changed. Expected ${applied.checksum}, found ${migration.checksum}.`,
      );
    }
  }
}

export async function migrationStatus(db: Database, migrationsDir: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(migrationsDir);
  verifyAppliedMigrationChecksums(db, migrations);

  const appliedByName = new Map(listAppliedMigrations(db).map((row) => [row.name, row]));
  return migrations.map((migration) => {
    const applied = appliedByName.get(migration.name);
    return {
      ...migration,
      applied: Boolean(applied),
      appliedAt: applied?.applied_at ?? null,
    };
  });
}

export async function applyMigrations(db: Database, migrationsDir: string): Promise<Migration[]> {
  const migrations = await loadMigrations(migrationsDir);
  verifyAppliedMigrationChecksums(db, migrations);

  const appliedNames = new Set(listAppliedMigrations(db).map((row) => row.name));
  const pending = migrations.filter((migration) => !appliedNames.has(migration.name));

  for (const migration of pending) {
    // Disable FK checks during migration to allow table rebuilds and renames.
    // Schema-level FK constraints are still defined; they're enforced at runtime.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)").run(
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }

  return pending;
}
