# Forge Operating Notes

Internal conventions, port numbers, commands, and gotchas for working on
this Forge repo. Project-specific — not the product brief (see
`AGENTS.md`) and not the licensing/attribution rules (see
`docs/REFERENCE_REPOS.md`).

## Postgres (state-store backing DB)

- **Binary:** `/opt/homebrew/opt/postgresql@16/bin/{initdb, pg_ctl, psql, pg_isready, postgres}`
- **Data dir:** `/Users/coenhewes/Documents/Forge-code/Forge-coding/.local/pgdata` (`.local/` is gitignored — recreate via initdb if wiped)
- **Port:** **54329** (non-default to avoid colliding with any system pg on 5432)
- **Role + password:** `forge` / `forge` (superuser-equivalent; dev-only cluster)
- **Database:** `forge`
- **Auth:** `pg_hba.conf` is `local trust` + `host md5` on 127.0.0.1/::1

### Start the server

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  /opt/homebrew/opt/postgresql@16/bin/pg_ctl \
    -D /Users/coenhewes/Documents/Forge-code/Forge-coding/.local/pgdata \
    -l /Users/coenhewes/Documents/Forge-code/Forge-coding/.local/pgdata/server.log \
    start
```

The `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` exports are mandatory — without
them the postmaster crashes with `Set the LC_ALL environment variable to
a valid locale`.

### Stop / restart

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D <pgdata> stop
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D <pgdata> restart
```

### Verify

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_isready -p 54329
PGPASSWORD=forge psql 'postgres://forge:forge@localhost:54329/forge' -c 'select 1'
PGPASSWORD=forge psql 'postgres://forge:forge@localhost:54329/forge' -c '\dt'
```

## Environment file

`.env` lives at the repo root with `FORGE_DATABASE_URL` and (when set)
provider keys. `.env` and `.local/` are gitignored. `.env.example`
documents the schema and is the safe template for new clones.

**Do not commit `.env`.** Edit `.env.example` if you add new vars.

## Migrations

All SQL DDL lives in `packages/forge-state-store/src/schema.ts` (the
`MIGRATIONS[]` array). The migration runner in `store.ts` is intentionally
DDL-free — it only reads SQL from `MIGRATIONS`, runs each version in its
own transaction, and records the applied version in `schema_migrations`.

### Bootstrap a fresh database

```bash
pnpm doctor:migrate    # runs 'forge doctor --migrate' (loads .env, health-checks, migrates)
pnpm migrate           # 'forge state migrate' (migrations only)
pnpm doctor            # health check, no migrations
```

All three use `node -r dotenv/config` to load `.env` automatically.
`doctor:migrate` is idempotent — safe to re-run.

### Add a new migration

Append a new entry to `MIGRATIONS[]` in `schema.ts`. **Never** add DDL to
`store.ts`. The runner will pick up the new version on next run and skip
already-applied versions.

## Test setup

`vitest.config.ts` references `tests/setup-env.ts` via `setupFiles`. The
setup file parses `.env` from the repo root, never clobbers an existing
shell override, and warns when `FORGE_DATABASE_URL` is unset. This
prevents silent skips of live-DB tests.

Verify the setup works on a clean shell:

```bash
unset FORGE_DATABASE_URL && pnpm test
```

Should still report `39/39 passed, 0 skipped` because `.env` is loaded
by the setup file.

## Workspace

- 17 packages under `packages/`, picked up by `pnpm-workspace.yaml`
  glob `'packages/*'`.
- Root `package.json` declares every `@forge/*` package as a `devDep`
  so tests can import them without an extra `pnpm install` per package.
- Build: `pnpm -r build` (uses `tsc` with project references per package).
- Typecheck: `pnpm -r typecheck`.
- Clean: `pnpm -r clean` (removes `dist/` and `*.tsbuildinfo` per package).

## Driver choice: porsager/postgres

`@forge/state-store` uses `postgres` (porsager/postgres), not `pg`
(node-postgres). Reasons:

- ESM-native, single-purpose, zero deps.
- Tag-template-first, no callback/pool ceremony.
- Throws on bad queries (no silent promise resolution with weird shape).

If a future track needs LISTEN/NOTIFY replication, COPY streaming at
high throughput, or compatibility with an ORM that requires `pg`, revisit.

## Database schema versioning

`REQUIRED_SCHEMA_VERSION` in `schema.ts` is the source of truth. Bump
it when adding a migration that the rest of the workspace must require
to function. The `state-store` package checks this on `health()` and
surfaces a warning if the running DB is behind.

## Scaffold package conventions

Three packages shipped as typed placeholders for later tracks to fill
in. Each one exports a `*_VERSION` constant and a typed handle, with no
real wiring:

- `@forge/context-server` → `CONTEXT_SERVER_VERSION` + `ContextServerHandle`
- `@forge/integrations` → `INTEGRATION_REGISTRY` (frozen, typed empty)
- `@forge/vscode` → `FORGE_VSCODE_EXTENSION` (frozen, no `vscode` dep)

Tests live in `tests/{context-server,integrations,vscode}.test.ts` and
assert the public surface. Future tracks can replace the bodies without
touching the tests if they keep the exports stable.

## Reference repos

See `docs/REFERENCE_REPOS.md`. Two read-only clones under
`/Users/coenhewes/Documents/Forge-code/_refs/`:

- `_refs/opencode/` — MIT. OK to copy into Forge with attribution.
- `_refs/claude-code/` — UNLICENSED. Research-only, do not copy.