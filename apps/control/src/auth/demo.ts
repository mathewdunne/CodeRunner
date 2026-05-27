/**
 * Demo mode helpers — single seeded admin user + synthetic session.
 *
 * Used by `bun run start -- --demo` (or CODERUNNER_DEMO_MODE=1) to let
 * someone evaluate CodeRunner without configuring OAuth or an allowlist.
 *
 * Not safe to expose publicly: every request resolves to the same user,
 * so there is no privacy boundary between concurrent visitors.
 */

import type { AppStorage } from "../storage";

export const DEMO_USER_ID = "demo_admin_local_user";
export const DEMO_SLUG = "demo";
export const DEMO_EMAIL = "demo@local";
export const DEMO_NAME = "Demo";

/** Synthetic session payload returned by getSessionFromRequest in demo mode. */
export function getDemoSession() {
	return {
		user: {
			id: DEMO_USER_ID,
			email: DEMO_EMAIL,
			name: DEMO_NAME,
			image: null as string | null,
			role: "admin",
			slug: DEMO_SLUG,
		},
		session: { token: "demo-synthetic-session" },
	};
}

/** Session shape that Better Auth's /api/auth/session endpoint returns. */
export function getDemoSessionResponseBody() {
	const now = new Date();
	const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
	return {
		user: {
			id: DEMO_USER_ID,
			email: DEMO_EMAIL,
			emailVerified: true,
			name: DEMO_NAME,
			image: null,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
			role: "admin",
			slug: DEMO_SLUG,
		},
		session: {
			id: "demo-synthetic-session",
			token: "demo-synthetic-session",
			userId: DEMO_USER_ID,
			expiresAt: expires.toISOString(),
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		},
	};
}

/**
 * Idempotently insert the demo user row and ensure its workspace exists.
 * Safe to call on every boot.
 */
export async function seedDemoUser(storage: AppStorage): Promise<void> {
	const now = new Date().toISOString();
	storage.db
		.query(
			`INSERT OR IGNORE INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			DEMO_USER_ID,
			DEMO_NAME,
			DEMO_EMAIL,
			1,
			null,
			now,
			now,
			"admin",
			DEMO_SLUG,
		);

	storage.db
		.query("UPDATE user SET role = ?, slug = ?, updatedAt = ? WHERE id = ?")
		.run("admin", DEMO_SLUG, now, DEMO_USER_ID);

	await storage.ensureWorkspaceForUser(DEMO_USER_ID, DEMO_SLUG);
}
