---
sidebar_position: 2
title: OAuth Credentials
---

# OAuth Credentials

CodeRunner does not store passwords. Sign-in is handled by
[Better Auth](https://www.better-auth.com/) using GitHub, Google, and/or
Auth0 as OAuth providers. **At least one provider must be configured** for any
non-demo deployment; without one, the login page has no working sign-in button.

Configure as many as you like; each configured provider gets its own button.
Auth0 is for teams that already manage their members in an Auth0 tenant: Auth0
users skip the allowlist and get their CodeRunner role from Auth0 (see
[Set up Auth0](#set-up-auth0)).

This page covers registering the OAuth apps and wiring the resulting
credentials into CodeRunner. The values you produce here are used the same way
whether you deploy [locally](./local.md) or to [Google Cloud](./gcloud.md);
only the URLs differ (`http://localhost:4000` vs `https://<your-domain>`).

## The two URLs you will need

Every OAuth app registration asks for a homepage/origin URL and a redirect
(callback) URL. For CodeRunner:

- **Homepage / origin** = your `BETTER_AUTH_URL` (the public base URL of the
  app).
- **Callback / redirect URL** = `BETTER_AUTH_URL` + a fixed per-provider path.
  Better Auth mounts its routes at `/api/auth` (confirmed in
  `apps/control/src/auth/auth.ts`), so the callbacks are:

  | Provider | Callback URL |
  | --- | --- |
  | GitHub | `<BETTER_AUTH_URL>/api/auth/callback/github` |
  | Google | `<BETTER_AUTH_URL>/api/auth/callback/google` |
  | Auth0 | `<BETTER_AUTH_URL>/api/auth/oauth2/callback/auth0` |

For local development that is `http://localhost:4000/api/auth/callback/github`
and `.../google`. For the cloud VM it is
`https://<your-domain>/api/auth/callback/github` and `.../google`.

## Register a GitHub OAuth app

In GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

- **Application name:** anything (e.g. "CodeRunner - Team 1234").
- **Homepage URL:** your `BETTER_AUTH_URL`.
- **Authorization callback URL:** `<BETTER_AUTH_URL>/api/auth/callback/github`.

Save, then generate a client secret. You now have a **Client ID** and a
**Client Secret**.

## Register a Google OAuth client

In the Google Cloud console:

1. **APIs & Services → OAuth consent screen**: configure it once (External
   user type is fine for a team). Add your sign-in email as a test user while
   the app is in testing.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
   - **Authorized JavaScript origins:** your `BETTER_AUTH_URL`.
   - **Authorized redirect URIs:** `<BETTER_AUTH_URL>/api/auth/callback/google`.

You now have a **Client ID** and a **Client Secret**.

## Set up Auth0

Auth0 sign-in works differently from GitHub and Google: Auth0 has already
vetted your members, so **Auth0 users skip the allowlist**. Instead, CodeRunner
uses Auth0's role-based access control (RBAC): it asks Auth0 for an access
token for a CodeRunner API and reads the user's permissions on that API at
every sign-in. Because the permissions belong to that one API, they don't
overlap with what the same users can do in your tenant's other apps.

| Permissions on the CodeRunner API | CodeRunner result |
| --- | --- |
| Has the admin permission (`AUTH0_ADMIN_PERMISSION`, default `coderunner:admin`) | Signs in as an admin |
| Has the user permission (`AUTH0_USER_PERMISSION`, default `coderunner:user`) | Signs in as a student |
| Neither | Denied |

An email listed in `CODERUNNER_ADMIN_EMAIL` signs in as an admin, with or without
Auth0 permissions, once Auth0 has verified that address (`email_verified`). An
unverified address gets no special treatment and needs a permission like anyone
else. Because permissions are re-read at every Auth0 sign-in, changing a user's
roles or permissions in Auth0 takes effect the next time they sign in. Promoting
or demoting an Auth0 user in the CodeRunner admin panel is overwritten at that
user's next sign-in, so manage Auth0 users' access in Auth0.

In the Auth0 dashboard:

1. **Applications → Applications → Create Application**, type **Regular Web
   Application**. In its **Settings**, set **Allowed Callback URLs** to
   `<BETTER_AUTH_URL>/api/auth/oauth2/callback/auth0`. Note the **Domain**,
   **Client ID**, and **Client Secret**.
2. **Applications → APIs → Create API**. Give it a name (e.g. `CodeRunner`)
   and an **Identifier**, e.g. `https://coderunner.example.com/api`. The
   identifier is the API's audience and becomes `AUTH0_AUDIENCE`; it is only a
   label inside the token, nothing fetches it.
3. In that API:
   - **Settings → RBAC Settings**: turn on **Enable RBAC** and **Add
     Permissions in the Access Token**, then save.
   - **Permissions**: add `coderunner:user` and `coderunner:admin`. To use
     other names, set `AUTH0_USER_PERMISSION` / `AUTH0_ADMIN_PERMISSION` to
     match.
   - If the API's **Application Access** settings restrict which applications
     may request tokens for users, allow the application from step 1.
4. **User Management → Roles**: create roles (e.g. `Student` and `Coach`), add
   the matching permission from the CodeRunner API to each, and assign the
   roles to your members. (Permissions can also be given to a user directly
   under **User Management → Users → Permissions**.)

Then set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and
`AUTH0_AUDIENCE` (below). The login page shows **Sign in with Auth0** once all
four are set.

## Wire the credentials into CodeRunner

CodeRunner reads these from environment variables (see
`apps/control/src/config.ts` and [Configuration](../reference/configuration.md)):

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_URL` | Public base URL. **Must match** the homepage/callback URLs you registered. Defaults to `http://localhost:4000`. |
| `BETTER_AUTH_SECRET` | Secret used to sign sessions. **Change this in production**; the built-in default is a dev placeholder. Generate one with `openssl rand -hex 32`. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `AUTH0_DOMAIN` | Auth0 tenant domain, e.g. `myteam.us.auth0.com` |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret |
| `AUTH0_AUDIENCE` | Identifier of the Auth0 API that holds CodeRunner's permissions |
| `AUTH0_USER_PERMISSION` | API permission that signs in as a student (default `coderunner:user`) |
| `AUTH0_ADMIN_PERMISSION` | API permission that signs in as an admin (default `coderunner:admin`) |

A provider only appears on the login page when **both** its ID and secret are
set (for Auth0, the domain and audience too). Where these values live depends on the deployment:

- **Local:** in your `.env` file. See [Local Deployment](./local.md).
- **Cloud VM:** in Google Secret Manager, materialized into the VM's `.env` by
  `render-env.sh` at boot. See [Google Cloud Deployment](./gcloud.md).

## Bootstrapping the first admin

OAuth establishes *who* a person is; CodeRunner separately controls *whether*
they may sign in (the allowlist) and *whether* they are an admin (the role).
This section applies to GitHub and Google sign-ins; Auth0 users get both from
their Auth0 permissions instead (see [Set up Auth0](#set-up-auth0)), though
`CODERUNNER_ADMIN_EMAIL` still makes them an admin if Auth0 has verified the
address.

### The easy path: `CODERUNNER_ADMIN_EMAIL`

Set `CODERUNNER_ADMIN_EMAIL` (comma-separated for multiple people) alongside
your OAuth credentials before the first startup and the two steps below happen
automatically — **no exec commands needed**. At startup the control plane adds
each listed email to the allowlist, and on first OAuth sign-in the account is
created with the admin role. An account that already exists with that email is
promoted to admin at the next startup, so it also rescues a coach who signed in
before the env var was set. (Auth0 accounts are not promoted at startup; they
pick up the admin role at their next Auth0 sign-in once Auth0 has verified the
address.)

```bash
CODERUNNER_ADMIN_EMAIL=coach@frcteam.org,assistant@frcteam.org
```

This is the recommended way to reach the admin panel on a fresh deployment. The
manual commands below are still useful for allowlisting students and for
changing roles later.

### Manual bootstrap and later changes

:::note[Running these commands]

On a containerized deployment (the default) the `allowlist` and `users`
commands run **inside the control container** via the `coderunner` CLI:

```bash
docker compose exec control coderunner allowlist add coach@frcteam.org
docker compose exec control coderunner users promote coach@frcteam.org
```

Use `docker compose run --rm control <subcommand>` instead while the control
plane is stopped. On the Google Cloud VM the compose project lives in
`/opt/coderunner` and needs `sudo` (`cd /opt/coderunner && sudo docker compose
exec -T control …`). The `bun run …` short forms shown below are equivalent
and apply to a from-source host checkout with Bun.

:::

### 1. Allowlist the emails that may sign in

The allowlist gates every OAuth login. Until an email or domain is added,
sign-in is blocked for everyone. Add an individual email or a whole domain:

```bash
bun run allowlist:add coach@frcteam.org
# or allow an entire domain:
bun run allowlist:add frcteam.org
```

Other allowlist commands: `bun run allowlist:list`, `bun run allowlist:remove`.

### 2. Promote the first admin

Every user, including the first one, signs in as a regular user. After the
first coach has signed in once (so their user row exists), promote them to
admin:

```bash
bun run users:promote coach@frcteam.org
```

The reverse is `bun run users:demote`, and `bun run users:list` shows current
roles. On the cloud VM, run `coderunner users promote` over IAP SSH; see the
[Google Cloud Deployment](./gcloud.md) "Become the first admin" step.

> Admins also get a break-glass option: setting the `ADMIN_TOKEN` env var lets
> you call the `/admin/*` API with a bearer token even before any user is
> promoted. See [Configuration](../reference/configuration.md).
