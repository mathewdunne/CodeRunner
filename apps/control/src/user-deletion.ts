import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunManager } from "./runs";
import type { WorkspaceRuntimeProvider } from "./runtime";
import type { AppStorage } from "./storage";

export type UserDeletionContext = {
	storage: AppStorage;
	runs: RunManager;
	runtimeProvider: WorkspaceRuntimeProvider;
};

/**
 * Stop and remove a user's container, delete the user with their sessions,
 * accounts and workspace rows, then remove their data directory. Callers own
 * authorization, guards (e.g. last admin), and audit events.
 */
export async function deleteUserAndWorkspace(
	ctx: UserDeletionContext,
	userId: string,
): Promise<void> {
	const { storage, runs, runtimeProvider } = ctx;
	const workspace = storage.findWorkspaceByUserId(userId);
	if (workspace) {
		runs.stopWorkspace(workspace.id);
		await runtimeProvider.stopWorkspace(workspace.id);
		await runtimeProvider.removeWorkspace(workspace.id);
	}

	storage.db.exec("BEGIN");
	try {
		if (workspace) {
			storage.db
				.query("DELETE FROM run_jobs WHERE workspace_id = ?")
				.run(workspace.id);
			storage.db
				.query("DELETE FROM container_leases WHERE workspace_id = ?")
				.run(workspace.id);
			storage.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
		}
		storage.db.query("DELETE FROM session WHERE userId = ?").run(userId);
		storage.db.query("DELETE FROM account WHERE userId = ?").run(userId);
		storage.db.query("DELETE FROM user WHERE id = ?").run(userId);
		storage.db.exec("COMMIT");
	} catch (error) {
		storage.db.exec("ROLLBACK");
		throw error;
	}

	if (workspace) {
		await rm(dirname(workspace.project_path), {
			recursive: true,
			force: true,
		});
	}
}
