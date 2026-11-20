import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	flattenLessonModules,
	isLessonFolder,
} from "@frc-coderunner/contracts";
import {
	BundledCatalogSource,
	createCatalogSource,
	parseCatalogRepo,
	RemoteCatalogSource,
} from "../catalog";
import type { ControlConfig } from "../config";
import { ImportError } from "../imports";

const MANIFEST = {
	schemaVersion: 1,
	modules: [
		{
			id: "robot-starter",
			title: "Robot Starter",
			description: "A robot.",
			subdir: "modules/robot-starter",
			kind: "robot",
			order: 20,
		},
		{
			id: "hello-world",
			title: "Hello, World",
			description: "Plain java.",
			subdir: "modules/hello-world",
			kind: "plain-java",
			order: 10,
		},
	],
};

async function makeBundledCatalog(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "frc-catalog-"));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "modules.json"), JSON.stringify(MANIFEST), "utf8");
	return dir;
}

describe("BundledCatalogSource", () => {
	test("reads modules sorted by order", async () => {
		const dir = await makeBundledCatalog();
		try {
			const source = new BundledCatalogSource(dir);
			const { modules, error } = await source.getManifest();
			expect(error).toBeNull();
			expect(flattenLessonModules(modules).map((m) => m.id)).toEqual([
				"hello-world",
				"robot-starter",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("sorts modules and folders by order at each level", async () => {
		const dir = await mkdtemp(join(tmpdir(), "frc-catalog-folders-"));
		const module = (id: string, order: number) => ({
			id,
			title: id,
			description: "",
			subdir: `modules/${id}`,
			kind: "robot",
			order,
		});
		try {
			await writeFile(
				join(dir, "modules.json"),
				JSON.stringify({
					schemaVersion: 1,
					modules: [
						module("last", 50),
						{
							folder: "Course",
							order: 20,
							modules: [
								module("stage-1", 40),
								{
									folder: "Advanced",
									order: 10,
									modules: [module("stage-2", 10)],
								},
							],
						},
						module("first", 10),
					],
				}),
				"utf8",
			);
			const source = new BundledCatalogSource(dir);
			const { modules, error } = await source.getManifest();
			expect(error).toBeNull();
			expect(modules[0]).toMatchObject({ id: "first" });
			expect(modules[1]).toMatchObject({ folder: "Course" });
			expect(modules[2]).toMatchObject({ id: "last" });
			const course = modules[1];
			expect(
				course && isLessonFolder(course)
					? course.modules.map((entry) =>
							isLessonFolder(entry) ? entry.folder : entry.id,
						)
					: [],
			).toEqual(["Advanced", "stage-1"]);
			expect(flattenLessonModules(modules).map((m) => m.id)).toEqual([
				"first",
				"stage-2",
				"stage-1",
				"last",
			]);
			expect((await source.resolveModule("stage-2")).kind).toBe("robot");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("resolveModule finds a module and throws on unknown id", async () => {
		const dir = await makeBundledCatalog();
		try {
			const source = new BundledCatalogSource(dir);
			const module = await source.resolveModule("hello-world");
			expect(module.kind).toBe("plain-java");
			expect(module.subdir).toBe("modules/hello-world");
			await expect(source.resolveModule("nope")).rejects.toThrow(ImportError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("reads a standalone repo module without a subdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "frc-catalog-repo-"));
		try {
			await writeFile(
				join(dir, "modules.json"),
				JSON.stringify({
					schemaVersion: 1,
					modules: [
						{
							id: "java-fundamentals",
							title: "Java Fundamentals",
							description: "From frcsoftware.org.",
							repo: "frcsoftware/java-fundamentals",
							kind: "plain-java",
							order: 10,
						},
					],
				}),
				"utf8",
			);
			const source = new BundledCatalogSource(dir);
			const { modules, error } = await source.getManifest();
			expect(error).toBeNull();
			const [module] = flattenLessonModules(modules);
			expect(module).toMatchObject({
				id: "java-fundamentals",
				repo: "frcsoftware/java-fundamentals",
				preserveGit: false,
			});
			expect(module?.subdir).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("surfaces an error string when the manifest is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "frc-catalog-empty-"));
		try {
			const source = new BundledCatalogSource(dir);
			const { modules, error } = await source.getManifest();
			expect(modules).toEqual([]);
			expect(error).toBeTruthy();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("surfaces an error string when a bundled manifest has an unsafe subdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "frc-catalog-unsafe-"));
		try {
			await writeFile(
				join(dir, "modules.json"),
				JSON.stringify({
					schemaVersion: 1,
					modules: [{ ...MANIFEST.modules[0], subdir: "../escape" }],
				}),
				"utf8",
			);
			const source = new BundledCatalogSource(dir);
			const { modules, error } = await source.getManifest();
			expect(modules).toEqual([]);
			expect(error).toBeTruthy();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("parseCatalogRepo", () => {
	test("parses https and shorthand forms", () => {
		expect(parseCatalogRepo("https://github.com/owner/repo")).toEqual({
			owner: "owner",
			repo: "repo",
		});
		expect(parseCatalogRepo("https://github.com/owner/repo.git")).toEqual({
			owner: "owner",
			repo: "repo",
		});
		expect(parseCatalogRepo("owner/repo")).toEqual({
			owner: "owner",
			repo: "repo",
		});
	});

	test("rejects garbage", () => {
		expect(() => parseCatalogRepo("not a repo")).toThrow(ImportError);
	});
});

describe("RemoteCatalogSource", () => {
	function stubFetch(
		responder: (url: string) => { ok: boolean; body: unknown; status?: number },
	): { fetch: typeof fetch; calls: string[] } {
		const calls: string[] = [];
		const fetchImpl = (async (input: unknown) => {
			const url = String(input);
			calls.push(url);
			const res = responder(url);
			return {
				ok: res.ok,
				status: res.status ?? (res.ok ? 200 : 500),
				json: async () => res.body,
			} as Response;
		}) as typeof fetch;
		return { fetch: fetchImpl, calls };
	}

	test("fetches the raw manifest, sorts, and caches within the TTL", async () => {
		const { fetch: fetchImpl, calls } = stubFetch(() => ({
			ok: true,
			body: MANIFEST,
		}));
		const source = new RemoteCatalogSource(
			"https://github.com/owner/lessons",
			"main",
			fetchImpl,
		);
		expect(source.cloneUrl).toBe("https://github.com/owner/lessons.git");
		expect(source.branchName).toBe("main");

		const first = await source.getManifest();
		expect(first.error).toBeNull();
		expect(flattenLessonModules(first.modules).map((m) => m.id)).toEqual([
			"hello-world",
			"robot-starter",
		]);
		expect(calls[0]).toBe(
			"https://raw.githubusercontent.com/owner/lessons/main/modules.json",
		);

		// Second call within TTL is served from cache (no extra fetch).
		await source.getManifest();
		expect(calls.length).toBe(1);
	});

	test("serves last-good cache on a later fetch failure", async () => {
		let failNext = false;
		const { fetch: fetchImpl } = stubFetch(() => {
			if (failNext) {
				return { ok: false, body: null, status: 500 };
			}
			return { ok: true, body: MANIFEST };
		});
		const source = new RemoteCatalogSource("owner/lessons", "main", fetchImpl);

		const first = await source.getManifest();
		expect(first.modules.length).toBe(2);

		// Force a refetch by reaching past the TTL via the private cache time.
		(source as unknown as { cached: { fetchedAt: number } }).cached.fetchedAt =
			Date.now() - 120_000;
		failNext = true;
		const second = await source.getManifest();
		expect(second.error).toBeNull();
		expect(second.modules.length).toBe(2);
	});

	test("returns an error state when the first fetch fails and there is no cache", async () => {
		const { fetch: fetchImpl } = stubFetch(() => ({
			ok: false,
			body: null,
			status: 404,
		}));
		const source = new RemoteCatalogSource("owner/lessons", "main", fetchImpl);
		const { modules, error } = await source.getManifest();
		expect(modules).toEqual([]);
		expect(error).toBeTruthy();
	});

	test("resolveModule throws ImportError for an unknown id", async () => {
		const { fetch: fetchImpl } = stubFetch(() => ({
			ok: true,
			body: MANIFEST,
		}));
		const source = new RemoteCatalogSource("owner/lessons", "main", fetchImpl);
		await expect(source.resolveModule("nope")).rejects.toThrow(ImportError);
	});
});

describe("createCatalogSource", () => {
	test("returns a bundled source when catalogRepo is null", () => {
		const config = {
			catalogRepo: null,
			catalogBranch: "main",
			catalogDir: "/tmp/catalog",
		} as ControlConfig;
		expect(createCatalogSource(config)).toBeInstanceOf(BundledCatalogSource);
	});

	test("returns a remote source when catalogRepo is set", () => {
		const config = {
			catalogRepo: "owner/lessons",
			catalogBranch: "main",
			catalogDir: "/tmp/catalog",
		} as ControlConfig;
		expect(createCatalogSource(config)).toBeInstanceOf(RemoteCatalogSource);
	});
});
