# Decision 014 — Better Auth Integration

**Status:** Accepted  
**Date:** 2026-05-10

## Context

Plan 05 replaces the username-picker login flow with OAuth (GitHub + Google)
via Better Auth. The existing auth model uses hand-rolled HMAC-signed cookies,
a `users` table with `usr_*` IDs, and a `sessions` table with `ses_*` IDs.
Better Auth manages its own `user`, `session`, `account`, and `verification`
tables with opaque string IDs.

The question is how to integrate without creating a compatibility mess.

## Decision

**Let Better Auth own its tables; adapt our app around it.**

1. **Table names.** Better Auth's default table names (`user`, `session`,
   `account`, `verification`) are used without customization. Migration 007
   drops the pre-OAuth `users` and `sessions` tables instead of preserving
   compatibility copies; there are no production users of the authless model.

2. **User identity.** Better Auth generates opaque string IDs for users.
   The `workspaces` table's `user_id` column now stores Better Auth user
   IDs (not `usr_*`). The `@frc-coderunner/contracts` package treats user IDs as
   bounded opaque strings and no longer exports the old `usr_*`/`ses_*`
   pattern constants.

3. **Custom fields.** `role` (`student` | `admin`, default `student`) and
   `slug` (workspace slug, derived from email) are added via Better Auth's
   `additionalFields` on the user model. This keeps our app-specific data
   co-located with the user record without a separate table.

4. **Session management.** Better Auth manages sessions, cookies, and
   token refresh. The old `cookies.ts` HMAC module is deleted. Better Auth's
   session cookie is explicitly named `coderunner_session`.

5. **Migration strategy.** Our migration runner applies migration 007 (remove
   old auth tables, rebuild FK-dependent tables). Then Better Auth's programmatic
   `runMigrations()` creates its own tables. This ensures Better Auth's schema
   is always up to date with the installed version.

6. **Workspace creation.** Happens in `storage.ensureWorkspaceForUser()`,
   called after OAuth callback when a new user has no workspace. Slug
   collisions are resolved with numeric suffixes.

## Consequences

- Pre-OAuth `usr_*` / `ses_*` ID patterns are no longer generated or accepted
  as a special case. Test fixtures and any code that pattern-matches on these
  must be updated.
- The `cookies.ts` module is removed; Better Auth is the only auth/session
  implementation.
- Better Auth version upgrades may introduce schema changes; running
  `runMigrations()` at startup handles this automatically.
