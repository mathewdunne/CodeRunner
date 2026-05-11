import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cp, mkdir, readdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ContainerRole,
  ContainerState,
  WorkspaceId,
  WorkspaceSlug,
} from "@frc-sim/contracts";
import type { ControlConfigInput, ControlConfig } from "./config";
import { loadControlConfig } from "./config";
import { applyMigrations } from "./migrations";
import { createAuth, type Auth } from "./auth/auth";
import { setAllowlistPath, loadAllowlist } from "./auth/allowlist";

export type WorkspaceRow = {
  id: WorkspaceId;
  user_id: string;
  slug: WorkspaceSlug;
  project_path: string;
  created_at: string;
  last_accessed_at: string;
};

export type ContainerLeaseRow = {
  workspace_id: WorkspaceId;
  nt4_port: number | null;
  halsim_port: number | null;
  vscode_container: string | null;
  vscode_port: number | null;
  code_state: ContainerState;
  last_used_at: string;
  created_at: string;
};

export type RunJobState = "building" | "running" | "failed" | "stopped";

export type RunJobRow = {
  id: string;
  workspace_id: WorkspaceId;
  state: RunJobState;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  log_path: string | null;
};

/** Context returned by Better Auth session resolution + workspace lookup. */
export type AuthContext = {
  user: { id: string; email: string; name: string; role: string; slug: string };
  workspace: WorkspaceRow;
};

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`The classroom name "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

function randomId(prefix: "ws" | "run"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureWorkspaceFiles(config: ControlConfig, workspaceId: WorkspaceId): Promise<string> {
  const workspaceDir = resolve(config.dataDir, "users", workspaceId);
  const projectDir = resolve(workspaceDir, "project");
  const homeDir = resolve(workspaceDir, "home");

  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(resolve(workspaceDir, "logs", "runs"), { recursive: true });

  try {
    await chmod(homeDir, 0o700);
  } catch {
    // Windows filesystems may ignore POSIX modes; the Linux Docker host enforces ownership at runtime.
  }

  if ((await readdir(projectDir)).length === 0) {
    await cp(config.templateDir, projectDir, { recursive: true, errorOnExist: false });
  }

  return projectDir;
}

export class AppStorage {
  readonly config: ControlConfig;
  readonly db: Database;
  auth!: Auth;

  constructor(configInput: ControlConfigInput = {}) {
    this.config = loadControlConfig(configInput);
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.config.dbPath), { recursive: true });

    // 1. Run our migrations (including the Better Auth schema handoff).
    await applyMigrations(this.db, this.config.migrationsDir);

    // 2. Initialize allowlist
    setAllowlistPath(this.config.dataDir);
    await loadAllowlist();

    // 3. Create Better Auth instance and run its migrations
    this.auth = createAuth(this.db, this.config, {
      ensureWorkspace: async (userId, slug) => {
        await this.ensureWorkspaceForUser(userId, slug);
      },
    });
    const { getMigrations } = await import("better-auth/db/migration");
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
  }

  close(): void {
    this.db.close();
  }

  findWorkspaceByUserId(userId: string): WorkspaceRow | null {
    return (
      (this.db.query("SELECT * FROM workspaces WHERE user_id = ?").get(userId) as WorkspaceRow | null) ??
      null
    );
  }

  findWorkspaceBySlug(slug: WorkspaceSlug): WorkspaceRow | null {
    return (
      (this.db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as WorkspaceRow | null) ??
      null
    );
  }

  findWorkspaceById(workspaceId: WorkspaceId): WorkspaceRow | null {
    return (
      (this.db.query("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | null) ??
      null
    );
  }

  /** Create a workspace for a Better Auth user (called on first login). */
  async ensureWorkspaceForUser(userId: string, slug: string): Promise<WorkspaceRow> {
    const existing = this.findWorkspaceByUserId(userId);
    if (existing) {
      this.touchWorkspace(existing.id);
      return existing;
    }

    // Reserve the row first (slug uniqueness enforced by the DB), then
    // materialize project files. If two concurrent first-logins pick the
    // same base slug, the second INSERT loses the race on the UNIQUE
    // constraint and we retry with a suffix.
    const baseSlug = slug.slice(0, 40) || "student";
    const workspaceId = randomId("ws") as WorkspaceId;
    const timestamp = nowIso();
    const placeholderProjectPath = resolve(this.config.dataDir, "users", workspaceId, "project");

    let finalSlug: WorkspaceSlug | null = null;
    const MAX_ATTEMPTS = 16;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = attempt === 0
        ? (baseSlug as WorkspaceSlug)
        : (`${baseSlug.slice(0, 40 - `-${attempt}`.length)}-${attempt}` as WorkspaceSlug);

      if (this.findWorkspaceBySlug(candidate)) continue;

      try {
        const transaction = this.db.transaction(() => {
          this.db
            .query(
              "INSERT INTO workspaces (id, user_id, slug, project_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(workspaceId, userId, candidate, placeholderProjectPath, timestamp, timestamp);
          this.db
            .query("UPDATE user SET slug = ?, updatedAt = ? WHERE id = ?")
            .run(candidate, timestamp, userId);
        });
        transaction();
        finalSlug = candidate;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only retry on the slug uniqueness collision. Anything else (e.g.
        // a UNIQUE on user_id) means the caller is wrong, so rethrow.
        if (message.includes("workspaces.slug")) continue;
        throw error;
      }
    }

    if (!finalSlug) {
      throw new Error(`Could not allocate a unique workspace slug for base "${baseSlug}".`);
    }

    try {
      const projectPath = await ensureWorkspaceFiles(this.config, workspaceId);
      if (projectPath !== placeholderProjectPath) {
        this.db
          .query("UPDATE workspaces SET project_path = ? WHERE id = ?")
          .run(projectPath, workspaceId);
      }
    } catch (error) {
      this.db.query("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      throw error;
    }

    const workspace = this.findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new Error("Failed to reload newly created workspace.");
    }

    return workspace;
  }

  touchWorkspace(workspaceId: WorkspaceId): void {
    const timestamp = nowIso();
    this.db
      .query("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?")
      .run(timestamp, workspaceId);
  }

  getContainerLease(workspaceId: WorkspaceId): ContainerLeaseRow | null {
    return (
      (this.db.query("SELECT * FROM container_leases WHERE workspace_id = ?").get(workspaceId) as
        | ContainerLeaseRow
        | null) ?? null
    );
  }

  listLeasedPorts(role: ContainerRole, exceptWorkspaceId?: WorkspaceId): number[] {
    const column = role === "sim" ? "nt4_port" : role === "halsim" ? "halsim_port" : "vscode_port";
    const rows = (
      exceptWorkspaceId
        ? this.db
            .query(`SELECT ${column} AS port FROM container_leases WHERE ${column} IS NOT NULL AND workspace_id != ?`)
            .all(exceptWorkspaceId)
        : this.db.query(`SELECT ${column} AS port FROM container_leases WHERE ${column} IS NOT NULL`).all()
    ) as Array<{ port: number }>;
    return rows.map((row) => row.port);
  }

  clearReservedPort(role: ContainerRole, workspaceId: WorkspaceId, port: number): void {
    const timestamp = nowIso();
    if (role === "sim") {
      this.db
        .query(
          `
            UPDATE container_leases
            SET nt4_port = NULL,
                code_state = ?,
                last_used_at = ?
            WHERE workspace_id = ?
              AND nt4_port = ?
          `,
        )
        .run("error", timestamp, workspaceId, port);
    } else if (role === "halsim") {
      this.db
        .query(
          `
            UPDATE container_leases
            SET halsim_port = NULL,
                code_state = ?,
                last_used_at = ?
            WHERE workspace_id = ?
              AND halsim_port = ?
          `,
        )
        .run("error", timestamp, workspaceId, port);
    } else {
      this.db
        .query(
          `
            UPDATE container_leases
            SET vscode_port = NULL,
                code_state = ?,
                last_used_at = ?
            WHERE workspace_id = ?
              AND vscode_port = ?
          `,
        )
        .run("error", timestamp, workspaceId, port);
    }
  }

  upsertCodeContainerLease(input: {
    workspaceId: WorkspaceId;
    containerName: string;
    simPort: number | null;
    vscodePort: number | null;
    halsimPort: number | null;
    state: ContainerState;
  }): ContainerLeaseRow {
    const timestamp = nowIso();
    this.db
      .query(
        `
          INSERT INTO container_leases (
            workspace_id,
            vscode_container,
            nt4_port,
            vscode_port,
            halsim_port,
            code_state,
            last_used_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            vscode_container = excluded.vscode_container,
            nt4_port = excluded.nt4_port,
            vscode_port = excluded.vscode_port,
            halsim_port = excluded.halsim_port,
            code_state = excluded.code_state,
            last_used_at = excluded.last_used_at
        `,
      )
      .run(
        input.workspaceId,
        input.containerName,
        input.simPort,
        input.vscodePort,
        input.halsimPort,
        input.state,
        timestamp,
        timestamp,
      );

    const lease = this.getContainerLease(input.workspaceId);
    if (!lease) {
      throw new Error(`Failed to reload container lease for workspace ${input.workspaceId}.`);
    }
    return lease;
  }

  touchContainerLeaseActivity(workspaceId: WorkspaceId): void {
    const timestamp = nowIso();
    this.db
      .query("UPDATE container_leases SET last_used_at = ? WHERE workspace_id = ?")
      .run(timestamp, workspaceId);
  }

  listAllWorkspacesWithLeases(): Array<{
    workspace: WorkspaceRow;
    user: { id: string; name: string; email: string; role: string; slug: string | null };
    lease: ContainerLeaseRow | null;
  }> {
    const rows = this.db
      .query(
        `
          SELECT
            w.id AS w_id, w.user_id AS w_user_id, w.slug AS w_slug,
            w.project_path AS w_project_path, w.created_at AS w_created_at,
            w.last_accessed_at AS w_last_accessed_at,
            u.id AS u_id, u.name AS u_name, u.email AS u_email,
            u.role AS u_role, u.slug AS u_slug,
            cl.workspace_id AS cl_workspace_id, cl.nt4_port,
            cl.vscode_container, cl.vscode_port, cl.halsim_port, cl.code_state AS cl_code_state,
            cl.last_used_at AS cl_last_used_at, cl.created_at AS cl_created_at
          FROM workspaces w
          LEFT JOIN user u ON u.id = w.user_id
          LEFT JOIN container_leases cl ON cl.workspace_id = w.id
          ORDER BY w.last_accessed_at DESC
        `,
      )
      .all() as Array<{
        w_id: WorkspaceId;
        w_user_id: string;
        w_slug: WorkspaceSlug;
        w_project_path: string;
        w_created_at: string;
        w_last_accessed_at: string;
        u_id: string | null;
        u_name: string | null;
        u_email: string | null;
        u_role: string | null;
        u_slug: string | null;
        cl_workspace_id: WorkspaceId | null;
        nt4_port: number | null;
        halsim_port: number | null;
        vscode_container: string | null;
        vscode_port: number | null;
        cl_code_state: ContainerState | null;
        cl_last_used_at: string | null;
        cl_created_at: string | null;
      }>;

    return rows.map((row) => ({
      workspace: {
        id: row.w_id,
        user_id: row.w_user_id,
        slug: row.w_slug,
        project_path: row.w_project_path,
        created_at: row.w_created_at,
        last_accessed_at: row.w_last_accessed_at,
      },
      user: {
        id: row.u_id ?? row.w_user_id,
        name: row.u_name ?? "Unknown",
        email: row.u_email ?? "",
        role: row.u_role ?? "student",
        slug: row.u_slug,
      },
      lease: row.cl_workspace_id
        ? {
            workspace_id: row.cl_workspace_id,
            nt4_port: row.nt4_port,
            halsim_port: row.halsim_port,
            vscode_container: row.vscode_container,
            vscode_port: row.vscode_port,
            code_state: (row.cl_code_state ?? "missing") as ContainerState,
            last_used_at: row.cl_last_used_at!,
            created_at: row.cl_created_at!,
          }
        : null,
    }));
  }

  listIdleWorkspaceIds(idleMinutes: number): WorkspaceId[] {
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    const rows = this.db
      .query(
        `
          SELECT w.id
          FROM workspaces w
          JOIN container_leases cl ON cl.workspace_id = w.id
          WHERE w.last_accessed_at < ?
            AND cl.code_state IN ('running', 'starting')
        `,
      )
      .all(cutoff) as Array<{ id: WorkspaceId }>;
    return rows.map((row) => row.id);
  }

  createRunJob(input: {
    workspaceId: WorkspaceId;
    logPath: string;
    id?: string;
  }): RunJobRow {
    const id = input.id ?? randomId("run");
    const timestamp = nowIso();
    this.db
      .query(
        `
          INSERT INTO run_jobs (
            id,
            workspace_id,
            state,
            requested_at,
            log_path
          )
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(id, input.workspaceId, "building", timestamp, input.logPath);

    const row = this.getRunJob(id);
    if (!row) {
      throw new Error(`Failed to reload run job ${id}.`);
    }
    return row;
  }

  getRunJob(id: string): RunJobRow | null {
    return (this.db.query("SELECT * FROM run_jobs WHERE id = ?").get(id) as RunJobRow | null) ?? null;
  }

  updateRunJob(input: {
    id: string;
    state: RunJobState;
    started?: boolean;
    finished?: boolean;
    exitCode?: number | null;
  }): RunJobRow {
    const timestamp = nowIso();
    const existing = this.getRunJob(input.id);
    if (!existing) {
      throw new Error(`Run job ${input.id} does not exist.`);
    }

    this.db
      .query(
        `
          UPDATE run_jobs
          SET
            state = ?,
            started_at = ?,
            finished_at = ?,
            exit_code = ?
          WHERE id = ?
        `,
      )
      .run(
        input.state,
        input.started ? (existing.started_at ?? timestamp) : existing.started_at,
        input.finished ? (existing.finished_at ?? timestamp) : existing.finished_at,
        input.exitCode === undefined ? existing.exit_code : input.exitCode,
        input.id,
      );

    const row = this.getRunJob(input.id);
    if (!row) {
      throw new Error(`Failed to reload run job ${input.id}.`);
    }
    return row;
  }
}

export async function createStorage(configInput: ControlConfigInput = {}): Promise<AppStorage> {
  const storage = new AppStorage(configInput);
  await storage.initialize();
  return storage;
}
