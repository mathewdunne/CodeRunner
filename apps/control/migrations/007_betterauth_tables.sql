-- Better Auth migration: rename legacy auth tables and rebuild referencing
-- tables so that Better Auth can own the `user` and `session` table names.
--
-- FK checks are disabled by the migration runner before this runs.

-- 1. Rename legacy tables to free the names Better Auth expects
ALTER TABLE users RENAME TO legacy_users;
ALTER TABLE sessions RENAME TO legacy_sessions;

-- 2. Rebuild workspaces: drop FK to legacy_users, keep user_id as plain column.
--    user_id will store Better Auth–generated user IDs going forward.
CREATE TABLE workspaces_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);
INSERT INTO workspaces_new SELECT id, user_id, slug, project_path, created_at, last_accessed_at FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

-- 3. Rebuild container_leases with FK pointing to the new workspaces table.
CREATE TABLE container_leases_new (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  vscode_container TEXT,
  nt4_port INTEGER,
  vscode_port INTEGER,
  halsim_port INTEGER,
  code_state TEXT NOT NULL DEFAULT 'missing',
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO container_leases_new
  SELECT workspace_id, vscode_container, nt4_port, vscode_port, halsim_port,
         code_state, last_used_at, created_at
  FROM container_leases;
DROP TABLE container_leases;
ALTER TABLE container_leases_new RENAME TO container_leases;

CREATE UNIQUE INDEX idx_container_leases_nt4_port_unique
  ON container_leases(nt4_port) WHERE nt4_port IS NOT NULL;
CREATE UNIQUE INDEX idx_container_leases_vscode_port_unique
  ON container_leases(vscode_port) WHERE vscode_port IS NOT NULL;

-- 4. Rebuild run_jobs with FK pointing to the new workspaces table.
CREATE TABLE run_jobs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  log_path TEXT
);
INSERT INTO run_jobs_new SELECT * FROM run_jobs;
DROP TABLE run_jobs;
ALTER TABLE run_jobs_new RENAME TO run_jobs;
CREATE INDEX idx_run_jobs_workspace_id ON run_jobs(workspace_id);
