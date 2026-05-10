import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cp, mkdir, readdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ContainerRole,
  ContainerState,
  SessionId,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@frc-sim/contracts";
import { displayNameSchema } from "@frc-sim/contracts";
import type { ControlConfigInput, ControlConfig } from "./config";
import { loadControlConfig } from "./config";
import { applyMigrations } from "./migrations";

export type UserRow = {
  id: UserId;
  display_name: string;
  slug: WorkspaceSlug;
  created_at: string;
  last_seen_at: string;
};

export type WorkspaceRow = {
  id: WorkspaceId;
  user_id: UserId;
  slug: WorkspaceSlug;
  project_path: string;
  created_at: string;
  last_accessed_at: string;
};

export type SessionRow = {
  id: SessionId;
  user_id: UserId;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type ContainerLeaseRow = {
  workspace_id: WorkspaceId;
  nt4_port: number | null;
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

export type AuthContext = {
  session: SessionRow;
  user: UserRow;
  workspace: WorkspaceRow;
};

export type LoginResult = AuthContext & {
  expiresAt: Date;
};

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`The classroom name "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

function randomId(prefix: "usr" | "ws" | "ses" | "run"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function slugFromDisplayName(displayName: string): WorkspaceSlug {
  const normalized = displayName
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 40);

  return (normalized || "student") as WorkspaceSlug;
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

  constructor(configInput: ControlConfigInput = {}) {
    this.config = loadControlConfig(configInput);
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.config.dbPath), { recursive: true });
    await applyMigrations(this.db, this.config.migrationsDir);
  }

  close(): void {
    this.db.close();
  }

  findUserBySlug(slug: WorkspaceSlug): UserRow | null {
    return (
      (this.db.query("SELECT * FROM users WHERE slug = ?").get(slug) as UserRow | null) ?? null
    );
  }

  findWorkspaceByUserId(userId: UserId): WorkspaceRow | null {
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

  async createOrLoadUserWorkspace(displayNameInput: string, currentUserId: UserId | null): Promise<{
    user: UserRow;
    workspace: WorkspaceRow;
  }> {
    const displayName = displayNameSchema.parse(displayNameInput);
    const slug = slugFromDisplayName(displayName);
    const existing = this.findUserBySlug(slug);

    if (existing) {
      if (currentUserId && existing.id === currentUserId) {
        const workspace = this.findWorkspaceByUserId(existing.id);
        if (!workspace) {
          throw new Error(`User ${existing.id} has no workspace.`);
        }
        this.touchUserAndWorkspace(existing.id, workspace.id);
        return { user: existing, workspace };
      }

      throw new SlugTakenError(slug);
    }

    const userId = randomId("usr") as UserId;
    const workspaceId = randomId("ws") as WorkspaceId;
    const timestamp = nowIso();
    const projectPath = await ensureWorkspaceFiles(this.config, workspaceId);

    this.db
      .query(
        "INSERT INTO users (id, display_name, slug, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(userId, displayName, slug, timestamp, timestamp);

    this.db
      .query(
        "INSERT INTO workspaces (id, user_id, slug, project_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(workspaceId, userId, slug, projectPath, timestamp, timestamp);

    const user = this.findUserBySlug(slug);
    const workspace = this.findWorkspaceByUserId(userId);
    if (!user || !workspace) {
      throw new Error("Failed to reload newly created workspace.");
    }

    return { user, workspace };
  }

  createSession(userId: UserId): { session: SessionRow; expiresAt: Date } {
    const sessionId = randomId("ses") as SessionId;
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    this.db
      .query(
        "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, userId, timestamp, timestamp, expiresAt.toISOString());

    const session = this.db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | null;
    if (!session) {
      throw new Error("Failed to reload newly created session.");
    }

    return { session, expiresAt };
  }

  async login(displayName: string, currentUserId: UserId | null): Promise<LoginResult> {
    const { user, workspace } = await this.createOrLoadUserWorkspace(displayName, currentUserId);
    const { session, expiresAt } = this.createSession(user.id);
    return { user, workspace, session, expiresAt };
  }

  getAuthContext(sessionId: SessionId): AuthContext | null {
    const row = this.db
      .query(
        `
          SELECT
            sessions.id AS session_id,
            sessions.user_id AS session_user_id,
            sessions.created_at AS session_created_at,
            sessions.last_seen_at AS session_last_seen_at,
            sessions.expires_at AS session_expires_at,
            users.id AS user_id,
            users.display_name AS user_display_name,
            users.slug AS user_slug,
            users.created_at AS user_created_at,
            users.last_seen_at AS user_last_seen_at,
            workspaces.id AS workspace_id,
            workspaces.user_id AS workspace_user_id,
            workspaces.slug AS workspace_slug,
            workspaces.project_path AS workspace_project_path,
            workspaces.created_at AS workspace_created_at,
            workspaces.last_accessed_at AS workspace_last_accessed_at
          FROM sessions
          JOIN users ON users.id = sessions.user_id
          JOIN workspaces ON workspaces.user_id = users.id
          WHERE sessions.id = ?
        `,
      )
      .get(sessionId) as
      | {
          session_id: SessionId;
          session_user_id: UserId;
          session_created_at: string;
          session_last_seen_at: string;
          session_expires_at: string;
          user_id: UserId;
          user_display_name: string;
          user_slug: WorkspaceSlug;
          user_created_at: string;
          user_last_seen_at: string;
          workspace_id: WorkspaceId;
          workspace_user_id: UserId;
          workspace_slug: WorkspaceSlug;
          workspace_project_path: string;
          workspace_created_at: string;
          workspace_last_accessed_at: string;
        }
      | null;

    if (!row || Date.parse(row.session_expires_at) <= Date.now()) {
      return null;
    }

    return {
      session: {
        id: row.session_id,
        user_id: row.session_user_id,
        created_at: row.session_created_at,
        last_seen_at: row.session_last_seen_at,
        expires_at: row.session_expires_at,
      },
      user: {
        id: row.user_id,
        display_name: row.user_display_name,
        slug: row.user_slug,
        created_at: row.user_created_at,
        last_seen_at: row.user_last_seen_at,
      },
      workspace: {
        id: row.workspace_id,
        user_id: row.workspace_user_id,
        slug: row.workspace_slug,
        project_path: row.workspace_project_path,
        created_at: row.workspace_created_at,
        last_accessed_at: row.workspace_last_accessed_at,
      },
    };
  }

  touchUserAndWorkspace(userId: UserId, workspaceId: WorkspaceId): void {
    const timestamp = nowIso();
    this.db.query("UPDATE users SET last_seen_at = ? WHERE id = ?").run(timestamp, userId);
    this.db
      .query("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?")
      .run(timestamp, workspaceId);
  }

  touchSession(auth: AuthContext): void {
    const timestamp = nowIso();
    this.db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(timestamp, auth.session.id);
    this.touchUserAndWorkspace(auth.user.id, auth.workspace.id);
  }

  deleteSession(sessionId: SessionId): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  getContainerLease(workspaceId: WorkspaceId): ContainerLeaseRow | null {
    return (
      (this.db.query("SELECT * FROM container_leases WHERE workspace_id = ?").get(workspaceId) as
        | ContainerLeaseRow
        | null) ?? null
    );
  }

  listLeasedPorts(role: ContainerRole, exceptWorkspaceId?: WorkspaceId): number[] {
    const column = role === "sim" ? "nt4_port" : "vscode_port";
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
            code_state,
            last_used_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            vscode_container = excluded.vscode_container,
            nt4_port = excluded.nt4_port,
            vscode_port = excluded.vscode_port,
            code_state = excluded.code_state,
            last_used_at = excluded.last_used_at
        `,
      )
      .run(
        input.workspaceId,
        input.containerName,
        input.simPort,
        input.vscodePort,
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
    user: UserRow;
    lease: ContainerLeaseRow | null;
  }> {
    const rows = this.db
      .query(
        `
          SELECT
            w.id AS w_id, w.user_id AS w_user_id, w.slug AS w_slug,
            w.project_path AS w_project_path, w.created_at AS w_created_at,
            w.last_accessed_at AS w_last_accessed_at,
            u.id AS u_id, u.display_name AS u_display_name, u.slug AS u_slug,
            u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at,
            cl.workspace_id AS cl_workspace_id, cl.nt4_port,
            cl.vscode_container, cl.vscode_port, cl.code_state AS cl_code_state,
            cl.last_used_at AS cl_last_used_at, cl.created_at AS cl_created_at
          FROM workspaces w
          JOIN users u ON u.id = w.user_id
          LEFT JOIN container_leases cl ON cl.workspace_id = w.id
          ORDER BY w.last_accessed_at DESC
        `,
      )
      .all() as Array<{
        w_id: WorkspaceId;
        w_user_id: UserId;
        w_slug: WorkspaceSlug;
        w_project_path: string;
        w_created_at: string;
        w_last_accessed_at: string;
        u_id: UserId;
        u_display_name: string;
        u_slug: WorkspaceSlug;
        u_created_at: string;
        u_last_seen_at: string;
        cl_workspace_id: WorkspaceId | null;
        nt4_port: number | null;
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
        id: row.u_id,
        display_name: row.u_display_name,
        slug: row.u_slug,
        created_at: row.u_created_at,
        last_seen_at: row.u_last_seen_at,
      },
      lease: row.cl_workspace_id
        ? {
            workspace_id: row.cl_workspace_id,
            nt4_port: row.nt4_port,
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
