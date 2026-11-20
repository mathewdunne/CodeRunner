import { describe, expect, test } from "bun:test";
import type {
	ImportServerMessage,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import {
	type CatalogLoadContext,
	type GithubImportContext,
	ImportManager,
	ImportRateLimiter,
	parseGitHubUrl,
	RateLimitError,
} from "../imports";
import type { WorkspaceRow } from "../storage";
import {
	cookieFrom,
	createFakeDocker,
	login,
	MockWorkspaceRuntimeProvider,
	withApp,
	workspaceBySlug,
} from "./helpers";

// --- URL validation tests (repo-root-only) ---

describe("parseGitHubUrl", () => {
	test("accepts simple GitHub HTTPS URL", () => {
		const result = parseGitHubUrl("https://github.com/wpilibsuite/allwpilib");
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
	});

	test("accepts GitHub HTTPS URL with .git suffix", () => {
		const result = parseGitHubUrl(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
		expect(result.cloneUrl).toBe(
			"https://github.com/wpilibsuite/allwpilib.git",
		);
	});

	test("rejects tree URL (subdir imports removed)", () => {
		expect(() =>
			parseGitHubUrl(
				"https://github.com/wpilibsuite/allwpilib/tree/main/wpilibjExamples",
			),
		).toThrow("Unsupported GitHub URL format");
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

	test("rejects extra path segments (URL confusion)", () => {
		expect(() => parseGitHubUrl("https://github.com/foo/bar/extra")).toThrow(
			"Unsupported GitHub URL format",
		);
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
});

// --- Import manager unit tests ---

function runningRuntime(workspaceId: WorkspaceId) {
	return {
		workspaceId,
		state: "running",
		runtimeName: "fake",
		image: "coderunner-workspace",
		ports: { nt4: 1, vscode: 2, halsim: 3 },
		endpoints: {
			vscode: {
				httpBaseUrl: "http://x",
				wsBaseUrl: "ws://x",
				basePath: "/",
			},
			nt4: { httpUrl: "http://n", wsUrl: "ws://n" },
			halsim: { wsUrl: "ws://h" },
		},
		lastUsedAt: null,
		error: null,
	} as never;
}

describe("ImportManager — github import", () => {
	test("rejects concurrent imports for same workspace", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				const manager = new ImportManager(app.storage, app.containers);
				const messages: ImportServerMessage[] = [];
				const send = (msg: ImportServerMessage) => messages.push(msg);

				const firstPromise = manager.run({
					source: "github",
					workspace,
					userId: "test-user",
					cloneUrl: "https://github.com/owner/repo.git",
					send,
				});

				expect(manager.isImporting(workspace.id)).toBe(true);
				await expect(
					manager.run({
						source: "github",
						workspace,
						userId: "test-user",
						cloneUrl: "https://github.com/owner/other.git",
						send,
					}),
				).rejects.toThrow("already in progress");

				await firstPromise;

				expect(manager.isImporting(workspace.id)).toBe(false);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("clone is all-branches --depth 1 and keeps .git", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			const ctx: GithubImportContext = {
				source: "github",
				workspace,
				userId: workspace.user_id,
				cloneUrl: "https://github.com/owner/repo.git",
				send: () => {},
			};
			await manager.run(ctx);

			const cloneCall = mock.execCalls.find(
				(c) => c.command[0] === "git" && c.command[1] === "clone",
			);
			expect(cloneCall).toBeTruthy();
			expect(cloneCall!.command).toContain("--no-single-branch");
			expect(cloneCall!.command).toContain("--depth");
			expect(cloneCall!.command).toContain("1");
			// No --branch (all branches), no --filter, no --sparse for a team import.
			expect(cloneCall!.command).not.toContain("--branch");
			expect(cloneCall!.command).not.toContain("--sparse");

			// Never strips .git from the imported project (keeps origin for push).
			const strippedGit = mock.execCalls.find(
				(c) =>
					c.command[0] === "rm" &&
					c.command.some((a) => a === "/workspace/project/.git"),
			);
			expect(strippedGit).toBeUndefined();
		});
	});

	test("github import clears current_module and editor workspace cache", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;
			// Pretend a lesson was previously loaded.
			app.storage.setCurrentModule(workspace.id, "hello-world", "plain-java");

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			await manager.run({
				source: "github",
				workspace,
				userId: workspace.user_id,
				cloneUrl: "https://github.com/owner/repo.git",
				send: () => {},
			});

			const refreshed = app.storage.findWorkspaceById(workspace.id);
			expect(refreshed?.current_module).toBeNull();
			expect(refreshed?.current_module_kind).toBeNull();

			const clearedCache = mock.execCalls.find(
				(c) =>
					c.command[0] === "rm" &&
					c.command.some((a) => a === "/config/data/User/workspaceStorage"),
			);
			expect(clearedCache).toBeTruthy();
		});
	});
});

describe("ImportManager — bundled catalog load", () => {
	test("copies bundled module, drops .git, records module + kind, no rate limit", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			const messages: ImportServerMessage[] = [];
			const ctx: CatalogLoadContext = {
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "robot-starter",
				subdir: "modules/robot-starter",
				repo: null,
				preserveGit: false,
				kind: "robot",
				remote: null,
				send: (m) => messages.push(m),
			};
			await manager.run(ctx);

			// No git clone for a bundled load.
			const cloneCall = mock.execCalls.find(
				(c) => c.command[0] === "git" && c.command[1] === "clone",
			);
			expect(cloneCall).toBeUndefined();

			// Copies from the in-image catalog path.
			const copyCall = mock.execCalls.find(
				(c) =>
					c.command[0] === "bash" &&
					(c.command[2] ?? "").includes(
						"cp -a /opt/frc-catalog/modules/robot-starter/.",
					),
			);
			expect(copyCall).toBeTruthy();

			// Drops .git (gitless lessons).
			const dropGit = mock.execCalls.find(
				(c) =>
					c.command[0] === "rm" &&
					c.command.some((a) => a === "/workspace/project/.git"),
			);
			expect(dropGit).toBeTruthy();

			// Records the module + kind.
			const refreshed = app.storage.findWorkspaceById(workspace.id);
			expect(refreshed?.current_module).toBe("robot-starter");
			expect(refreshed?.current_module_kind).toBe("robot");

			const done = messages.find((m) => m.type === "done");
			expect(done).toMatchObject({ type: "done", success: true });
		});
	});

	test("catalog load is not rate-limited (students switch lessons freely)", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);

			// Run more than the 6/hour cap — none should be rate-limited.
			for (let i = 0; i < 8; i++) {
				const messages: ImportServerMessage[] = [];
				await manager.run({
					source: "catalog",
					workspace,
					userId: workspace.user_id,
					moduleId: "hello-world",
					subdir: "modules/hello-world",
					repo: null,
					preserveGit: false,
					kind: "plain-java",
					remote: null,
					send: (m) => messages.push(m),
				});
				const done = messages.find((m) => m.type === "done");
				expect(done).toMatchObject({ success: true });
			}
		});
	});

	test("rejects unsafe catalog subdirs before executing runtime commands", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			const messages: ImportServerMessage[] = [];

			await manager.run({
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "bad",
				subdir: "modules/bad;rm -rf /",
				repo: null,
				preserveGit: false,
				kind: "plain-java",
				remote: null,
				send: (m) => messages.push(m),
			});

			expect(mock.execCalls).toEqual([]);
			expect(messages).toContainEqual(
				expect.objectContaining({
					type: "done",
					success: false,
					message: "Invalid lesson module subdir.",
				}),
			);
		});
	});
});

