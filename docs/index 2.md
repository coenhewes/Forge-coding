# Forge — Documentation

**A long-horizon software-engineering agent that turns a task into a verified, reviewable pull request.**

> Same model. Same repo. Same task. Better harness. Better engineering outcomes.

Forge is not a chat app that can edit files. It is a coding agent wrapped in a
*harness*: durable task state, repository-graph awareness, evidence tracking,
verification gating, and resumable execution. This page is the front door — start
here, then drill into the linked pages.

- [Local-model layer](./local-model.md) — the non-authoritative local accelerator
- [Operating notes](./OPERATING_NOTES.md) — day-to-day run/debug guidance
- [Reference repos](./REFERENCE_REPOS.md) — external patterns Forge borrows from
- [`../AGENTS.md`](../AGENTS.md) — the full product thesis
- [`../README.md`](../README.md) — project overview

---

## 1. What Forge does

Most coding agents hand the model a flat filesystem and `read_file` / `write_file`
/ `run_command`. Forge instead operates the repository as a *mapped software
system* and keeps a durable, auditable record of what it believes, why, and what
it has verified.

A run takes a natural-language task and produces:

1. A git **branch**, a **commit**, and a structured **PR body** (evidence, risks,
   verification, failure/recovery, review guidance).
2. A durable **state directory** (`.forge/`) holding the task state, evidence
   ledger, belief graph, verification matrix, and trace — so work survives
   context resets and process restarts and can be **resumed**.

---

## 2. Getting started

