/**
 * Auth seeding helpers for E2E specs.
 *
 * `loginAs` is the FAST shortcut: it writes Better Auth rows directly to the
 * SQLite database and plants a signed session cookie in the page's context.
 * It bypasses the real OAuth callback handler, so tests that want to validate
 * the callback path (allowlist, ensureWorkspace hook) must drive the real
 * Better Auth handler — see `e2e/specs/auth/login.spec.ts`.
 *
 * The HMAC-signing logic mirrors the existing apps/control/src/__tests__/helpers.ts:login().
 */
import type { Page } from "@playwright/test";
import type { ControlApp } from "../../apps/control/src/app";

async function signToken(token: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
	const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return `${token}.${b64}`;
}

function randomToken(): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	for (const b of bytes) result += chars[b % chars.length];
	return result;
}

export type LoginOpts = {
	name: string;
	email?: string;
	role?: "student" | "admin";
};

export type LoginResult = {
	user: {
		id: string;
		email: string;
		name: string;
		slug: string;
		role: "student" | "admin";
	};
	cookieValue: string;
	cookieName: "frc_session";
};

export async function loginAs(
	page: Page,
	app: ControlApp,
	opts: LoginOpts,
): Promise<LoginResult> {
	const db = app.storage.db;
	const secret = app.storage.config.sessionSecret;
	const role = opts.role ?? "student";
	const email = (
		opts.email ?? `${opts.name.toLowerCase()}@test.local`
	).toLowerCase();
	const slug = opts.name
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.slice(0, 40);
	const now = new Date().toISOString();
	const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

	let userId: string;
	const existing = db
		.query("SELECT id FROM user WHERE email = ?")
		.get(email) as { id: string } | null;
	if (existing) {
		userId = existing.id;
		db.query("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?").run(
			role,
			now,
			userId,
		);
	} else {
		userId = randomToken();
		db.query(
			"INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(userId, opts.name, email, 0, null, now, now, role, slug);
	}

	await app.storage.ensureWorkspaceForUser(userId, slug);

	const sessionToken = randomToken();
	const signedRaw = await signToken(sessionToken, secret);
	// Better Auth's cookie value is URL-encoded; the existing test helper does
	// the same so cookie-from-cookieHeader assertions stay consistent.
	const signed = encodeURIComponent(signedRaw);
	db.query(
		"INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
	).run(randomToken(), expires, sessionToken, now, now, userId);

	const url = new URL(app.storage.config.baseUrl);
	await page.context().addCookies([
		{
			name: "frc_session",
			value: signed,
			domain: url.hostname,
			path: "/",
			httpOnly: true,
			secure: url.protocol === "https:",
			sameSite: "Lax",
		},
	]);

	return {
		user: { id: userId, email, name: opts.name, slug, role },
		cookieValue: signed,
		cookieName: "frc_session",
	};
}

export function cookieHeader(result: LoginResult): string {
	return `${result.cookieName}=${result.cookieValue}`;
}
