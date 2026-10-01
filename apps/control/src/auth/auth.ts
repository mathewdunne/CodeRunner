/**
 * Better Auth instance — the single source of truth for authentication.
 *
 * Creates and configures the betterAuth instance with:
 * - SQLite database (shared with AppStorage)
 * - GitHub + Google OAuth providers
 * - Custom user fields: role, slug
 * - Email allowlist enforcement via hooks
 * - 14-day session expiry with daily refresh
 */

import type { Database } from "bun:sqlite";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { AuditEventInput } from "../audit";
import type { ControlConfig } from "../config";
import { getLogger } from "../logging";
import { isEmailAllowed, reloadAllowlist } from "./allowlist";
import { classroomPlugin } from "./classroom-plugin";
import { buildSocialProviders } from "./providers";

const log = getLogger("auth");

/**
 * Reload allowlist.json from disk before enforcing it, so CLI edits
 * (`coderunner allowlist add`) take effect on the next sign-in attempt
 * without requiring the admin-panel Reload button or a restart. A stale
 * cache is an acceptable fallback for a malformed file — a hard sign-in
 * crash is not.
 */
async function refreshAllowlistBeforeCheck(): Promise<void> {
	try {
		await reloadAllowlist();
	} catch (error) {
		log.warn("allowlist reload failed, using cached allowlist", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/gu, "")
			.replace(/[^a-z0-9_-]+/gu, "-")
			.replace(/-+/gu, "-")
			.replace(/^[-_]+|[-_]+$/gu, "")
			.slice(0, 40) || "student"
	);
}

export function slugFromEmail(email: string): string {
	return slugify(email.split("@")[0] ?? "student");
}

export type AuthCallbacks = {
	/** Called after OAuth callback for new users to create their workspace. */
	ensureWorkspace: (userId: string, slug: string) => Promise<void>;
	/** Records an audit event (classroom guest joins). */
	audit: (event: AuditEventInput) => void;
};

export function createAuth(
	db: Database,
	config: ControlConfig,
	callbacks: AuthCallbacks,
) {
	const socialProviders = config.demo ? {} : buildSocialProviders(config);

	const options: BetterAuthOptions = {
		database: db,
		baseURL: config.baseUrl,
		basePath: "/api/auth",
		secret: config.sessionSecret,
		socialProviders,
		plugins: [
			classroomPlugin({
				db,
				ensureWorkspace: callbacks.ensureWorkspace,
				audit: callbacks.audit,
			}),
		],
		session: {
			expiresIn: 14 * 24 * 60 * 60, // 14 days in seconds
			updateAge: 24 * 60 * 60, // refresh session expiry daily
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60, // 5 minutes
			},
		},
		user: {
			additionalFields: {
				role: {
					type: "string",
					required: false,
					defaultValue: "student",
					input: false,
				},
				slug: {
					type: "string",
					required: false,
					input: false,
				},
				// Classroom guests (decision 043). Better Auth adds these columns.
				classroomId: {
					type: "string",
					required: false,
					input: false,
				},
				guestNameKey: {
					type: "string",
					required: false,
					input: false,
				},
			},
		},
		advanced: {
			cookiePrefix: "frc",
			cookies: {
				session_token: {
					name: "coderunner_session",
				},
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const classroomId = (user as { classroomId?: string | null })
							.classroomId;
						if (classroomId) {
							// Classroom guests: no allowlist, never admin, slug from name.
							const slug = slugify(user.name);
							log.info("creating classroom guest", { classroomId, slug });
							return { data: { ...user, slug, role: "student" } };
						}
						// Enforce allowlist on new user creation
						await refreshAllowlistBeforeCheck();
						if (!isEmailAllowed(user.email)) {
							log.warn("new user rejected: not on allowlist", {
								email: user.email,
							});
							throw new APIError("FORBIDDEN", {
								message:
									"Your email is not on the roster. Ask your coach to add you.",
							});
						}
						const slug = slugFromEmail(user.email);
						const role = config.adminEmails.includes(user.email.toLowerCase())
							? "admin"
							: "student";
						log.info("creating new user", { email: user.email, slug, role });
						return {
							data: {
								...user,
								slug,
								role,
							},
						};
					},
				},
			},
		},
		hooks: {
			after: createAuthMiddleware(async (ctx) => {
				// Enforce allowlist on returning users (OAuth callback)
				if (ctx.path === "/callback/:id") {
					const newSession = ctx.context.newSession;
					if (newSession) {
						await refreshAllowlistBeforeCheck();
					}
					if (newSession && !isEmailAllowed(newSession.user.email)) {
						log.warn("oauth callback rejected: not on allowlist", {
							email: newSession.user.email,
						});
						// Revoke the session that was just created
						await ctx.context.internalAdapter.deleteSession(
							newSession.session.token,
						);
						throw new APIError("FORBIDDEN", {
							message:
								"Your email is not on the roster. Ask your coach to add you.",
						});
					}

					// Create workspace if this is the user's first login
					if (newSession) {
						const user = newSession.user as { id: string; slug?: string };
						const slug = user.slug ?? slugFromEmail(newSession.user.email);
						log.info("oauth callback ok", {
							userId: user.id,
							email: newSession.user.email,
							slug,
						});
						await callbacks.ensureWorkspace(user.id, slug);
					}
				}
			}),
		},
	};

	return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
