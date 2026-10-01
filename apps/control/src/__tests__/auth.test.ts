import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app";
import {
	addAllowlistEntry,
	isEmailAllowed,
	loadAllowlist,
	setAllowlistPath,
} from "../auth/allowlist";
import {
	cookieFrom,
	createAdvantageScopeDist,
	createCatalogDir,
	createWebDist,
	exists,
	login,
	withApp,
} from "./helpers";

describe("session login and ownership", () => {
	test("new login creates a user, workspace, session, and an empty project dir", async () => {
		await withApp(async (app) => {
			const response = await login(app, "alice");
			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe("/u/alice/");

			const userCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM user")
				.get() as { count: number };
			const workspaceCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM workspaces")
				.get() as {
				count: number;
			};
			const sessionCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM session")
				.get() as {
				count: number;
			};
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as {
				project_path: string;
				current_module: string | null;
				current_module_kind: string | null;
			};

			expect(userCount.count).toBe(1);
			expect(workspaceCount.count).toBe(1);
			expect(sessionCount.count).toBe(1);

			// The project dir exists but is EMPTY (no first-login template seed):
			// the student fills it from the lesson picker (Decision 029 / D7).
			expect(await exists(workspace.project_path)).toBe(true);
			const { readdir } = await import("node:fs/promises");
			expect((await readdir(workspace.project_path)).length).toBe(0);
			expect(workspace.current_module).toBeNull();
			expect(workspace.current_module_kind).toBeNull();
		});
	});

	test("session cookie redirects to the existing workspace", async () => {
		await withApp(async (app) => {
			const response = await login(app, "alice");
			const cookie = cookieFrom(response);

			const reload = await app.fetch(
				new Request("http://localhost/", {
					headers: { cookie },
				}),
			);
			expect(reload.status).toBe(303);
			expect(reload.headers.get("location")).toBe("/u/alice/");

			const workspace = await app.fetch(
				new Request("http://localhost/u/alice/", {
					headers: { cookie },
				}),
			);
			expect(workspace.status).toBe(200);
			expect(await workspace.text()).toContain("V2 test shell");
		});
	});

	test("rejects bad workspace slugs before serving a workspace page", async () => {
		await withApp(async (app) => {
			const response = await login(app, "alice");
			const cookie = cookieFrom(response);

			const badSlug = await app.fetch(
				new Request("http://localhost/u/alice.bob/", {
					headers: { cookie },
				}),
			);

			expect(badSlug.status).toBe(400);
		});
	});

	test("prevents another session from accessing a different user's workspace", async () => {
		await withApp(async (app) => {
			const alice = await login(app, "alice");
			const aliceCookie = cookieFrom(alice);

			await login(app, "bob");

			// Alice's cookie should not let her access Bob's workspace
			const bobAsAlice = await app.fetch(
				new Request("http://localhost/u/bob/", {
					headers: { cookie: aliceCookie },
				}),
			);
			expect(bobAsAlice.status).toBe(403);
		});
	});

	test("returning user gets a fresh session with same workspace", async () => {
		await withApp(async (app) => {
			const first = await login(app, "alice");
			expect(first.status).toBe(303);
			expect(first.headers.get("location")).toBe("/u/alice/");

			// Second login with same display name → same user + new session
			const second = await login(app, "alice");
			expect(second.status).toBe(303);
			expect(second.headers.get("location")).toBe("/u/alice/");

			// Should have 1 user, 2 sessions, 1 workspace
			const userCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM user")
				.get() as { count: number };
			const sessionCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM session")
				.get() as {
				count: number;
			};
			const workspaceCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM workspaces")
				.get() as {
				count: number;
			};
			expect(userCount.count).toBe(1);
			expect(sessionCount.count).toBe(2);
			expect(workspaceCount.count).toBe(1);
		});
	});
});

