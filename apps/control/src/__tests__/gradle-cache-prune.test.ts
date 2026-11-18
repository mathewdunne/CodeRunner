import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import { isContainerRunning } from "../containers/docker-client";
import { pruneIdleGradleCaches } from "../gradle-cache-prune";
import { createFakeDocker } from "./helpers";

const NOW = new Date("2026-11-17T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "gradle-prune-"));
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

function gradleDir(id: string): string {
	return join(dataDir, "users", id, "home", ".gradle");
}

async function seedCache(id: string): Promise<void> {
	await mkdir(join(gradleDir(id), "caches", "modules-2"), { recursive: true });
	await writeFile(join(gradleDir(id), "caches", "modules-2", "marker"), "x");
	await mkdir(join(gradleDir(id), "wrapper"), { recursive: true });
}

function hasCache(id: string): boolean {
	return existsSync(join(gradleDir(id), "caches"));
}

async function run(
	accessed: Record<string, string | null>,
	options: { isRunning?: (id: string) => Promise<boolean> } = {},
) {
	const result = await pruneIdleGradleCaches({
		dataDir,
		days: 14,
		lastAccessedAt: (id) => accessed[id] ?? null,
		isRunning: options.isRunning ?? (async () => false),
		now: NOW,
	});
	await result.removal;
	return result;
}

describe("pruneIdleGradleCaches", () => {
	test("prunes caches of a workspace idle past the cutoff", async () => {
		await seedCache("ws_old");
		const result = await run({ ws_old: daysAgo(15) });
		expect(result.pruned).toEqual(["ws_old"]);
		expect(hasCache("ws_old")).toBe(false);
		expect(existsSync(join(gradleDir("ws_old"), "wrapper"))).toBe(true);
		expect(await readdir(gradleDir("ws_old"))).toEqual(["wrapper"]);
	});

	test("keeps a recently used workspace", async () => {
		await seedCache("ws_new");
		const result = await run({ ws_new: daysAgo(1) });
		expect(result.pruned).toEqual([]);
		expect(hasCache("ws_new")).toBe(true);
	});

	test("keeps a workspace accessed exactly at the cutoff", async () => {
		await seedCache("ws_edge");
		const result = await run({ ws_edge: daysAgo(14) });
		expect(result.pruned).toEqual([]);
		expect(hasCache("ws_edge")).toBe(true);
	});

	test("prunes an orphan dir with no workspace row", async () => {
		await seedCache("ws_orphan");
		const result = await run({});
		expect(result.pruned).toEqual(["ws_orphan"]);
		expect(hasCache("ws_orphan")).toBe(false);
	});

	test("skips a running workspace", async () => {
		await seedCache("ws_live");
		const result = await run(
			{ ws_live: daysAgo(30) },
			{ isRunning: async (id) => id === "ws_live" },
		);
		expect(result.pruned).toEqual([]);
		expect(hasCache("ws_live")).toBe(true);
	});

	test("skips when isRunning throws, continuing with others", async () => {
		await seedCache("ws_a");
		await seedCache("ws_b");
		const result = await run(
			{ ws_a: daysAgo(30), ws_b: daysAgo(30) },
			{
				isRunning: async (id) => {
					if (id === "ws_a") throw new Error("docker unreachable");
					return false;
				},
			},
		);
		expect(result.pruned).toEqual(["ws_b"]);
		expect(hasCache("ws_a")).toBe(true);
		expect(hasCache("ws_b")).toBe(false);
	});

	test("keeps a workspace whose last_accessed_at is unparseable", async () => {
		await seedCache("ws_bad");
		const result = await run({ ws_bad: "not a date" });
		expect(result.pruned).toEqual([]);
		expect(hasCache("ws_bad")).toBe(true);
	});

	test("keeps a workspace accessed while its running check was in flight", async () => {
		await seedCache("ws_late");
		const accessed: Record<string, string | null> = { ws_late: daysAgo(30) };
		const result = await run(accessed, {
			isRunning: async () => {
				accessed.ws_late = NOW.toISOString();
				return false;
			},
		});
		expect(result.pruned).toEqual([]);
		expect(hasCache("ws_late")).toBe(true);
	});

	test("removes leftover caches.pruning-* dirs even for active workspaces", async () => {
		await seedCache("ws_active");
		const leftover = join(gradleDir("ws_active"), "caches.pruning-123");
		await mkdir(join(leftover, "junk"), { recursive: true });
		const result = await run({ ws_active: daysAgo(1) });
		expect(result.pruned).toEqual([]);
		expect(existsSync(leftover)).toBe(false);
		expect(hasCache("ws_active")).toBe(true);
	});

	test("ignores non-ws_ entries, files named ws_*, and workspaces without a caches dir", async () => {
		await mkdir(join(dataDir, "users", "other", "home", ".gradle", "caches"), {
			recursive: true,
		});
		await writeFile(join(dataDir, "users", "ws_file"), "not a dir");
		await mkdir(join(dataDir, "users", "ws_nocache", "home"), {
			recursive: true,
		});
		const result = await run({});
		expect(result.pruned).toEqual([]);
		expect(
			existsSync(join(dataDir, "users", "other", "home", ".gradle", "caches")),
		).toBe(true);
	});

	test("is a no-op when users/ does not exist", async () => {
		const result = await run({});
		expect(result.pruned).toEqual([]);
	});
});

describe("createApp startup prune", () => {
	async function boot(gradleCachePruneDays: number) {
		return createApp({
			dataDir,
			sessionSecret: "test-session-secret",
			baseUrl: "http://localhost:4000",
			containerAutoStart: false,
			dockerRunner: createFakeDocker().runner,
			portAvailable: async () => true,
			gradleCachePruneDays,
		});
	}

	test("prunes an idle workspace's cache shortly after boot", async () => {
		await seedCache("ws_orphan");
		const app = await boot(14);
		try {
			for (let i = 0; i < 100 && hasCache("ws_orphan"); i++) {
				await Bun.sleep(10);
			}
			expect(hasCache("ws_orphan")).toBe(false);
		} finally {
			app.close();
		}
	});

	test("does nothing when GRADLE_CACHE_PRUNE_DAYS is 0", async () => {
		await seedCache("ws_orphan");
		const app = await boot(0);
		try {
			await Bun.sleep(200);
			expect(hasCache("ws_orphan")).toBe(true);
		} finally {
			app.close();
		}
	});
});

describe("isContainerRunning", () => {
	test("is false for a missing container", async () => {
		const running = await isContainerRunning(
			async () => ({
				exitCode: 1,
				stdout: "[]",
				stderr: "Error: No such container: x",
			}),
			"x",
		);
		expect(running).toBe(false);
	});

	test("throws on other docker failures instead of reporting not running", async () => {
		await expect(
			isContainerRunning(
				async () => ({
					exitCode: 1,
					stdout: "",
					stderr:
						"permission denied while trying to connect to the Docker daemon socket",
				}),
				"x",
			),
		).rejects.toThrow(/permission denied/);
	});

	test("reads State.Running", async () => {
		const running = await isContainerRunning(
			async () => ({
				exitCode: 0,
				stdout: JSON.stringify([{ State: { Running: true } }]),
				stderr: "",
			}),
			"x",
		);
		expect(running).toBe(true);
	});
});