### Requirements
- Node.js >= 18
- pnpm
- (Optional) Postgres for the durable state store — set `FORGE_DATABASE_URL`.
- (Optional) [Ollama](https://ollama.com) for the local-model layer.

### Install & build

```bash
pnpm install
pnpm build
```

### Configure

```bash
cp .env.example .env      # fill in provider keys / FORGE_DATABASE_URL
node packages/forge-cli/dist/cli.js init
```

`init` is idempotent: it writes `.forge/config.json`, creates the state
sub-directories, and ensures `.gitignore` entries.

### Install the `forge` command (Claude-Code-style)

Make `forge` available everywhere, so you can `cd` into *any* project and just
type `forge`:

```bash
pnpm link:global      # builds, then `npm link` the CLI globally
```

This symlinks `forge` onto your `PATH` (pointing at the built `cli.js`), so later
`pnpm build` runs are picked up automatically — no need to re-link. To remove it:
`pnpm unlink:global`.

> If your shell can't find `forge` afterwards, ensure your global npm bin dir is
> on `PATH` (`npm prefix -g`/bin). The symlink lives at `$(npm prefix -g)/bin/forge`.

### Run a task

```bash
cd ~/my-project          # any repo you want Forge to work on
forge                    # no args → interactive REPL (auto-uses defaults if uninitialized)
forge run "add rate limiting to the login route"
forge status             # most recent task
```

Run from anywhere; Forge operates on the **current working directory** and keeps
its state in that project's `.forge/`. The first run auto-initializes with default
config (or run `forge init` first to customize). Every command supports `--json`
and `--text` for scripting.

---

## 3. CLI reference

| Command | What it does |
|---|---|
| `forge init` | Idempotent setup (`.env`, state store, `.gitignore`). |
| `forge run <task>` | Run a task through the agent loop. |
| `forge sessions` | List all tasks in the state store. |
| `forge status [taskId]` | Summary for one task (or the most recent). |
| `forge verify <taskId>` | List the open verification matrix. |
| `forge evidence <taskId>` | List the evidence ledger (`--claim <id>` for one). |
| `forge checkpoint <taskId>` | List patch candidates and checkpoints. |
| `forge doctor` | Env + DB + provider reachability check. |
| `forge providers <list\|test>` | List supported LLM providers, or probe one. |
| `forge local <status\|test>` | Inspect/exercise the local-model layer. |
| `forge state migrate` | Apply pending Postgres migrations. |

Advanced: `forge resume <taskId>`, `forge dashboard`, `forge setup`, `forge mcp`.

---

## 4. Configuration (`.forge/config.json`)

Resolved from the file first, then environment variables (so secrets stay in
`.env`, not the committed-adjacent config).

```jsonc
{
  "provider": { "name": "openrouter", "model": "...", "maxTokens": 4096, "temperature": 0.2 },
  "mode": "implement",                 // explore | implement | repair | review | maintain | research
  "features": { "repoGraph": true, "domainSystem": true, "evidenceLedger": true,
                "failureLedger": true, "decisionLedger": true, "checkpointSystem": true, "trace": true },
  "git": { "autoBranch": true, "autoCommit": true, "pr": "file", "branchPrefix": "forge/" },
  "localModel": { "enabled": "auto", "maxInputChars": 24000, "timeoutMs": 20000,
                  "summaryTargetTokens": 200, "compactionThresholdChars": 4000 }
}
```

Key env vars: `FORGE_DATABASE_URL`, `FORGE_STATE_DIR`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`, `OLLAMA_BASE_URL`,
`OLLAMA_EMBED_MODEL`.

---

## 5. Architecture (packages)

Forge is a pnpm workspace. Each package is `@forge/<name>`, built with `tsc`.

| Package | Responsibility |
|---|---|
| `forge-types` | Shared TypeScript types — one file per domain, re-exported from `index.ts`. |
| `forge-provider` | Model providers (Anthropic, OpenAI, OpenRouter, MiniMax, Ollama, Ollama-Cloud) + capability/cost-tier router (`selectProvider`). |
| `forge-local-model` | Non-authoritative local accelerator (summarize/classify/extract/rerank/embed). See [its page](./local-model.md). |
| `forge-state` | File-based task engine, evidence ledger, evidence memory, acceptance, failure/decision ledgers. |
| `forge-state-store` | Postgres durable store + immutable, idempotent migrations. |
| `forge-belief` | Belief graph: hypotheses, claims, assumptions, contradictions, probe planning, diagnostics. |
| `forge-verification` | Checkpoints, affected-test selection, verification matrix engine. |
| `forge-verification-planner` | Evidence-value scoring, active verification planning, completion gating. |
| `forge-repo-graph` / `forge-repo-intel` | Repository graph (symbols/calls/imports) and higher-level intel. |
| `forge-context-server` | Narrow, permissioned read/write capabilities between model and durable state. |
| `forge-trace` | Append-only trace of every meaningful event. |
| `forge-harness` | Context builder / bounding. |
| `forge-integrations` | MCP, issue/PR/chat/CI adapters. |
| `forge-pr` | Git client + PR body generation. |
| `forge-agent` | The agent loop — orchestrates everything above. |
| `forge-cli` | The `forge` command-line interface. |
| `forge-tui` / `forge-vscode` | Terminal dashboard and VS Code surface. |
| `forge-eval` | Baseline comparison harness (Forge vs flat agent). |

---

## 6. Core disciplines

**Durable task state.** A `TaskState` records the interpretation, acceptance
criteria, work done/remaining, files touched, decisions, risks, and next action.

**Evidence with stable references.** Observations are stored as artifacts
(`art-…`) and evidence entries (`evidence:<task>:<n>`). These stable refs are how
exact output is recovered later — nothing the agent relies on is unrecoverable.

**Belief tracking.** Hypotheses and claims carry a status and confidence;
confidence updates are *deterministic* from evidence. Contradictions and stale
claims are detected explicitly.

**Verification gating.** Completion is blocked until high/critical-risk claims are
verified (or explicitly routed to human review); stale/contradicted claims block
until resolved. Scoring of what to verify next is deterministic.

**Trace.** Every file read/edit, command, tool call, state transition, and
verification result is recorded for audit and resumption.

**Local-model layer (non-authoritative).** Bounded sub-tasks (compaction,
triage, extraction, ranking, embeddings) can be delegated to cheap local models.
Results are never the source of truth, always carry stable refs back to the exact
input, and degrade to deterministic fallbacks. Full design: [local-model.md](./local-model.md).

---

## 7. The run lifecycle

1. **Interpret** the request into acceptance criteria.
2. **Map & localize** using the repo graph and semantic capabilities.
3. **Hypothesize → probe** to gather evidence (belief graph updated).
4. **Implement** behind a checkpoint, recording diffs as evidence.
5. **Verify** — run the highest-value checks; update claim status.
6. **Gate** — refuse to complete until verification discipline is satisfied.
7. **Deliver** — branch, commit, and a structured PR body.

State is written continuously, so any step is **resumable** after a crash or
context reset.

---

## 8. Testing & development

```bash
pnpm build       # build all packages (tsc)
pnpm typecheck   # type-check all packages
pnpm test        # vitest (DB-backed suites auto-skip without FORGE_DATABASE_URL)
pnpm doctor      # environment / DB / provider reachability
```

Tests live in the root `tests/` directory; DB-dependent suites use
`describe.skipIf(!HAS_DB)`. Migrations are immutable and idempotent.
