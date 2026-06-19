# Quick Start

This guide gets Forge ready for local long-horizon runs.

## 1. Install and Build

```bash
pnpm install
pnpm build
```

Forge requires Node.js 18 or newer and pnpm.

## 2. Start Postgres

Normal Forge runs are Postgres-first. The durable task store is the source of truth for resume, evidence, verification, trace, and multi-agent safety.

For this repo, the local development database uses:

```text
postgres://forge:forge@localhost:54329/forge
```

Start the bundled local Postgres cluster:

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  /opt/homebrew/opt/postgresql@16/bin/pg_ctl \
    -D /Users/coenhewes/Documents/Forge-code/Forge-coding/.local/pgdata \
    -l /Users/coenhewes/Documents/Forge-code/Forge-coding/.local/pgdata/server.log \
    start
```

Verify it:

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_isready -p 54329
PGPASSWORD=forge psql 'postgres://forge:forge@localhost:54329/forge' -c 'select 1'
```

## 3. Configure Environment

Create or update `.env`:

```bash
FORGE_DATABASE_URL=postgres://forge:forge@localhost:54329/forge
OPENROUTER_API_KEY=...
```

Use the provider key that matches `.forge/config.json`.

For the MiniMax evaluation setup, use:

```bash
MINIMAX_API_KEY=...
```

Forge reads provider keys from environment variables before falling back to config values.

## 4. Initialize Forge

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js init
```

`forge init` is idempotent. It:

- creates `.forge/config.json`
- creates `.forge/state/connection.json`
- creates state/artifact directories
- patches `.gitignore`
- validates Postgres and runs migrations
- imports existing `.forge/tasks/*.json` file state into Postgres when possible

## 5. Check the System

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js doctor
node -r dotenv/config packages/forge-cli/dist/cli.js local status
node -r dotenv/config packages/forge-cli/dist/cli.js local test
```

`doctor` checks Postgres, schema, and provider reachability.

`local status` and `local test` check the non-authoritative local model layer. Missing local models do not corrupt correctness, but long runs warn before using deterministic fallbacks.

## 6. Run a Task

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js run \
  "Build a production-ready Linktree-style SaaS in ./sandbox/saas5"
```

Default run budget:

- 8 hours wall clock
- 10000 emergency iterations
- continuous durable state writes
- budget exhaustion returns `paused`, not `blocked`

If no local model is available, approve deterministic fallbacks explicitly:

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js run \
  --allow-no-local \
  "Build a production-ready Linktree-style SaaS in ./sandbox/saas5"
```

## 7. Resume or Continue

Preferred interactive path:

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js
```

Open Forge, list tasks, and continue the paused or blocked task from the TUI.

Script-compatible path:

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js resume <taskId>
```

Resume reconstructs hot context from Postgres through the Forge Context Server. It does not rely on the old chat transcript.

## 8. Degraded File Mode

File mode is an explicit emergency fallback:

```bash
node packages/forge-cli/dist/cli.js run \
  --state-mode=file \
  --allow-no-local \
  "small offline task"
```

File mode is intentionally labeled degraded:

- weaker resume semantics
- no transactional Postgres writes
- weaker multi-agent safety
- less complete trace and verification durability

Use it only when Postgres is unavailable and the task is low-risk.

## 9. Install the Global Command

```bash
pnpm link:global
```

Then from any project:

```bash
forge init
forge run "implement the task"
forge status
```

If the global command does not load `.env`, run with `node -r dotenv/config ...` or export the required environment variables in your shell.

## 10. Local Docs

```bash
pnpm docs
```

Open `http://localhost:4173`.
