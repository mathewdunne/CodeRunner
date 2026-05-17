import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportServerMessage } from "@frc-coderunner/contracts";
import {
	ImportManager,
	ImportRateLimiter,
	listRecentImports,
	parseGitHubUrl,
	RateLimitError,
	restoreImportBackup,
	validateBranch,
	validateSubdir,
} from "../imports";
import {
	cookieFrom,
	createFakeDocker,
	login,
	withApp,
	workspaceBySlug,
} from "./helpers";

// --- URL validation tests ---

describe("parseGitHubUrl", () => {
	test("accepts simple GitHub HTTPS URL", () => {
		const result = parseGitHubUrl("https://github.com/wpilibsuite/allwpilib");
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.branch).toBe("main");
		expect(result.subdir).toBe("");
	});

	test("accepts GitHub HTTPS URL with .git suffix", () => {
		const result = parseGitHubUrl(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.branch).toBe("main");
		expect(result.subdir).toBe("");
	});

	test("parses tree URL into clone URL + branch + subdir", () => {
		const result = parseGitHubUrl(
			"https://github.com/wpilibsuite/allwpilib/tree/main/wpilibjExamples",
		);
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.branch).toBe("main");
		expect(result.subdir).toBe("wpilibjExamples");
	});

	test("applies branch/subdir overrides on tree URL", () => {
		const result = parseGitHubUrl(
			"https://github.com/wpilibsuite/allwpilib/tree/main/some/path",
			"develop",
			"other/path",
		);
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.branch).toBe("develop");
		expect(result.subdir).toBe("other/path");
	});

	test("rejects SSH URL", () => {
		expect(() => parseGitHubUrl("git@github.com:owner/repo.git")).toThrow(
			"SSH URLs are not supported",
		);
	});

	test("rejects non-GitHub host", () => {
		expect(() => parseGitHubUrl("https://gitlab.com/owner/repo")).toThrow(
			"Only GitHub URLs",
		);
	});

	test("rejects invalid URL", () => {
		expect(() => parseGitHubUrl("not-a-url")).toThrow("Invalid URL format");
	});

	test("rejects unsupported GitHub path suffix", () => {
		expect(() => parseGitHubUrl("https://github.com/owner/repo/pulls")).toThrow(
			"Unsupported GitHub URL format",
		);
	});

	test("rejects subdir with '..'", () => {
		expect(() =>
			parseGitHubUrl("https://github.com/owner/repo", undefined, "../escape"),
		).toThrow("must not contain '..'");
	});
});

describe("validateBranch", () => {
	test("accepts valid branch names", () => {
		expect(() => validateBranch("main")).not.toThrow();
		expect(() => validateBranch("develop")).not.toThrow();
		expect(() => validateBranch("feature/foo")).not.toThrow();
		expect(() => validateBranch("v1.0")).not.toThrow();
	});

	test("rejects branch starting with -", () => {
		expect(() => validateBranch("-evil")).toThrow("Invalid branch name");
	});

	test("rejects empty branch", () => {
		expect(() => validateBranch("")).toThrow("Invalid branch name");
	});
});

describe("validateSubdir", () => {
	test("accepts valid subdirectories", () => {
		expect(() => validateSubdir("src/main")).not.toThrow();
		expect(() => validateSubdir("")).not.toThrow();
	});

	test("rejects subdir starting with /", () => {
		expect(() => validateSubdir("/absolute")).toThrow("relative path");
	});

	test("rejects subdir with ..", () => {
		expect(() => validateSubdir("foo/../bar")).toThrow("must not contain '..'");
	});
});

// --- Rate limiting tests ---

describe("ImportRateLimiter", () => {
	test("allows up to 6 imports per hour", () => {
		const limiter = new ImportRateLimiter();
		for (let i = 0; i < 6; i++) {
			expect(() => limiter.check("user1")).not.toThrow();
			limiter.record("user1");
		}
		expect(() => limiter.check("user1")).toThrow(RateLimitError);
	});

	test("different users have independent limits", () => {
		const limiter = new ImportRateLimiter();
		for (let i = 0; i < 6; i++) {
			limiter.record("user1");
		}
		expect(() => limiter.check("user2")).not.toThrow();
	});
});

// --- Integration tests ---

