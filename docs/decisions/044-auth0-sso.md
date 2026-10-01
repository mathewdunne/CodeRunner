# 044 — Auth0 SSO

## Decision

Add Auth0 as a third sign-in provider (gh #24) for teams that already manage
members in an Auth0 tenant. Auth0 is enabled when `AUTH0_DOMAIN`,
`AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` are set, and sits alongside GitHub
and Google; each configured provider gets a login button.

Auth0 is not a Better Auth social provider, so it goes through the
`genericOAuth` plugin's `auth0()` helper (OIDC discovery). Its callback is
`/api/auth/oauth2/callback/auth0`, not `/callback/:id`, which is how the hooks
tell Auth0 sign-ins apart.

**Auth0 replaces the allowlist for its users.** The operator's tenant is
trusted to vet members. Authorization comes from a roles claim in the ID token,
put there by a Post-Login Action (`api.idToken.setCustomClaim`), rather than
from RBAC permissions in an access token: the ID token is what Better Auth
already decodes, and an Action needs no Auth0 API/audience setup. The claim
name and the two role names are env vars (`AUTH0_ROLES_CLAIM`,
`AUTH0_USER_ROLE_NAME`, `AUTH0_ADMIN_ROLE_NAME`; defaults
`https://coderunner/roles`, `user`, `admin`) so a tenant with existing role
names (e.g. `teacher`) only has to match them.

- The admin role maps to `admin`, the user role to `student`; neither means
  denied. `CODERUNNER_ADMIN_EMAIL` still grants admin and skips the role
  requirement, so the operator's bootstrap admin works whatever the tenant does
  — but only when the ID token says `email_verified: true`. A tenant that
  allows sign-up lets anyone register an address and sign in before verifying
  it, so an unverified admin email falls back to the roles claim.
- Roles are re-read at every Auth0 sign-in. `mapProfileToUser` returns the role
  and `overrideUserInfo` writes it to the user row before the session is made,
  so the session cookie cache carries the current role. An admin-panel role
  change on an Auth0 user is overwritten at their next sign-in.
- Users without a role are rejected in `mapProfileToUser`, which throws the
  same `APIError("FOUND")` that `ctx.redirect` builds. It runs once per callback
  with the claims of the identity signing in, before Better Auth creates,
  links, or updates anything, so a denied sign-in leaves no user row, account
  row, or session. An earlier version checked in `session.create.before` by
  reading the ID token stored on the user's `auth0` account; Auth0 gives each
  connection (database, Google, …) its own `sub`, and Better Auth links two
  identities with the same verified email as two `auth0` accounts on one user,
  so that check could read the other identity's token and its role.

**Why not deny in the after hook,** as the allowlist does for returning social
users: Better Auth (1.6.10) keeps the callback's original 302 status and
`Location` when an after hook throws, so the error is lost and the browser is
sent to `/` with fresh session and `session_data` cookies. Deleting the session
row does not help because `getSession` trusts the 5-minute cookie cache. Errors
from the profile mapper are not caught by the callback, so a redirect thrown
there reaches the browser as `/login?error=…` with no session at all.

The returning-user allowlist check for GitHub/Google has the same after-hook
weakness; it is out of scope here and left unchanged.

## Validation

`apps/control/src/__tests__/auth0.test.ts` runs the real Better Auth sign-in and
callback against a stubbed Auth0 (discovery + token endpoint via `fetch`):
student and admin first sign-in without an allowlist entry, no-role denial
without a user row, the admin-email override, promotion/demotion on later
sign-ins (DB and session cookie), a no-role returning user getting
`/login?error=…` with no new session, and a no-role second identity linked to
an admin user being denied. Unverified admin emails are covered by the role
mapping unit tests. Role mapping and provider discovery have
unit tests. A real Auth0 tenant round trip has not been run.
