import type { Dirent } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "./logging";

const log = getLogger("gradle-prune");

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNING_PREFIX = "caches.pruning-";

export type GradleCachePruneOptions = {
	dataDir: string;
	days: number;
	/** The workspace's last_accessed_at, or null when it has no workspace row. */
	lastAccessedAt: (workspaceId: string) => string | null;
	isRunning: (workspaceId: string) => Promise<boolean>;
	now?: Date;
};

export type GradleCachePruneResult = {
	pruned: string[];
	/** Resolves once every renamed cache is deleted. Never rejects. */
	removal: Promise<void>;
};

async function listDirs(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Delete `home/.gradle/caches` of every workspace idle longer than `days`
 * (decision 049). The image re-seeds a missing cache on the next container
 * start, so this only costs that start a copy.
 *
 * Each cache is first renamed to `caches.pruning-<ts>` — atomic, so a
 * container starting mid-prune sees no `caches/` and re-seeds cleanly instead
 * of keeping a half-deleted one — then deleted in the background along with
 * any such leftovers from an interrupted run.
 */
export async function pruneIdleGradleCaches(
	options: GradleCachePruneOptions,
): Promise<GradleCachePruneResult> {
	const now = options.now ?? new Date();
	const cutoff = now.getTime() - options.days * DAY_MS;
	const usersDir = join(options.dataDir, "users");
	const pruned: string[] = [];
	const gradleDirs: string[] = [];

	for (const entry of await listDirs(usersDir)) {
		if (!entry.isDirectory() || !entry.name.startsWith("ws_")) continue;
		const workspaceId = entry.name;
		const gradleDir = join(usersDir, workspaceId, "home", ".gradle");
		gradleDirs.push(gradleDir);
		// An unparseable timestamp counts as recent: keep rather than guess.
		const isIdle = () => {
			const accessed = options.lastAccessedAt(workspaceId);
			if (accessed === null) return true;
			const time = Date.parse(accessed);
			return !Number.isNaN(time) && time < cutoff;
		};
		try {
			if (!isIdle()) continue;
			const hasCaches = (await listDirs(gradleDir)).some(
				(child) => child.isDirectory() && child.name === "caches",
			);
			if (!hasCaches) continue;
			if (await options.isRunning(workspaceId)) continue;
			// Re-check: a sign-in during the awaits above bumps last_accessed_at.
			if (!isIdle()) continue;
			await rename(
				join(gradleDir, "caches"),
				join(gradleDir, `${PRUNING_PREFIX}${now.getTime()}`),
			);
			pruned.push(workspaceId);
		} catch (err) {
			log.warn("skipped Gradle cache prune for workspace", {
				workspaceId,
				err,
			});
		}
	}

	return { pruned, removal: removePruned(gradleDirs) };
}

async function removePruned(gradleDirs: string[]): Promise<void> {
	for (const gradleDir of gradleDirs) {
		for (const child of await listDirs(gradleDir)) {
			if (!child.name.startsWith(PRUNING_PREFIX)) continue;
			const path = join(gradleDir, child.name);
			try {
				await rm(path, { recursive: true, force: true });
			} catch (err) {
				log.warn("failed to delete pruned Gradle cache", { path, err });
			}
		}
	}
}
