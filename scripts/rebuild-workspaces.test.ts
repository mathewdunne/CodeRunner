import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DockerCommandResult,
	type DockerRunner,
	rebuildWorkspaces,
} from "./rebuild-workspaces";

const tempDirs: string[] = [];

function ok(stdout = ""): DockerCommandResult {
	return { stdout, stderr: "", exitCode: 0 };
}

async function tempDb(): Promise<{ db: Database; dbPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "coderunner-rebuild-"));
	tempDirs.push(dir);
	const dbPath = join(dir, "app.db");
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE container_leases (
			workspace_id TEXT PRIMARY KEY,
			vscode_container TEXT,
			nt4_port INTEGER,
			vscode_port INTEGER,
			halsim_port INTEGER,
			code_state TEXT NOT NULL DEFAULT 'missing',
			last_used_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	return { db, dbPath };
}

function insertLease(
	db: Database,
	workspaceId: string,
	state: string,
	containerName: string | null,
): void {
	db.query(
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
		`,
	).run(
		workspaceId,
		containerName,
		25810,
		33000,
		34000,
		state,
		"2026-01-01T00:00:00.000Z",
		"2026-01-01T00:00:00.000Z",
	);
}

function leases(db: Database): Array<{
	workspace_id: string;
	vscode_container: string | null;
	nt4_port: number | null;
	vscode_port: number | null;
	halsim_port: number | null;
	code_state: string;
}> {
	return db
		.query(
			`
				SELECT workspace_id, vscode_container, nt4_port, vscode_port, halsim_port, code_state
				FROM container_leases
				ORDER BY workspace_id
			`,
		)
		.all() as ReturnType<typeof leases>;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

describe("rebuildWorkspaces", () => {
	test("dry-run removes nothing and leaves leases unchanged", async () => {
		const { db, dbPath } = await tempDb();
		try {
			insertLease(db, "ws_a", "running", "coderunner-ws_a-code");
			const calls: string[][] = [];
			const dockerRunner: DockerRunner = async (args) => {
				calls.push(args);
				return ok("coderunner-ws_a-code\n");
			};

			const result = await rebuildWorkspaces({
				dbPath,
				dockerRunner,
				dryRun: true,
				logger: { error: () => {}, log: () => {} },
			});

			expect(result).toEqual({
				found: ["coderunner-ws_a-code"],
				removed: [],
				leasesCleared: 0,
				dryRun: true,
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]).toContain("label=frc-sim.managed=true");
			expect(calls[0]).toContain("label=frc-sim.version=v2");
			expect(leases(db)[0]).toMatchObject({
				code_state: "running",
				halsim_port: 34000,
				nt4_port: 25810,
				vscode_container: "coderunner-ws_a-code",
				vscode_port: 33000,
			});
		} finally {
			db.close();
		}
	});

	test("removes only Docker containers returned by the managed V2 label query", async () => {
		const { db, dbPath } = await tempDb();
		try {
			insertLease(db, "ws_a", "running", "coderunner-ws_a-code");
			const calls: string[][] = [];
			const dockerRunner: DockerRunner = async (args) => {
				calls.push(args);
				if (args[0] === "container") {
					return ok("coderunner-ws_a-code\ncoderunner-ws_b-code\n");
				}
				return ok();
			};

			const result = await rebuildWorkspaces({
				dbPath,
				dockerRunner,
				logger: { error: () => {}, log: () => {} },
			});

			expect(result.removed).toEqual([
				"coderunner-ws_a-code",
				"coderunner-ws_b-code",
			]);
			expect(calls).toEqual([
				[
					"container",
					"ls",
					"-a",
					"--filter",
					"label=frc-sim.managed=true",
					"--filter",
					"label=frc-sim.version=v2",
					"--format",
					"{{.Names}}",
				],
				["rm", "-f", "coderunner-ws_a-code"],
				["rm", "-f", "coderunner-ws_b-code"],
			]);
		} finally {
			db.close();
		}
	});

	test("clears container leases after removing managed V2 containers", async () => {
		const { db, dbPath } = await tempDb();
		try {
			insertLease(db, "ws_a", "running", "coderunner-ws_a-code");
			insertLease(db, "ws_b", "stopped", "coderunner-ws_b-code");
			const dockerRunner: DockerRunner = async (args) =>
				args[0] === "container"
					? ok("coderunner-ws_a-code\ncoderunner-ws_b-code\n")
					: ok();

			const result = await rebuildWorkspaces({
				dbPath,
				dockerRunner,
				logger: { error: () => {}, log: () => {} },
			});

			expect(result.leasesCleared).toBe(2);
			expect(leases(db)).toEqual([
				{
					workspace_id: "ws_a",
					vscode_container: null,
					nt4_port: null,
					vscode_port: null,
					halsim_port: null,
					code_state: "missing",
				},
				{
					workspace_id: "ws_b",
					vscode_container: null,
					nt4_port: null,
					vscode_port: null,
					halsim_port: null,
					code_state: "missing",
				},
			]);
		} finally {
			db.close();
		}
	});
});
