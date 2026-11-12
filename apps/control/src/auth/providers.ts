/**
 * OAuth provider configuration for Better Auth.
 *
 * Reads GitHub, Google, and Auth0 credentials from ControlConfig. GitHub and
 * Google are Better Auth social providers; Auth0 goes through the genericOAuth
 * plugin (decision 044).
 */
import { APIError } from "better-auth/api";
import { auth0, genericOAuth } from "better-auth/plugins/generic-oauth";
import type { ControlConfig } from "../config";
import { getLogger } from "../logging";

const log = getLogger("auth");

const AUTH0_NO_ROLE_MESSAGE =
	"Your Auth0 account has no CodeRunner role. Ask your coach for access.";

/**
 * Payload of a JWT, unverified, or null if `token` isn't a JWT (e.g. the
 * opaque access token Auth0 issues when no audience is requested). Both
 * tokens come straight from Auth0's token endpoint over TLS, authenticated
 * with the client secret, so they are trusted without a signature check —
 * the same way Better Auth treats the ID token.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const payload = token.split(".")[1];
	if (!payload) {
		return null;
	}
	try {
		const claims: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return claims && typeof claims === "object"
			? (claims as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export type SocialProviders = {
	github?: {
		clientId: string;
		clientSecret: string;
		overrideUserInfoOnSignIn: boolean;
	};
	google?: {
		clientId: string;
		clientSecret: string;
		overrideUserInfoOnSignIn: boolean;
	};
};

export type OAuthProvider = "github" | "google" | "auth0";

export function getEnabledAuthProviders(
	config: ControlConfig,
): OAuthProvider[] {
	const providers: OAuthProvider[] = [];

	if (config.githubClientId && config.githubClientSecret) {
		providers.push("github");
	}

	if (config.googleClientId && config.googleClientSecret) {
		providers.push("google");
	}

	if (
		config.auth0Domain &&
		config.auth0ClientId &&
		config.auth0ClientSecret &&
		config.auth0Audience
	) {
		providers.push("auth0");
	}

	return providers;
}

export function buildSocialProviders(config: ControlConfig): SocialProviders {
	const providers: SocialProviders = {};

	for (const provider of getEnabledAuthProviders(config)) {
		if (provider === "github") {
			providers.github = {
				clientId: config.githubClientId!,
				clientSecret: config.githubClientSecret!,
				overrideUserInfoOnSignIn: true,
			};
		}

		if (provider === "google") {
			providers.google = {
				clientId: config.googleClientId!,
				clientSecret: config.googleClientSecret!,
				overrideUserInfoOnSignIn: true,
			};
		}
	}

	return providers;
}

/** The genericOAuth plugin carrying Auth0, or null when Auth0 isn't configured. */
export function buildAuth0Plugin(config: ControlConfig) {
	if (!getEnabledAuthProviders(config).includes("auth0")) {
		return null;
	}
	return genericOAuth({
		config: [
			{
				...auth0({
					domain: config.auth0Domain!,
					clientId: config.auth0ClientId!,
					clientSecret: config.auth0ClientSecret!,
				}),
				overrideUserInfo: true,
				// Ask for an access token for the CodeRunner API, so it carries the
				// user's RBAC permissions for that API (and no other app's).
				authorizationUrlParams: { audience: config.auth0Audience! },
				// The ID token says who the user is; the access token's
				// `permissions` claim says what they may do. Better Auth's default
				// only reads the ID token, so merge the permissions in here for
				// mapProfileToUser. Set last so an ID-token claim can't supply them.
				getUserInfo: async (tokens) => {
					const id = tokens.idToken ? decodeJwtPayload(tokens.idToken) : null;
					if (typeof id?.sub !== "string" || typeof id.email !== "string") {
						return null;
					}
					const access = tokens.accessToken
						? decodeJwtPayload(tokens.accessToken)
						: null;
					return {
						...id,
						id: id.sub,
						email: id.email,
						emailVerified: id.email_verified === true,
						name: typeof id.name === "string" ? id.name : undefined,
						image: typeof id.picture === "string" ? id.picture : undefined,
						permissions: access?.permissions,
					};
				},
				// Runs once per callback with the claims of the identity signing in,
				// before Better Auth creates, links, or updates anything. No role
				// means denied here; otherwise the role is written on every sign-in
				// so the user row (and the session cookie cache built from it)
				// carries the current Auth0 role.
				// `role` is our additional field; the type only lists core fields.
				mapProfileToUser: (profile) => {
					const role = resolveAuth0Role(profile, profile.email ?? "", config);
					if (!role) {
						log.warn("auth0 sign-in rejected: no role", {
							email: profile.email,
							permissions: profile.permissions,
						});
						const error = AUTH0_NO_ROLE_MESSAGE.replaceAll(" ", "_");
						// What ctx.redirect throws; the profile mapper has no ctx.
						throw new APIError("FOUND", undefined, {
							location: `/login?error=${encodeURIComponent(error)}`,
						});
					}
					return { role } as Record<string, unknown>;
				},
			},
		],
	});
}

/**
 * Map an Auth0 profile (ID-token claims plus the access token's
 * `permissions`) to a CodeRunner role. Admin emails (CODERUNNER_ADMIN_EMAIL)
 * are admin once Auth0 has verified the address; otherwise `permissions` must
 * hold the configured admin or user permission. Null means "no access".
 */
export function resolveAuth0Role(
	claims: Record<string, unknown>,
	email: string,
	config: ControlConfig,
): "admin" | "student" | null {
	// An unverified address proves nothing: anyone can register it in a
	// tenant that allows sign-up.
	if (
		claims.email_verified === true &&
		config.adminEmails.includes(email.toLowerCase())
	) {
		return "admin";
	}
	const permissions = Array.isArray(claims.permissions)
		? claims.permissions
		: [];
	if (permissions.includes(config.auth0AdminPermission)) {
		return "admin";
	}
	if (permissions.includes(config.auth0UserPermission)) {
		return "student";
	}
	return null;
}
