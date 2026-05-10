/**
 * OAuth provider configuration for Better Auth.
 *
 * Reads GitHub and Google credentials from ControlConfig and builds
 * the socialProviders object that betterAuth() expects.
 */
import type { ControlConfig } from "../config";

export type SocialProviders = {
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
};

export function buildSocialProviders(config: ControlConfig): SocialProviders {
  const providers: SocialProviders = {};

  if (config.githubClientId && config.githubClientSecret) {
    providers.github = {
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
    };
  }

  if (config.googleClientId && config.googleClientSecret) {
    providers.google = {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
    };
  }

  return providers;
}
