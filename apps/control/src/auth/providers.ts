/**
 * OAuth provider configuration for Better Auth.
 *
 * Reads GitHub and Google credentials from ControlConfig and builds
 * the socialProviders object that betterAuth() expects.
 */
import type { ControlConfig } from "../config";

export type SocialProviders = {
  github?: { clientId: string; clientSecret: string; overrideUserInfoOnSignIn: boolean };
  google?: { clientId: string; clientSecret: string; overrideUserInfoOnSignIn: boolean };
};

export type OAuthProvider = "github" | "google";

export function getEnabledAuthProviders(config: ControlConfig): OAuthProvider[] {
  const providers: OAuthProvider[] = [];

  if (config.githubClientId && config.githubClientSecret) {
    providers.push("github");
  }

  if (config.googleClientId && config.googleClientSecret) {
    providers.push("google");
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
