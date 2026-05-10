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
import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { Database } from "bun:sqlite";
import { createAuthMiddleware, APIError } from "better-auth/api";
import type { ControlConfig } from "../config";
import { buildSocialProviders } from "./providers";
import { isEmailAllowed } from "./allowlist";

function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "student";
  return local
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 40) || "student";
}

export type AuthCallbacks = {
  /** Called after OAuth callback for new users to create their workspace. */
  ensureWorkspace: (userId: string, slug: string) => Promise<void>;
};

export function createAuth(db: Database, config: ControlConfig, callbacks: AuthCallbacks) {
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
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Enforce allowlist on new user creation
            if (!isEmailAllowed(user.email)) {
              throw new APIError("FORBIDDEN", {
                message: "Your email is not on the roster. Ask your coach to add you.",
              });
            }
            // Generate slug from email
            return {
              data: {
                ...user,
                slug: slugFromEmail(user.email),
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
            // Revoke the session that was just created
            await ctx.context.internalAdapter.deleteSession(newSession.session.token);
            throw new APIError("FORBIDDEN", {
              message: "Your email is not on the roster. Ask your coach to add you.",
            });
          }

          // Create workspace if this is the user's first login
          if (newSession) {
            const user = newSession.user as { id: string; slug?: string };
            const slug = user.slug ?? slugFromEmail(newSession.user.email);
            try {
              await callbacks.ensureWorkspace(user.id, slug);
            } catch (err) {
              console.error("Failed to create workspace for new user:", err);
            }
          }
        }
      }),
    },
  };

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