describe("ImportManager — remote catalog load", () => {
	test("uses a sparse shallow clone + sparse-checkout set", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;

			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			await manager.run({
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "closest-distance",
				subdir: "modules/closest-distance",
				repo: null,
				preserveGit: false,
				kind: "robot",
				remote: {
					cloneUrl: "https://github.com/owner/lessons.git",
					branch: "main",
				},
				send: () => {},
			});

			const cloneCall = mock.execCalls.find(
				(c) => c.command[0] === "git" && c.command[1] === "clone",
			);
			expect(cloneCall).toBeTruthy();
			expect(cloneCall!.command).toContain("--depth");
			expect(cloneCall!.command).toContain("--filter=blob:none");
			expect(cloneCall!.command).toContain("--sparse");
			expect(cloneCall!.command).toContain("--branch");

			const sparseCall = mock.execCalls.find(
				(c) =>
					c.command[0] === "git" &&
					c.command.includes("sparse-checkout") &&
					c.command.includes("set"),
			);
			expect(sparseCall).toBeTruthy();
			expect(sparseCall!.command).toContain("modules/closest-distance");
		});
	});
});

describe("ImportManager — standalone module repo", () => {
	async function loadRepoModule(options: {
		repo: string;
		preserveGit: boolean;
	}): Promise<{
		commands: string[][];
		messages: ImportServerMessage[];
	}> {
		let commands: string[][] = [];
		const messages: ImportServerMessage[] = [];
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;
			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			await manager.run({
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "java-fundamentals",
				subdir: null,
				repo: options.repo,
				preserveGit: options.preserveGit,
				kind: "plain-java",
				remote: null,
				send: (m) => messages.push(m),
			});
			commands = mock.execCalls.map((call) => call.command);
		});
		return { commands, messages };
	}

	test("clones the repo root and drops .git by default", async () => {
		const { commands, messages } = await loadRepoModule({
			repo: "frcsoftware/java-fundamentals",
			preserveGit: false,
		});

		const cloneCall = commands.find(
			(command) => command[0] === "git" && command[1] === "clone",
		);
		expect(cloneCall).toBeTruthy();
		expect(cloneCall).toContain("--depth");
		expect(cloneCall).toContain("1");
		expect(cloneCall).toContain(
			"https://github.com/frcsoftware/java-fundamentals.git",
		);
		expect(cloneCall).not.toContain("--sparse");
		expect(cloneCall).not.toContain("sparse-checkout");

		const dropGit = commands.find(
			(command) =>
				command[0] === "rm" && command.includes("/workspace/project/.git"),
		);
		expect(dropGit).toBeTruthy();

		const done = messages.find((m) => m.type === "done");
		expect(done).toMatchObject({ type: "done", success: true });
	});

	test("keeps .git when preserveGit is true", async () => {
		const { commands } = await loadRepoModule({
			repo: "https://github.com/frcsoftware/robot-lesson.git",
			preserveGit: true,
		});

		const dropGit = commands.find(
			(command) =>
				command[0] === "rm" && command.includes("/workspace/project/.git"),
		);
		expect(dropGit).toBeUndefined();
	});

	test("rejects an unsafe module repo before executing commands", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;
			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const manager = new ImportManager(app.storage, mock);
			const messages: ImportServerMessage[] = [];
			await manager.run({
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "bad",
				subdir: null,
				repo: "git@github.com:owner/repo.git",
				preserveGit: false,
				kind: "plain-java",
				remote: null,
				send: (m) => messages.push(m),
			});

			expect(mock.execCalls).toEqual([]);
			expect(messages).toContainEqual(
				expect.objectContaining({ type: "done", success: false }),
			);
		});
	});
});
