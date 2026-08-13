# Forge Documentation

Forge is a long-horizon software-engineering agent. It turns a real task into a verified, reviewable pull request by combining a coding agent with a durable engineering harness.

The product bet is simple:

```text
Same model.
Same repo.
Same task.
Better harness.
Better engineering outcomes.
```

## Start Here

- [Quick start](./quick-start.md) gets a local Forge run ready.
- [Feature guide](./features.md) documents each major Forge capability.
- [Postgres state](./postgres-state.md) explains the durable memory model.
- [Run lifecycle](./run-lifecycle.md) describes preflight, execution, pause, and resume.
- [Local-model layer](./local-model.md) covers the non-authoritative local accelerator.
- [Live trial log](./trial-log.md) records the MiniMax/Ollama long-horizon run and findings.
- [Operating notes](./OPERATING_NOTES.md) has repo-specific commands and ports.

## Business & Monetization

- [Monetization strategy](./MONETIZATION.md) sets the money model and sequencing.
- [Getting Paid](./GETTING-PAID.md) is the concrete, build-order action list (free CLI → hosted runner → Team/Enterprise).
- [Build your own domain capability](./MCP-DOMAIN-HOWTO.md) explains the domain/risk fabric the Team/Enterprise layer is built on.

## What Forge Produces

A successful Forge task should leave behind:

- a working branch and commit
- a PR body or PR link
- a task state dashboard
- an acceptance contract
- a verification matrix
- an evidence ledger
- a failure ledger
- a decision ledger
- a checkpoint history
- a trace of work performed
- a reviewer-oriented summary of risks and proof

Forge should not finish by saying only "here is some code." It should finish by showing what changed, why it changed, how it was verified, what failed along the way, and what still needs human review.

## Current Default Contract

Forge is Postgres-first. Normal `forge run` and `forge resume` require a reachable `FORGE_DATABASE_URL`. The JSON files under `.forge/` are retained as import/export and emergency fallback shims, but serious long-horizon execution uses the typed Postgres state store.

Long runs default to an 8 hour wall-clock budget and a high emergency iteration ceiling. If the budget is reached, the task is paused with durable state instead of being marked blocked.

Local models are optional accelerators. If they are unavailable, Forge warns before a long run and requires explicit approval to continue with deterministic fallbacks.

## Package Map

| Package | Role |
|---|---|
| `@forge/agent` | Long-horizon agent loop and stage machine |
| `@forge/cli` | `forge` command, preflight, run/resume/status surfaces |
| `@forge/state-store` | Postgres durable state store and migrations |
| `@forge/context-server` | Typed model-facing access to durable state |
| `@forge/state` | File-state compatibility engines and lightweight ledgers |
| `@forge/belief` | Hypotheses, claims, contradictions, and probe planning |
| `@forge/verification` | Checkpoints, affected tests, verification matrix |
| `@forge/verification-planner` | Claim-driven active verification planning |
| `@forge/local-model` | Local summarize/classify/extract/rerank/embed helpers |
| `@forge/repo-intel` / `@forge/repo-graph` | Repo mapping and graph context |
| `@forge/tui` | Interactive terminal workbench |
| `@forge/pr` | Git and PR summary generation |

## Development Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm docs
```

The docs site is local-only and served by `docs/serve.mjs`.
