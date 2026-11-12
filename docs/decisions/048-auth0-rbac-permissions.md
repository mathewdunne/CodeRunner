# 048 — Auth0 roles from RBAC permissions

## Decision

Auth0 sign-ins get their CodeRunner role from Auth0 RBAC permissions in an
access token for a CodeRunner API, not from a custom roles claim in the ID
token (gh #32). This replaces the authorization half of decision 044.

The operator creates an Auth0 API, turns on **Enable RBAC** and **Add
Permissions in the Access Token**, and defines two permissions on it.
`AUTH0_AUDIENCE` is that API's identifier; `AUTH0_USER_PERMISSION` and
`AUTH0_ADMIN_PERMISSION` (defaults `coderunner:user`, `coderunner:admin`) name
the permissions. Auth0 is enabled only when the audience is set along with the
domain and client credentials; with the other three set and no audience, the
control plane logs a warning and hides the button rather than showing one
that denies everybody.

**Why:** an ID-token roles claim carries the user's tenant-wide roles, so a role
named `admin` for another app in the same tenant would also make that user a
CodeRunner admin. Permissions are scoped to one API (audience), which is how
Auth0 intends apps to keep their authorization separate. It also removes the
Post-Login Action from setup.

- The provider passes `audience` as an authorization URL parameter, so the
  token endpoint returns a JWT access token for the API. A custom
  `getUserInfo` decodes the ID token (identity, `email_verified`) and the
  access token, and sets `permissions` from the access token after the ID-token
  claims, so an ID-token claim of the same name can't grant anything.
  `mapProfileToUser` then maps permissions to a role exactly as it did roles.
- Neither token's signature is checked. Both come straight from Auth0's token
  endpoint over TLS in exchange for the code and client secret, which is the
  same trust Better Auth already gives the ID token; nothing else presents the
  access token to CodeRunner.
- An opaque access token (no audience, or an audience Auth0 doesn't know)
  decodes to no permissions and the user is denied, logged with the
  permissions seen.
- Better Auth's default fell back to the userinfo endpoint when the ID token
  had no email. The custom `getUserInfo` doesn't; such a sign-in fails, as it
  would anyway without an email to key the user on.

This is a breaking config change for tenants set up per 044: they need the API,
its permissions assigned to roles, and `AUTH0_AUDIENCE`. The old Action can be
removed.

## Validation

`apps/control/src/__tests__/auth0.test.ts`: the stubbed Auth0 token endpoint
now issues a JWT access token carrying `permissions`, and the round-trip tests
(first sign-in, promotion/demotion, denial, linked identities, admin-email
override) run against it. Added: the authorize URL carries the audience; a
`permissions` claim in the ID token alone is denied; an unrelated permission is
denied; an opaque access token is denied. `auth.test.ts` covers the provider
being hidden without an audience. A real Auth0 tenant round trip has not been
run.
