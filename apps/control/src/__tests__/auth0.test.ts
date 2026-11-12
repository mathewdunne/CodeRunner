import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ControlApp } from "../app";
import { resolveAuth0Role } from "../auth/providers";
import { loadControlConfig } from "../config";
import { withApp } from "./helpers";

const AUTH0_DOMAIN = "tenant.auth0.test";
const AUTH0_ORIGIN = `https://${AUTH0_DOMAIN}`;
const BASE_URL = "http://localhost:4000";
const AUDIENCE = "https://coderunner.test/api";

const auth0Options = {
	auth0Domain: AUTH0_DOMAIN,
	auth0ClientId: "auth0-client-id",
	auth0ClientSecret: "auth0-client-secret",
	auth0Audience: AUDIENCE,
};

function unsignedJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

// Claims the fake Auth0 token endpoint puts in the next ID token it issues,
// and the permissions it puts in the next access token (undefined: the
// opaque, non-JWT access token Auth0 issues when no audience is requested).
let nextIdTokenClaims: Record<string, unknown> = {};
let nextPermissions: unknown;
const realFetch = globalThis.fetch;

beforeAll(() => {
	// Stand in for the Auth0 tenant: discovery + token endpoint. Better Auth
	// talks to these over fetch; everything else passes through.
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		if (url.origin !== AUTH0_ORIGIN) {
			return realFetch(input, init);
		}
		if (url.pathname === "/.well-known/openid-configuration") {
			return Response.json({
				issuer: `${AUTH0_ORIGIN}/`,
				authorization_endpoint: `${AUTH0_ORIGIN}/authorize`,
				token_endpoint: `${AUTH0_ORIGIN}/oauth/token`,
				userinfo_endpoint: `${AUTH0_ORIGIN}/userinfo`,
			});
		}
		if (url.pathname === "/oauth/token") {
			return Response.json({
				access_token:
					nextPermissions === undefined
						? "opaque-access-token"
						: unsignedJwt({
								iss: `${AUTH0_ORIGIN}/`,
								aud: [AUDIENCE, `${AUTH0_ORIGIN}/userinfo`],
								sub: nextIdTokenClaims.sub,
								permissions: nextPermissions,
							}),
				token_type: "Bearer",
				expires_in: 3600,
				id_token: unsignedJwt({
					iss: `${AUTH0_ORIGIN}/`,
					aud: auth0Options.auth0ClientId,
					...nextIdTokenClaims,
				}),
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

/** Run the full Auth0 sign-in round trip; returns the callback response. */
async function auth0Login(
	app: ControlApp,
	claims: Record<string, unknown>,
	permissions?: unknown,
): Promise<Response> {
	nextIdTokenClaims = claims;
	nextPermissions = permissions;
	const signIn = await app.fetch(
		new Request(`${BASE_URL}/api/auth/sign-in/oauth2`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({
				providerId: "auth0",
				callbackURL: "/",
				errorCallbackURL: "/login",
			}),
		}),
	);
	expect(signIn.status).toBe(200);
	const { url } = (await signIn.json()) as { url: string };
	expect(new URL(url).searchParams.get("audience")).toBe(AUDIENCE);
	const state = new URL(url).searchParams.get("state");
	const cookies = signIn.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	return app.fetch(
		new Request(
			`${BASE_URL}/api/auth/oauth2/callback/auth0?code=auth-code&state=${state}`,
			{ headers: { cookie: cookies } },
		),
	);
}

function auth0User(sub: string, email: string) {
	return {
		sub,
		email,
		email_verified: true,
		name: email.split("@")[0],
	};
}

function userRow(app: ControlApp, email: string) {
	return app.storage.db
		.query("SELECT id, role, slug FROM user WHERE email = ?")
		.get(email) as { id: string; role: string; slug: string } | null;
}

function sessionCount(app: ControlApp, userId: string): number {
	return (
		app.storage.db
			.query("SELECT COUNT(*) AS count FROM session WHERE userId = ?")
			.get(userId) as { count: number }
	).count;
}

/** The role in the session that `response`'s cookies grant, or null. */
async function sessionRole(
	app: ControlApp,
	response: Response,
): Promise<string | null> {
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	const session = await app.fetch(
		new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
	);
	const body = (await session.json()) as { user?: { role?: string } } | null;
	return body?.user?.role ?? null;
}

function expectSignedIn(response: Response) {
	expect(response.status).toBe(302);
	expect(response.headers.get("location")).not.toContain("error");
}

describe("resolveAuth0Role", () => {
	const config = loadControlConfig({ adminEmails: ["coach@test.local"] });

	test("maps the configured permissions", () => {
		expect(
			resolveAuth0Role(
				{ permissions: ["coderunner:user"] },
				"a@x.test",
				config,
			),
		).toBe("student");
		expect(
			resolveAuth0Role(
				{ permissions: ["coderunner:admin"] },
				"a@x.test",
				config,
			),
		).toBe("admin");
		expect(
			resolveAuth0Role(
				{ permissions: ["coderunner:user", "coderunner:admin"] },
				"a@x.test",
				config,
			),
		).toBe("admin");
	});

	test("returns null without a matching permission", () => {
		expect(resolveAuth0Role({}, "a@x.test", config)).toBeNull();
		expect(
			resolveAuth0Role({ permissions: [] }, "a@x.test", config),
		).toBeNull();
		expect(
			resolveAuth0Role({ permissions: ["read:other"] }, "a@x.test", config),
		).toBeNull();
		expect(
			resolveAuth0Role({ permissions: "coderunner:user" }, "a@x.test", config),
		).toBeNull();
	});

	test("verified admin emails are admin regardless of permissions", () => {
		expect(
			resolveAuth0Role({ email_verified: true }, "Coach@Test.local", config),
		).toBe("admin");
	});

	test("unverified admin emails fall back to permissions", () => {
		expect(
			resolveAuth0Role({ email_verified: false }, "coach@test.local", config),
		).toBeNull();
		expect(
			resolveAuth0Role(
				{ email_verified: false, permissions: ["coderunner:user"] },
				"coach@test.local",
				config,
			),
		).toBe("student");
	});

	test("honours custom permission names", () => {
		const custom = loadControlConfig({
			auth0UserPermission: "use:ide",
			auth0AdminPermission: "manage:ide",
		});
		expect(
			resolveAuth0Role({ permissions: ["use:ide"] }, "a@x.test", custom),
		).toBe("student");
		expect(
			resolveAuth0Role({ permissions: ["manage:ide"] }, "a@x.test", custom),
		).toBe("admin");
		expect(
			resolveAuth0Role(
				{ permissions: ["coderunner:user"] },
				"a@x.test",
				custom,
			),
		).toBeNull();
	});
});

describe("Auth0 sign-in", () => {
	test("a new user with the user permission gets in without being on the allowlist", async () => {
		await withApp(async (app) => {
			const response = await auth0Login(
				app,
				auth0User("auth0|student", "student@team.test"),
				["coderunner:user"],
			);
			expectSignedIn(response);
			const user = userRow(app, "student@team.test");
			expect(user?.role).toBe("student");
			expect(user?.slug).toBe("student");
			const workspace = app.storage.db
				.query("SELECT slug FROM workspaces WHERE user_id = ?")
				.get(user?.id ?? "");
			expect(workspace).toBeTruthy();
		}, auth0Options);
	});

	test("a new user with the admin permission becomes admin", async () => {
		await withApp(async (app) => {
			expectSignedIn(
				await auth0Login(app, auth0User("auth0|coach", "coach@team.test"), [
					"coderunner:admin",
				]),
			);
			expect(userRow(app, "coach@team.test")?.role).toBe("admin");
		}, auth0Options);
	});

	test("a new user with no permission is denied and no user row is created", async () => {
		await withApp(async (app) => {
			const response = await auth0Login(
				app,
				auth0User("auth0|nobody", "nobody@team.test"),
			);
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toContain("/login?error=");
			expect(userRow(app, "nobody@team.test")).toBeNull();
		}, auth0Options);
	});

	test("CODERUNNER_ADMIN_EMAIL is admin even without Auth0 permissions", async () => {
		await withApp(
			async (app) => {
				expectSignedIn(
					await auth0Login(app, auth0User("auth0|boss", "boss@team.test")),
				);
				expect(userRow(app, "boss@team.test")?.role).toBe("admin");
			},
			{ ...auth0Options, adminEmails: ["boss@team.test"] },
		);
	});

	test("permissions are re-read on every sign-in", async () => {
		await withApp(async (app) => {
			const email = "mover@team.test";
			expectSignedIn(
				await auth0Login(app, auth0User("auth0|mover", email), [
					"coderunner:user",
				]),
			);
			expect(userRow(app, email)?.role).toBe("student");

			// Promotion lands in the DB and in the session the sign-in hands out.
			const promoted = await auth0Login(app, auth0User("auth0|mover", email), [
				"coderunner:admin",
			]);
			expectSignedIn(promoted);
			expect(userRow(app, email)?.role).toBe("admin");
			expect(await sessionRole(app, promoted)).toBe("admin");

			expectSignedIn(
				await auth0Login(app, auth0User("auth0|mover", email), [
					"coderunner:user",
				]),
			);
			expect(userRow(app, email)?.role).toBe("student");

			// Permission removed in Auth0: denied before any session or cookie exists.
			const userId = userRow(app, email)?.id ?? "";
			const sessionsBefore = sessionCount(app, userId);
			const denied = await auth0Login(app, auth0User("auth0|mover", email));
			expect(denied.status).toBe(302);
			expect(denied.headers.get("location")).toBe(
				"/login?error=Your_Auth0_account_has_no_CodeRunner_role._Ask_your_coach_for_access.",
			);
			expect(sessionCount(app, userId)).toBe(sessionsBefore);
			expect(await sessionRole(app, denied)).toBeNull();
		}, auth0Options);
	});

	test("each linked Auth0 identity is checked on its own permissions", async () => {
		await withApp(async (app) => {
			const email = "dual@team.test";
			expectSignedIn(
				await auth0Login(app, auth0User("auth0|dual", email), [
					"coderunner:admin",
				]),
			);
			// Same verified email, different Auth0 identity, no role: denied,
			// not waved through on the first identity's admin permission.
			const denied = await auth0Login(
				app,
				auth0User("google-oauth2|dual", email),
			);
			expect(denied.headers.get("location")).toContain("/login?error=");
			expect(await sessionRole(app, denied)).toBeNull();
		}, auth0Options);
	});

	test("permissions only count from the access token", async () => {
		await withApp(async (app) => {
			// An ID-token claim (e.g. from an Action) can't stand in for RBAC.
			const forged = await auth0Login(app, {
				...auth0User("auth0|forger", "forger@team.test"),
				permissions: ["coderunner:admin"],
			});
			expect(forged.headers.get("location")).toContain("/login?error=");
			expect(userRow(app, "forger@team.test")).toBeNull();

			// Permissions that aren't CodeRunner's don't grant anything.
			const other = await auth0Login(
				app,
				auth0User("auth0|other", "other@team.test"),
				["read:reports"],
			);
			expect(other.headers.get("location")).toContain("/login?error=");
			expect(userRow(app, "other@team.test")).toBeNull();
		}, auth0Options);
	});
});
