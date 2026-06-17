# sample-saas

A small multi-tenant SaaS app used as a Forge evaluation fixture. It spans
several engineering domains so Forge's repo map, graph, and domain router have
something realistic to work with:

- `src/auth/` — roles, permissions, sessions
- `src/api/` — request handlers (members)
- `src/db/` — schema models and migrations
- `src/frontend/` — a members page view
- `tests/` — unit tests (node:test)

It is intentionally tiny but structurally complete: organizations, users,
memberships, and role-based permission checks. Eval tasks (e.g. "add organization
invitations with roles and expiry") require coordinated changes across auth, db,
api, frontend, and tests — the long-horizon, multi-domain class Forge targets.