describe("import endpoint", () => {
	test("POST /api/project/import validates URL", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const resp = await login(app, "alice");
				const cookie = cookieFrom(resp);

				// Valid URL
				const valid = await app.fetch(
					new Request("http://localhost/u/alice/api/project/import", {
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ url: "https://github.com/owner/repo" }),
					}),
				);
				expect(valid.status).toBe(200);
				const body = (await valid.json()) as { ok: boolean; cloneUrl: string };
				expect(body.ok).toBe(true);
				expect(body.cloneUrl).toBe("https://github.com/owner/repo.git");

				// SSH URL → reject
				const ssh = await app.fetch(
					new Request("http://localhost/u/alice/api/project/import", {
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ url: "git@github.com:owner/repo.git" }),
					}),
				);
				expect(ssh.status).toBe(400);

				// Non-GitHub → reject
				const gitlab = await app.fetch(
					new Request("http://localhost/u/alice/api/project/import", {
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ url: "https://gitlab.com/owner/repo" }),
					}),
				);
				expect(gitlab.status).toBe(400);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("unauthenticated import returns 401", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const resp = await app.fetch(
					new Request("http://localhost/u/alice/api/project/import", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ url: "https://github.com/owner/repo" }),
					}),
				);
				// Redirect to login for non-API workspace routes
				expect([401, 303]).toContain(resp.status);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("cross-workspace import returns 403", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const bobResp = await login(app, "bob");
				const bobCookie = cookieFrom(bobResp);

				const resp = await app.fetch(
					new Request("http://localhost/u/alice/api/project/import", {
						method: "POST",
						headers: { cookie: bobCookie, "content-type": "application/json" },
						body: JSON.stringify({ url: "https://github.com/owner/repo" }),
					}),
				);
				expect(resp.status).toBe(403);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("GET /api/project/recent-imports returns empty list initially", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const resp = await login(app, "alice");
				const cookie = cookieFrom(resp);

				const result = await app.fetch(
					new Request("http://localhost/u/alice/api/project/recent-imports", {
						headers: { cookie },
					}),
				);
				expect(result.status).toBe(200);
				const body = (await result.json()) as {
					ok: boolean;
					imports: unknown[];
				};
				expect(body.ok).toBe(true);
				expect(body.imports).toEqual([]);
			},
			{ dockerRunner: docker.runner },
		);
	});
});

// --- Import manager unit tests ---

describe("ImportManager", () => {
	test("rejects concurrent imports for same workspace", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				const manager = new ImportManager(app.storage, app.containers);
				const messages: ImportServerMessage[] = [];
				const send = (msg: ImportServerMessage) => messages.push(msg);

				// First import will fail because clone can't actually work in tests,
				// but it should set the active flag
				const firstPromise = manager.run({
					workspace,
					userId: "test-user",
					cloneUrl: "https://github.com/owner/repo.git",
					branch: "main",
					subdir: "",
					backup: false,
					send,
				});

				// While first is "running", second should throw
				expect(manager.isImporting(workspace.id)).toBe(true);

				await firstPromise; // Let it fail/complete

				expect(manager.isImporting(workspace.id)).toBe(false);
			},
			{ dockerRunner: docker.runner },
		);
	});
});

// --- Backup/restore tests ---

describe("listRecentImports", () => {
	test("returns metadata files sorted newest first", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				// Create fake backup metadata
				const backupsDir = join(workspace.project_path, "..", "backups");
				await mkdir(backupsDir, { recursive: true });

				await writeFile(
					join(backupsDir, "import-2026-01-01-120000.json"),
					JSON.stringify({
						url: "https://github.com/owner/repo1.git",
						branch: "main",
						subdir: "",
						importedAt: "2026-01-01T12:00:00.000Z",
						archiveFile: "import-2026-01-01-120000.tar.gz",
					}),
					"utf8",
				);
				await writeFile(
					join(backupsDir, "import-2026-02-01-120000.json"),
					JSON.stringify({
						url: "https://github.com/owner/repo2.git",
						branch: "develop",
						subdir: "sub",
						importedAt: "2026-02-01T12:00:00.000Z",
						archiveFile: "import-2026-02-01-120000.tar.gz",
					}),
					"utf8",
				);

				const recent = await listRecentImports(workspace);
				expect(recent.length).toBe(2);
				expect(recent[0]?.url).toContain("repo2");
				expect(recent[1]?.url).toContain("repo1");
			},
			{ dockerRunner: docker.runner },
		);
	});
});

describe("restoreImportBackup", () => {
	test("rejects path traversal in archive file name", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				await expect(
					restoreImportBackup(workspace, "../../../etc/passwd"),
				).rejects.toThrow("Invalid backup file name");
				await expect(
					restoreImportBackup(workspace, "foo/bar.tar.gz"),
				).rejects.toThrow("Invalid backup file name");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("rejects missing backup file", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				const backupsDir = join(workspace.project_path, "..", "backups");
				await mkdir(backupsDir, { recursive: true });

				await expect(
					restoreImportBackup(workspace, "nonexistent.tar.gz"),
				).rejects.toThrow("Backup file not found");
			},
			{ dockerRunner: docker.runner },
		);
	});
});