describe("workspace creation concurrency", () => {
	test("concurrent first-logins with the same base slug get distinct slugs", async () => {
		await withApp(async (app) => {
			const now = new Date().toISOString();
			const insertUser = app.storage.db.query(
				"INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);

			const ids = ["userAAAAAAAAAAAAAAAA", "userBBBBBBBBBBBBBBBB"];
			ids.forEach((id, i) => {
				insertUser.run(
					id,
					`Alice${i}`,
					`alice${i}@example.com`,
					0,
					null,
					now,
					now,
					"student",
					"alice",
				);
			});

			const results = await Promise.all(
				ids.map((id) => app.storage.ensureWorkspaceForUser(id, "alice")),
			);
			const slugs = results.map((w) => w.slug);

			expect(slugs[0]).not.toBe(slugs[1]);
			expect(new Set(slugs)).toEqual(new Set(["alice", "alice-1"]));

			const workspaceCount = app.storage.db
				.query("SELECT COUNT(*) AS count FROM workspaces")
				.get() as {
				count: number;
			};
			expect(workspaceCount.count).toBe(2);
		});
	});
});

describe("allowlist enforcement", () => {
	test("empty allowlist blocks OAuth emails until a matching entry is added", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-allowlist-"));
		try {
			setAllowlistPath(root);
			await loadAllowlist();
			expect(isEmailAllowed("student@example.com")).toBe(false);

			await addAllowlistEntry("domain", "example.com");
			expect(isEmailAllowed("student@example.com")).toBe(true);
			expect(isEmailAllowed("student@other.test")).toBe(false);

			await addAllowlistEntry("email", "coach@other.test");
			expect(isEmailAllowed("coach@other.test")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("allowlist reload on sign-in", () => {
	type CreateBeforeHook = (user: {
		email: string;
		name: string;
	}) => Promise<{ data: { role: string; slug: string } } | undefined>;

	test("a CLI-written allowlist.json is picked up by the sign-in hook without an explicit reload call", async () => {
		await withApp(async (app) => {
			// Simulate `coderunner allowlist add` running as a separate process: it
			// writes allowlist.json directly on disk, bypassing addAllowlistEntry
			// (which would also update this process's in-memory cache).
			const allowlistPath = join(app.storage.config.dataDir, "allowlist.json");
			await writeFile(
				allowlistPath,
				JSON.stringify({ emails: ["late@test.local"], domains: [] }, null, 2),
				"utf8",
			);

			// The in-memory cache is stale until something reloads it.
			expect(isEmailAllowed("late@test.local")).toBe(false);

			const hook = app.storage.auth.options.databaseHooks?.user?.create
				?.before as unknown as CreateBeforeHook | undefined;
			const result = await hook?.({
				email: "late@test.local",
				name: "Late",
			});

			// The hook reloads from disk before checking, so the CLI's write takes
			// effect on this very sign-in attempt.
			expect(result?.data.role).toBe("student");
		});
	});
});

describe("bootstrap admin (CODERUNNER_ADMIN_EMAIL)", () => {
	type CreateBeforeHook = (user: {
		email: string;
		name: string;
	}) => Promise<{ data: { role: string; slug: string } } | undefined>;

	test("user.create hook grants admin to listed emails and student to others", async () => {
		await withApp(
			async (app) => {
				// The student email must be on the allowlist so the hook's roster gate
				// passes; the admin email was seeded into the allowlist at startup.
				await addAllowlistEntry("email", "student@test.local");

				const hook = app.storage.auth.options.databaseHooks?.user?.create
					?.before as unknown as CreateBeforeHook | undefined;
				expect(hook).toBeTruthy();

				// Mixed-case listed email still resolves to admin (case-insensitive).
				const adminResult = await hook?.({
					email: "Coach@Test.local",
					name: "Coach",
				});
				expect(adminResult?.data.role).toBe("admin");

				const studentResult = await hook?.({
					email: "student@test.local",
					name: "Student",
				});
				expect(studentResult?.data.role).toBe("student");
			},
			{ adminEmails: ["coach@test.local"] },
		);
	});

	test("startup seeding is idempotent, promotes existing students, leaves admins", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-bootstrap-"));
		try {
			const catalogDir = await createCatalogDir(root);
			const webDistDir = await createWebDist(root);
			const advantageScopeDistDir = await createAdvantageScopeDist(root);
			const dataDir = join(root, "data");
			const allowlistPath = join(dataDir, "allowlist.json");
			const baseOptions = {
				dataDir,
				catalogDir,
				webDistDir,
				advantageScopeDistDir,
				sessionSecret: "test-session-secret",
				baseUrl: "http://localhost:4000",
				containerAutoStart: false,
				adminEmails: ["coach@team.org", "boss@team.org"],
			};

			// First startup: both admin emails are seeded into the allowlist.
			const first = await createApp(baseOptions);
			const afterFirst = JSON.parse(await readFile(allowlistPath, "utf8")) as {
				emails: string[];
			};
			expect(afterFirst.emails).toEqual(["boss@team.org", "coach@team.org"]);

			// Simulate accounts that already exist: a coach who signed in as a
			// student before the env was set (with the mixed-case email the OAuth
			// provider returned — promotion must match case-insensitively), and a
			// boss who is already an admin.
			const staleAdminTimestamp = "2020-01-01T00:00:00.000Z";
			const insertUser = first.storage.db.query(
				"INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			insertUser.run(
				"userCoachAAAAAAAAAAA",
				"Coach",
				"Coach@Team.org",
				0,
				null,
				staleAdminTimestamp,
				staleAdminTimestamp,
				"student",
				"coach",
			);
			insertUser.run(
				"userBossBBBBBBBBBBBB",
				"Boss",
				"boss@team.org",
				0,
				null,
				staleAdminTimestamp,
				staleAdminTimestamp,
				"admin",
				"boss",
			);
			first.close();

			// Second startup on the same data dir: idempotent allowlist, promotes the
			// existing student, and leaves the existing admin row untouched.
			const second = await createApp(baseOptions);
			try {
				const afterSecond = JSON.parse(
					await readFile(allowlistPath, "utf8"),
				) as { emails: string[] };
				expect(afterSecond.emails).toEqual(["boss@team.org", "coach@team.org"]);

				const coach = second.storage.db
					.query("SELECT role, updatedAt FROM user WHERE id = ?")
					.get("userCoachAAAAAAAAAAA") as { role: string; updatedAt: string };
				expect(coach.role).toBe("admin");
				expect(coach.updatedAt).not.toBe(staleAdminTimestamp);

				const boss = second.storage.db
					.query("SELECT role, updatedAt FROM user WHERE email = ?")
					.get("boss@team.org") as { role: string; updatedAt: string };
				expect(boss.role).toBe("admin");
				// The already-admin row is not rewritten.
				expect(boss.updatedAt).toBe(staleAdminTimestamp);
			} finally {
				second.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("auth provider discovery", () => {
	test("lists only configured OAuth providers", async () => {
		await withApp(
			async (app) => {
				const response = await app.fetch(
					new Request("http://localhost/api/auth/providers"),
				);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ providers: ["github"] });
			},
			{
				githubClientId: "github-client-id",
				githubClientSecret: "github-client-secret",
				googleClientId: "",
				googleClientSecret: "",
				auth0Domain: "",
				auth0ClientId: "",
				auth0ClientSecret: "",
			},
		);
	});

	test("lists auth0 only when its domain, client ID, and secret are all set", async () => {
		const others = {
			githubClientId: "",
			githubClientSecret: "",
			googleClientId: "",
			googleClientSecret: "",
		};
		const providersFor = (options: Record<string, string>) =>
			withApp(async (app) => {
				const response = await app.fetch(
					new Request("http://localhost/api/auth/providers"),
				);
				return ((await response.json()) as { providers: string[] }).providers;
			}, options);

		expect(
			await providersFor({
				...others,
				auth0Domain: "tenant.auth0.test",
				auth0ClientId: "id",
				auth0ClientSecret: "secret",
			}),
		).toEqual(["auth0"]);
		expect(
			await providersFor({
				...others,
				auth0Domain: "tenant.auth0.test",
				auth0ClientId: "id",
				auth0ClientSecret: "",
			}),
		).toEqual([]);
	});

	test("returns an empty list when no OAuth providers are configured", async () => {
		await withApp(
			async (app) => {
				const response = await app.fetch(
					new Request("http://localhost/api/auth/providers"),
				);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ providers: [] });
			},
			{
				githubClientId: "",
				githubClientSecret: "",
				googleClientId: "",
				googleClientSecret: "",
				auth0Domain: "",
				auth0ClientId: "",
				auth0ClientSecret: "",
			},
		);
	});
});
