# Forge

**A long-horizon coding agent that turns a real engineering task into a verified, reviewable pull request — through a better harness, not just another chat-with-tools agent.**

Forge's edge is the *harness*: a repo-aware **semantic MCP fabric**, durable task state, evidence tracking, a risk model, and verification gates that are first-class parts of the system. The same model, on the same repo and task, gets better engineering outcomes because it operates *through* a mapped software system instead of a flat filesystem and a pile of tools.

> **Same model. Same repo. Same task. Better harness. Better engineering outcomes.**

See [`AGENTS.md`](./AGENTS.md) for the full product thesis, and [`docs/semantic-mcp-fabric.md`](./docs/semantic-mcp-fabric.md) for how the capability fabric works and how to extend it.

> **Status: working harness, honest about limits.** Forge is an actively developed engineering agent, not a research demo. Its core thesis — that externalizing state and offloading cheap cognition to local models beats stuffing everything into the model's context — is backed by head-to-head benchmark evidence (see [Benchmarks](#benchmarks)). Quality on the benchmark tasks is currently a *tie* with a strong flat harness at equal token cost; Forge's measured advantages are token efficiency (~2.2× fewer main-model tokens) and steadier reliability. Design quality is a known gap. Numbers below are reported honestly, including where Forge only ties or where results are still landing.

---

## What makes Forge different

Most coding agents hand the model a flat filesystem and a pile of `read_file` /
`write_file` / `run_command` tools. Forge instead operates the repository as a
mapped software system, exposed to the agent through a semantic capability fabric:

- **Repo map & repository graph** — packages, routes, services, DB schema,
  migrations, test suites, and a symbol/call/import graph.
- **Semantic MCP fabric** — domain-routed, repo-aware capabilities
  (`repo.find_callers`, `repo.find_definitions`, `repo.explain_dependency_path`,
  `db.get_table_schema`, `tests.find_related_tests`, …) for discovery and
  localization, instead of grepping blind. **You can add your own domains and
  capabilities** — see [`docs/semantic-mcp-fabric.md`](./docs/semantic-mcp-fabric.md).
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

## Try it on a real repo

Before anything else, point Forge at a repo you actually care about:

```bash
# 1) Build Forge once, from its checkout:
git clone https://github.com/coenhewes/Forge-coding.git && cd Forge-coding
pnpm install && pnpm build
node packages/forge-cli/dist/cli.js setup   # pick a provider + add an API key

# 2) Point it at a real repo (any git repo on your machine):
cd /path/to/your-repo
node /path/to/Forge-coding/packages/forge-cli/dist/cli.js run \
  "Add pagination to the users list endpoint"
```

Forge runs against the repo in your current directory, branches, implements,
verifies, and drafts a PR (written to `.forge/tasks/<id>/PR.md` by default, or
opened via `gh` if you set `git.pr: "gh"`).

