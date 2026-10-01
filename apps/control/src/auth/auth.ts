/**
 * Better Auth instance — the single source of truth for authentication.
 *
 * Creates and configures the betterAuth instance with:
 * - SQLite database (shared with AppStorage)
 * - GitHub + Google OAuth providers, plus Auth0 via genericOAuth
 * - Custom user fields: role, slug
 * - Email allowlist enforcement via hooks (Auth0 users: role claim instead)
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
import { buildAuth0Plugin, buildSocialProviders } from "./providers";

const log = getLogger("auth");

const ROSTER_MESSAGE =
	"Your email is not on the roster. Ask your coach to add you.";

/** True for the genericOAuth callback of the Auth0 provider. */
function isAuth0Callback(
	ctx:
		| {
				path?: string | undefined;
				params?: Record<string, unknown> | undefined;
		  }
		| null
		| undefined,
): boolean {
	return (
		ctx?.path === "/oauth2/callback/:providerId" &&
		ctx.params?.providerId === "auth0"
	);
}

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
	const auth0Plugin = config.demo ? null : buildAuth0Plugin(config);

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
			...(auth0Plugin ? [auth0Plugin] : []),
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
					before: async (user, ctx) => {
						const classroomId = (user as { classroomId?: string | null })
							.classroomId;
						if (classroomId) {
							// Classroom guests: no allowlist, never admin, slug from name.
							const slug = slugify(user.name);
							log.info("creating classroom guest", { classroomId, slug });
							return { data: { ...user, slug, role: "student" } };
						}
						const slug = slugFromEmail(user.email);
						if (isAuth0Callback(ctx)) {
							// Auth0 vets the user; the role claim replaces the allowlist.
							// The Auth0 profile mapper already denied users with no role
							// and put the role on `user`.
							const role = (user as { role?: string }).role;
							log.info("creating new auth0 user", {
								email: user.email,
								slug,
								role,
							});
							return { data: { ...user, slug, role } };
						}
						// Enforce allowlist on new user creation
						await refreshAllowlistBeforeCheck();
						if (!isEmailAllowed(user.email)) {
							log.warn("new user rejected: not on allowlist", {
								email: user.email,
							});
							throw new APIError("FORBIDDEN", {
								message: ROSTER_MESSAGE,
							});
						}
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
				const auth0 = isAuth0Callback(ctx);

				if (ctx.path === "/callback/:id" || auth0) {
					const newSession = ctx.context.newSession;
					// Enforce allowlist on returning users (social OAuth callback).
					// Auth0 users were checked against their role claim instead.
					if (newSession && !auth0) {
						await refreshAllowlistBeforeCheck();
					}
					if (newSession && !auth0 && !isEmailAllowed(newSession.user.email)) {
						log.warn("oauth callback rejected: not on allowlist", {
							email: newSession.user.email,
						});
						// Revoke the session that was just created
						await ctx.context.internalAdapter.deleteSession(
							newSession.session.token,
						);
						throw new APIError("FORBIDDEN", {
							message: ROSTER_MESSAGE,
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
