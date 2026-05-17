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
import type { ControlConfig } from "../config";
import { getLogger } from "../logging";
import { isEmailAllowed } from "./allowlist";
import { buildSocialProviders } from "./providers";

const log = getLogger("auth");

export function slugFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "student";
	return (
		local
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/gu, "")
			.replace(/[^a-z0-9_-]+/gu, "-")
			.replace(/-+/gu, "-")
			.replace(/^[-_]+|[-_]+$/gu, "")
			.slice(0, 40) || "student"
	);
}

export type AuthCallbacks = {
	/** Called after OAuth callback for new users to create their workspace. */
	ensureWorkspace: (userId: string, slug: string) => Promise<void>;
};

export function createAuth(
	db: Database,
	config: ControlConfig,
	callbacks: AuthCallbacks,
) {
	const socialProviders = buildSocialProviders(config);

	const options: BetterAuthOptions = {
		database: db,
		baseURL: config.baseUrl,
		basePath: "/api/auth",
		secret: config.sessionSecret,
		socialProviders,
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
						// Enforce allowlist on new user creation
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
						log.info("creating new user", { email: user.email, slug });
						return {
							data: {
								...user,
								slug,
								role: "student",
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