`git.pr` can be `"file"` (write the PR body to `.forge/tasks/<id>/PR.md`),
`"gh"` (open a real PR via the `gh` CLI), or `"off"`. See
[Configuration](#configuration-forgeconfigjson) below.

> Forge is strongest on **multi-file, multi-domain, verification-heavy** tasks
> (auth changes, billing swaps, migrations, "implement this feature end to end").
> It is not built to win at one-shot autocomplete.

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
`anthropic`, `openai`, `openrouter`, `ollama`, `ollama-cloud`, `minimax`, `nous`.

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

### Observability

Forge records what it did and why, so a PR is reviewable after the fact:

- `forge evidence <taskId>` — the evidence, failure, and decision ledgers
  (what was tried, what failed, what was recovered, what was decided).
- `forge trace` / the flight recorder — a step-by-step trace of work performed.
- Slash commands in the REPL: `/verify`, `/failures`, `/trace`, `/pr`, `/doctor`,
  `/sessions`, `/mode`, `/budget`, `/compact`.

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

## Benchmarks

Forge is measured **head-to-head against [opencode](https://github.com/sst/opencode)** on the
**same model** (MiniMax-M3), the **same hardware**, and the **same task** — so any difference is the
*harness*, not the model. Runs are graded by a blind acceptance suite and averaged over multiple
runs to absorb model variance. Both agents get the same credentials up front; "did it ask for keys"
is never a graded difference.

### Long-horizon SaaS build (`_bench/longhorizon`, `_bench/longhorizon2`)

From a blank repo and one prompt, each agent must build a complete, working, well-designed SaaS. The
grader scores three independent dimensions: **Works** (real browser flows via Playwright),
**Complete** (exact REST contract + a real Stripe test-mode signed webhook), and **Designed**
(screenshots rated 0–10 by a local vision model).

**TaskFlow** (auth, projects, tasks, billing) — 3 runs each, reported honestly:

| | Checks | Design (0–10) | Main-model tokens | Reliability |
|---|--------|---------------|-------------------|-------------|
| **Forge**    | 38/38 (all runs)   | ~5.5 avg | **~163K avg** | 0 hangs / 3 |
| **opencode** | 38/38 (clean runs) | ~5.0 avg | ~359K avg | 1 hang / 3 (thrashed to 2.9M tokens) |

Honest read: **output quality is a tie** — both pass every check. Forge's measured edge is **~2.2×
fewer main-model tokens at equal quality** (it feeds the model far less context per call) plus
steadier reliability. Design is a wash and below bar for both — a known gap.

**Forgeflow** (orgs/RBAC, seat-based billing the agent provisions *itself* via the Stripe API, API
tokens + rate limiting, outgoing webhooks, audit log) is a deliberately larger task — too big for one
model session — to test whether Forge's durable state + verification loop sustains where a single-pass
agent degrades. *This benchmark is in progress; results will be published here when complete, including
if they tie.*

```bash
# blank repo → agent builds → blind grader → result JSON
node _bench/longhorizon/longhorizon-runner.mjs --agent forge
node _bench/longhorizon/longhorizon-runner.mjs --agent opencode
```

### Golden gauntlet (`_bench/golden`)

Reproduces a **real merged upstream fixing PR**, gives both agents the identical fix-free task on the
same model, and gates on the PR's **golden test + full suite green** (a no-op or a weakened test
cannot pass). Scored on pass-rate and median main-model tokens, averaged over runs.

```bash
node _bench/golden/golden-gauntlet.mjs --case GL02 --runs 3        # both agents, 3 runs each
node _bench/golden/golden-gauntlet.mjs --case GL02 --prep-only     # validate a case reproduces
```

### Harness ablation (dev tool)

For local development, `forge-eval` runs the same task with the harness on vs. a flat baseline to
inspect which components move which metrics — useful for development, not the headline comparison:

```bash
pnpm build
MINIMAX_API_KEY=... node packages/forge-eval/dist/cli.js demo
```

All benchmarks require Postgres (`:54329`) + Ollama (`qwen2.5-coder:14b`, `nomic-embed-text`,
`llama3.2-vision`) running, with MiniMax and opencode configured. See `AGENTS.md` for full
methodology and the harness-vs-opencode analysis.

---

## Where Forge is headed

The core stays open-source and MIT. The near-term product direction builds on
what the harness already does:

- **Hosted runner** — run Forge on your repo without standing up Postgres/Ollama;
  managed state, secrets, compute, and long-running tasks. Your token efficiency
  is the margin advantage.
- **Team features** — shared task state, approval gates driven by the risk model,
  audit trails from the ledgers, and Slack/Linear notifications.
- **GitHub App** — open PRs on demand or from issues/comments.
- **Capability packs** — first-party and community domains/capabilities for specific
  stacks (see [`docs/semantic-mcp-fabric.md`](./docs/semantic-mcp-fabric.md)).

Local CLI use stays free; the hosted runner and team features are where the
product is monetized.

---

## Development

```bash
pnpm build       # build all packages (tsc, project references)
pnpm typecheck   # strict typecheck
pnpm test        # vitest unit/integration tests
```

## License

[MIT](./LICENSE) © 2026 Coen Hewes.

Forge orchestrates third-party models and tools (MiniMax, Ollama models, opencode for benchmarking);
their respective licenses and terms apply to their use. See [`NOTICE`](./NOTICE) for attributions.
