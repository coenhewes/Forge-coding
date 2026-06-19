# Postgres State

Forge uses Postgres as its primary durable memory for normal runs.

## Why Postgres Is Mandatory

Long-horizon software work can span hours, restarts, failed attempts, review cycles, and CI repairs. A model context window is not a durable state layer.

Postgres stores typed engineering state:

- task records
- task snapshots
- sessions and prompt records
- acceptance criteria
- hypotheses and claims
- evidence and artifacts metadata
- failures and decisions
- verification checks and actions
- patch candidates
- trace events

The model never talks to Postgres directly. It asks the Forge Context Server for compact state slices.

## Project Isolation

Every project has a local `.forge` directory.

Important files:

```text
.forge/
  config.json
  state/
    connection.json
  artifacts/
  tasks/              # compatibility/import fallback
```

`connection.json` records the redacted Postgres connection metadata and the project work directory.

Inside Postgres, task rows are scoped by repo/project id. `forge sessions` and `forge status` prefer tasks attached to the current work directory so one project does not bleed into another.

## Initialization

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js init
```

Initialization:

1. resolves `.forge/config.json`
2. writes `.forge/state/connection.json`
3. checks `FORGE_DATABASE_URL`
4. opens Postgres
5. applies migrations
6. imports existing JSON file state when present

If Postgres is not reachable, normal runs are blocked until it is fixed.

## JSON Compatibility

The file engines under `.forge/tasks/*.json` still exist for:

- importing old local runs
- emergency offline fallback
- simple compatibility tests
- export/recovery workflows

They are not the primary state store for serious autonomous execution.

Use degraded mode explicitly:

```bash
forge run --state-mode=file --allow-no-local "small low-risk task"
```

## Resume State

Resume should load from Postgres through `task.resume`.

The resume slice includes:

- task record
- recent task snapshots
- sessions
- prompt records
- next action
- recent trace
- relevant decisions and failures through adjacent context calls

This is hot context rebuilt from durable state, not replayed chat history.

## Operational Commands

```bash
pnpm doctor
pnpm doctor:migrate
pnpm migrate
forge sessions
forge status
```

For local database commands and port details, see [Operating notes](./OPERATING_NOTES.md).
