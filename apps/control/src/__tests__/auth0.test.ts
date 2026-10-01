import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ControlApp } from "../app";
import { resolveAuth0Role } from "../auth/providers";
import { loadControlConfig } from "../config";
import { withApp } from "./helpers";

const AUTH0_DOMAIN = "tenant.auth0.test";
const AUTH0_ORIGIN = `https://${AUTH0_DOMAIN}`;
const BASE_URL = "http://localhost:4000";
const ROLES_CLAIM = "https://coderunner/roles";

const auth0Options = {
	auth0Domain: AUTH0_DOMAIN,
	auth0ClientId: "auth0-client-id",
	auth0ClientSecret: "auth0-client-secret",
};

function unsignedJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

// Claims the fake Auth0 token endpoint puts in the next ID token it issues.
let nextIdTokenClaims: Record<string, unknown> = {};
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
				access_token: "auth0-access-token",
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
): Promise<Response> {
	nextIdTokenClaims = claims;
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

function auth0User(sub: string, email: string, roles?: unknown) {
	return {
		sub,
		email,
		email_verified: true,
		name: email.split("@")[0],
		...(roles === undefined ? {} : { [ROLES_CLAIM]: roles }),
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

	test("maps the configured role names", () => {
		expect(
			resolveAuth0Role({ [ROLES_CLAIM]: ["user"] }, "a@x.test", config),
		).toBe("student");
		expect(
			resolveAuth0Role({ [ROLES_CLAIM]: ["admin"] }, "a@x.test", config),
		).toBe("admin");
		expect(
			resolveAuth0Role(
				{ [ROLES_CLAIM]: ["user", "admin"] },
				"a@x.test",
				config,
			),
		).toBe("admin");
		expect(
			resolveAuth0Role({ [ROLES_CLAIM]: "user" }, "a@x.test", config),
		).toBe("student");
	});

	test("returns null without a matching role", () => {
		expect(resolveAuth0Role({}, "a@x.test", config)).toBeNull();
		expect(
			resolveAuth0Role({ [ROLES_CLAIM]: [] }, "a@x.test", config),
		).toBeNull();
		expect(
			resolveAuth0Role({ [ROLES_CLAIM]: ["guest"] }, "a@x.test", config),
		).toBeNull();
		expect(
			resolveAuth0Role({ roles: ["user"] }, "a@x.test", config),
		).toBeNull();
	});

	test("admin emails are admin regardless of roles", () => {
		expect(resolveAuth0Role({}, "Coach@Test.local", config)).toBe("admin");
	});

	test("honours custom claim and role names", () => {
		const custom = loadControlConfig({
			auth0RolesClaim: "roles",
			auth0UserRoleName: "member",
			auth0AdminRoleName: "teacher",
		});
		expect(resolveAuth0Role({ roles: ["member"] }, "a@x.test", custom)).toBe(
			"student",
		);
		expect(resolveAuth0Role({ roles: ["teacher"] }, "a@x.test", custom)).toBe(
			"admin",
		);
		expect(
			resolveAuth0Role({ roles: ["user"] }, "a@x.test", custom),
		).toBeNull();
	});
});

describe("Auth0 sign-in", () => {
	test("a new user with the user role gets in without being on the allowlist", async () => {
		await withApp(async (app) => {
			const response = await auth0Login(
				app,
				auth0User("auth0|student", "student@team.test", ["user"]),
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

	test("a new user with the admin role becomes admin", async () => {
		await withApp(async (app) => {
			expectSignedIn(
				await auth0Login(
					app,
					auth0User("auth0|coach", "coach@team.test", ["admin"]),
				),
			);
			expect(userRow(app, "coach@team.test")?.role).toBe("admin");
		}, auth0Options);
	});

	test("a new user with no role is denied and no user row is created", async () => {
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

	test("CODERUNNER_ADMIN_EMAIL is admin even without Auth0 roles", async () => {
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

	test("roles are re-read on every sign-in", async () => {
		await withApp(async (app) => {
			const email = "mover@team.test";
			expectSignedIn(
				await auth0Login(app, auth0User("auth0|mover", email, ["user"])),
			);
			expect(userRow(app, email)?.role).toBe("student");

			// Promotion lands in the DB and in the session the sign-in hands out.
			const promoted = await auth0Login(
				app,
				auth0User("auth0|mover", email, ["admin"]),
			);
			expectSignedIn(promoted);
			expect(userRow(app, email)?.role).toBe("admin");
			expect(await sessionRole(app, promoted)).toBe("admin");

			expectSignedIn(
				await auth0Login(app, auth0User("auth0|mover", email, ["user"])),
			);
			expect(userRow(app, email)?.role).toBe("student");

			// Role removed in Auth0: denied before any session or cookie exists.
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
});
