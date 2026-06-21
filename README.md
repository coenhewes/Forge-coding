# Forge

**A long-horizon software-engineering agent that turns a task into a verified, reviewable pull request.**

Forge is not a chat app that can edit files. It is a coding agent wrapped in a
*harness*: a repo-aware semantic operating environment that gives the same model
better engineering outcomes on real, multi-file, multi-domain tasks.

> **Same model. Same repo. Same task. Better harness. Better engineering outcomes.**

See [`AGENTS.md`](./AGENTS.md) for the full product thesis.

---

## What makes Forge different

Most coding agents hand the model a flat filesystem and a pile of `read_file` /
`write_file` / `run_command` tools. Forge instead operates the repository as a
mapped software system:

- **Repo map & repository graph** — packages, routes, services, DB schema,
  migrations, test suites, and a symbol/call/import graph.
- **Semantic MCP fabric** — domain-routed, repo-aware capabilities
  (`repo.find_callers`, `repo.find_definitions`, `repo.explain_dependency_path`,
  `db.get_table_schema`, `tests.find_related_tests`, …) for discovery and
  localization, instead of grepping blind.
- **Durable task state** — task engine, acceptance contract, evidence ledger,
  failure ledger, decision ledger, and a verification matrix, all persisted to
  `.forge/` so work survives context resets and process restarts.
- **Risk model** — classifies the task (auth, billing, migrations, data
  deletion, …) and escalates verification/approval discipline accordingly.
- **Checkpoints & rollback** — snapshot the working tree before risky changes
  and roll back failed attempts (`rollback_checkpoint`).
- **Cross-domain expansion** — start bounded, widen scope deliberately
  (`request_domain_expansion`) when evidence demands it.
- **Branch → commit → reviewable PR** — every successful run produces a git
  branch, a commit, and a structured PR body (evidence, risks, verification,
  failure/recovery, review guidance).

---

## Quick start

```bash
pnpm install
pnpm build

# Configure a provider (interactive)
node packages/forge-cli/dist/cli.js setup
# …or write .forge/config.json directly (see below)

# Run a task in the current repo
node packages/forge-cli/dist/cli.js run "Add pagination to the users list endpoint"
```

The `forge` script is also wired at the repo root: `pnpm forge run "<task>"`.

### Configuration (`.forge/config.json`)

```json
{
  "provider": { "name": "anthropic", "model": "claude-opus-4-8", "maxTokens": 8192, "temperature": 0.2 },
  "mode": "implement",
  "git": { "autoBranch": true, "autoCommit": true, "pr": "file", "branchPrefix": "forge/" }
}
```

API keys are read from the environment (never committed): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`. Supported providers:
`anthropic`, `openai`, `openrouter`, `ollama`, `ollama-cloud`, `minimax`.

`git.pr` is `"file"` (write the PR body to `.forge/tasks/<id>/PR.md`), `"gh"`
(open a real PR via the `gh` CLI), or `"off"`.

---

## CLI

| Command | Description |
| --- | --- |
| `forge` | Interactive REPL |
| `forge run <task>` / `--file <path>` | Run a task |
| `forge status [taskId]` | Task status, acceptance contract, verification matrix |
| `forge resume <taskId> [answer]` | Resume a blocked task, injecting your answer |
| `forge tasks` | List all tasks |
| `forge checkpoint <taskId>` | Checkpoints and patch candidates |
| `forge evidence <taskId>` | Evidence, failure, and decision ledgers |
| `forge dashboard [taskId]` | TUI dashboard |
| `forge setup` | Provider/model setup wizard |

### Modes

`explore`, `implement`, `repair`, `review`, `maintain`, `research` — each gives
the agent distinct operating instructions (e.g. `repair` follows
localize → patch → re-verify; `review`/`explore`/`research` do not modify code).

---

## Packages

| Package | Role |
| --- | --- |
| `@forge/cli` | CLI entry point and commands |
| `@forge/tui` | REPL, dashboard, setup wizard |
| `@forge/agent` | The agent loop, tools, and context builder |
| `@forge/harness` | Repo map, repo graph, domains, semantic capability fabric, risk model |
| `@forge/provider` | LLM provider abstraction (Anthropic/OpenAI/OpenRouter/Ollama/Minimax) |
| `@forge/state` | Task state + acceptance/evidence/failure/decision ledgers |
| `@forge/verification` | Verification matrix, affected-test selection, checkpoints |
| `@forge/pr` | PR body generation + git integration |
| `@forge/trace` | Task flight recorder |
| `@forge/types` | Shared types |
| `@forge/eval` | Forge-vs-flat comparison harness + `sample-saas` fixture |

---

## Evaluation harness

Forge ships a baseline-comparison harness that runs the **same task** twice — once
with the full harness, once with a flat baseline (no semantic fabric, no ledgers) —
and prints the metric deltas.

```bash
pnpm build
MINIMAX_API_KEY=... node packages/forge-eval/dist/cli.js demo
# or a custom task:
node packages/forge-eval/dist/cli.js run --task "Add X" --fixture ./packages/forge-eval/fixtures/sample-saas
```

The headline demo (`demo`) implements organization invitations across auth, db,
api, frontend, and tests on the `sample-saas` fixture.

### Golden gauntlet (Forge vs opencode, same model)

`_bench/golden/` is the rigorous head-to-head benchmark: it reproduces a **real merged upstream fixing
PR** (or a multi-bug set), gives Forge and `opencode` the **identical fix-free task** on the same
MiniMax-M3 model, and gates on the PR's **golden test + full suite green** (so a no-op or a weakened
test cannot pass). It scores **quality-adjusted**: pass-rate + median main-model tokens + fix
minimality (diff size vs the reference PR), with multi-run averaging for model variance.

```bash
node _bench/golden/golden-gauntlet.mjs --case GL02 --runs 3        # both agents, 3 runs each
node _bench/golden/golden-gauntlet.mjs --case GG01 --agent forge   # one agent
node _bench/golden/golden-gauntlet.mjs --case GL02 --prep-only     # validate a case reproduces
```

Requires Postgres (54329) + Ollama (`qwen2.5-coder:14b`, `nomic-embed-text`) up, and MiniMax + opencode
configured. **Read `AGENTS.md` → "Engineering Status & Harness Findings" and `docs/harness-comparison-opencode.md`
before working on the harness** — they capture the current results, the opencode structural comparison,
and the active "clean-core" rebuild (full-transcript context + overflow-only compaction + semantic
retrieval + the bug fixes that took Forge from failing to beating opencode on tokens).

---

## Development

```bash
pnpm build       # build all packages (tsc, project references)
pnpm typecheck   # strict typecheck
pnpm test        # vitest unit/integration tests
```

## License

MIT
