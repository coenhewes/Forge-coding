# team-invitations

A Forge eval fixture: a small multi-tenant SaaS app that **already exposes
the surface area for team invitations** (a `invitations` table, route
stubs, the permission helper) so the agent's job is to **fill in the
behavior** rather than invent the structure from scratch.

This is a long-horizon, multi-domain task: invitations touch `auth`
(role check), `db` (schema + migration), `api` (create/accept/revoke
endpoints), `frontend` (admin invite UI), and `tests` (unit + API
coverage). The AGENTS.md §34 killer demo runs against this fixture.

## Layout

- `src/auth/permissions.ts` — role helpers (mirrors sample-saas).
- `src/api/invitations.ts` — route stubs (create, accept, revoke). Bodies
  raise `NotImplementedError` so the agent must fill them in.
- `src/db/schema.ts` — in-memory `db` map + `Invitation` type.
- `src/db/migrations/0001_init.ts` — users / organizations / memberships.
- `src/db/migrations/0002_invitations.ts` — invitations table with
  `expires_at`, `revoked_at`, `accepted_at`, `invitee_email`, `role`,
  `org_id`, `invited_by`.
- `src/frontend/InvitationsPage.tsx` — admin page stub.
- `tests/invitations.test.ts` — failing tests the agent must turn green.
- `tests/permissions.test.ts` — permission regression tests.

## Eval task

The eval task is `Add team invitations with roles, expiry, audit logs`.
It must:
- Add a `POST /orgs/:id/invites` endpoint that enforces
  `canManageMembers` and returns 403 for non-managers.
- Add a `POST /invites/:token/accept` endpoint that rejects expired
  (now > expires_at) and revoked (`revoked_at != null`) invitations.
- Persist role + expiry on creation; allow admin to revoke.
- Add unit tests for create / accept / expire / revoke paths.

## Cross-domain layout

| domain    | files                                                   |
|-----------|---------------------------------------------------------|
| auth      | src/auth/permissions.ts                                 |
| database  | src/db/schema.ts, src/db/migrations/0001_init.ts, 0002  |
| api       | src/api/invitations.ts                                  |
| frontend  | src/frontend/InvitationsPage.tsx                        |
| tests     | tests/invitations.test.ts, tests/permissions.test.ts    |
