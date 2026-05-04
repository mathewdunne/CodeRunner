import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type ControlConfig = {
  dataDir: string;
  dbPath: string;
  templateDir: string;
  migrationsDir: string;
  webDistDir: string;
  sessionSecret: string;
};

export type ControlConfigInput = Partial<ControlConfig>;

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultDataDir = resolve(repoRoot, "data");

export function loadControlConfig(input: ControlConfigInput = {}): ControlConfig {
  const dataDir = resolve(input.dataDir ?? Bun.env.FRC_DATA_DIR ?? defaultDataDir);

  return {
    dataDir,
    dbPath: resolve(input.dbPath ?? Bun.env.FRC_DB_PATH ?? resolve(dataDir, "app.db")),
    templateDir: resolve(
      input.templateDir ?? Bun.env.FRC_TEMPLATE_DIR ?? resolve(repoRoot, "templates", "wpilib-java-command"),
    ),
    migrationsDir: resolve(
      input.migrationsDir ??
        Bun.env.FRC_MIGRATIONS_DIR ??
        fileURLToPath(new URL("../migrations", import.meta.url)),
    ),
    webDistDir: resolve(input.webDistDir ?? Bun.env.FRC_WEB_DIST_DIR ?? resolve(repoRoot, "apps", "web", "dist")),
    sessionSecret:
      input.sessionSecret ??
      Bun.env.FRC_SESSION_SECRET ??
      "frc-v1-local-dev-session-secret-change-me",
  };
}
