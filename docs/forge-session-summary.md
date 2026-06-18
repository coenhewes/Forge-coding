# Forge — Session Build Summary & Architecture

_Long-horizon coding agent. Driver model for runs: MiniMax **M3**; local tier: Ollama
(`qwen2.5-coder:14b` instruct, `nomic-embed-text` embeddings)._

## 1. What this session delivered

### A. Local-model layer (`@forge/local-model`) — new package
A **non-authoritative** accelerator that offloads bounded sub-tasks to cheap local
models so the frontier model isn't re-sent large payloads.
- **Task kinds:** `summarize` (compaction), `classify` (triage), `extract`,
  `rerank`, `embed`.
- **Pieces:** `router.ts` (enablement: `auto|on|off`, probes Ollama once; maps each
  task kind to a provider via `selectProvider`), `service.ts` (per-task methods,
  artifact/run/trace sinks, deterministic fallbacks, never throws), `compaction.ts`
  (threshold-triggered `summary + stable ref`), `similarity.ts` (cosine),
  `prompts.ts`, `parse.ts` (tolerant parsing + fallbacks).
- **Invariants:** every result is `authoritative: false`; exact inputs/outputs are
  persisted as artifacts with **stable refs**; degrades to deterministic fallback if
  the local model is unavailable. Never gates completion, never the source of truth.
- **Provider:** added `embed()` to Ollama provider + `createEmbeddingProvider`.
- **Persistence:** migration **v4** — `local_model_runs` (provenance: kind, model,
  input/output artifact ids, latency, tokens, fallback flag) + `embeddings`
  (jsonb vectors, no pgvector dependency).
- **CLI:** `forge local status` / `forge local test`.
- **Docs/attribution:** `docs/local-model.md`, `NOTICE` (opencode MIT).

### B. Docs site (offline)
- `docs/index.md` (whole-app docs) + `docs/serve.mjs` (zero-dep Node server that
  renders the repo's Markdown to styled HTML, works offline). `pnpm docs`.

### C. Global CLI (Claude-Code-style)
- `forge` is globally linked (`npm link`) → run `forge` from any project directory.
  `pnpm link:global` / `pnpm unlink:global`. Fixed `providers` command not being
  routed in the CLI dispatch.

### D. Robustness fixes that unblocked multi-step autonomous runs
These were the real blockers — found by actually running the agent against sandboxes:
1. **Completion gate enforced.** `evaluateCompletion` (gating.ts) now requires
   acceptance criteria verified; `finish_task('completed')` is rejected until then;
   the loop no longer fakes "completed" when the model goes quiet.
2. **Postgres trace crash fixed.** `tx.trace` backfills `repo_id` from the task row
   (was `null` → NOT-NULL violation killing runs).
3. **Task-derived acceptance criteria.** Replaced generic frontend boilerplate with
   concise, verifiable, task-grounded criteria.
4. **Embeddings work** (`nomic-embed-text`, 768-dim, real not fallback).
5. **Permissions overhaul.** Default-deny blocked `edit_file`/state tools/capabilities.
   Now: safe state tools + read-only capability tools (`repo.*`, `tests.*`) + in-repo
   writes allowed; path traversal denied; **explicit deny always wins** over allows.
6. **Stage machine reaches EDIT** for plain implement tasks (no hypothesis needed) —
   was looping PROBE↔REPAIR forever and never editing.
7. **Provider message hygiene** (`mapAnthropicMessages`): drop inline system turns,
   merge same-role turns, and **remove orphan `tool_use`/`tool_result` pairs** — the
   orphan pairs (left by compaction) were causing recurring opaque **HTTP 400s** from
   MiniMax. This was the last blocker for multi-step runs.
8. **Tool-arg JSON never throws** (`safeParseToolInput` with truncation repair) —
   truncated tool args from `max_tokens` no longer crash the run.
9. **`runCompletion` resilience** — retries, degrades to a corrective nudge, compacts
   history on repeated errors; `maxTokens` default raised to 8192.
10. **System prompt is now opencode-style todo-driven** (`context-builder.ts`):
    explicit plan→implement→verify→mark-done loop, persistence ("keep going until
    verified"), and output-size guidance ("write files one at a time").
11. Wired `localModel` into the CLI `run` path.

**Result:** from a blank directory, Forge + MiniMax M3 now builds a SaaS landing page
end-to-end (git init → write `index.html` → verify → acceptance verified →
`completed`) with **0 errors**. All **262 tests pass**.

## 2. Architecture (the unification thesis)

Four pillars should form **one durable execution spine**, not four side-cars:

```
            ┌──────────── DURABLE STATE (Postgres / file) ────────────┐
            │  task · acceptance · belief · evidence · trace · runs    │  ← source of truth
            └───────────▲──────────────────────────────▲──────────────┘
                        │ read slices                   │ write receipts
  SMART SEARCH ─feeds─► BELIEF / GATE ─decides─► AGENT LOOP (todo-driven)
  (repo-graph,          (criteria+evidence =      every step: read state →
   capabilities,         the ONE "done" signal)   act → write state → trace
   embeddings)                  ▲                          │
                                │ low-conf signals         ▼
                       LOCAL MODELS (non-authoritative): compaction·triage·rerank·embed
```

### Packages
`forge-types` (shared types) · `forge-provider` (Anthropic/OpenAI/OpenRouter/MiniMax/
Ollama + cost-tier router) · `forge-local-model` (this session) · `forge-state` +
`forge-state-store` (durable task/evidence/acceptance + migrations) · `forge-belief`
(hypotheses/claims/probes) · `forge-verification` + `forge-verification-planner`
(matrix, evidence-value scoring, completion gating) · `forge-repo-graph` /
`forge-repo-intel` (smart search) · `forge-context-server` (permissioned typed state
access) · `forge-trace` · `forge-harness` · `forge-integrations` (MCP/capabilities) ·
`forge-pr` · `forge-agent` (the loop) · `forge-cli` · `forge-tui` (12 read-only
panels, blessed) · `forge-eval`.

## 3. North star & current plan

**Goal:** unattended **multi-hour** autonomy that drops into any repo, decomposes a big
task (e.g. a production SaaS), implements it, **fixes its own mistakes**, keeps context
across resets/restarts, and stops only when **verifiably done** — better than any other
agent. (A one-shot page is not the bar.)

**Approved next increment — the "autonomy spine":**
1. **Unified done-gate** — acceptance criteria carry `requiredChecks`; `verified`
   requires real passing-check evidence (tests + typecheck + build + app-boots), not
   the model's say-so. Collapse the three "done" trackers into one.
2. **Real hierarchical decomposition** — model plans many durable verifiable criteria
   and re-plans as it learns (`add_acceptance_criterion`).
3. **State-backed context** — each turn's context is rebuilt from Postgres (situation
   report + recent window), not a growing transcript (AGENTS.md: "never rely purely on
   a long chat transcript").
4. **Budget-bounded, resumable loop** — run to a wall-clock/iteration/cost budget;
   auto-checkpoint, pause for human only on irreversible/ambiguous; resume after restart.
5. **Verification bar** — detect project commands; `run_verification` records per-check
   evidence; "boot" = start app with timeout.
6. **Live run TUI** — wire the existing 12 panels + event stream into a `forge run`
   dashboard with opencode UX patterns (Braille spinner, three-state tool rendering,
   acceptance-progress bar, footer status line).

**Validation target:** a new `sandbox/api-demo` (Express + SQLite todo API with a
deliberately failing test) — Forge must decompose, implement across files, run checks,
**see the failure, fix it, re-verify**, and complete only on passing evidence.

## 4. opencode lessons (cloned, MIT)
- Biggest lesson = the **relentless todo-driven loop** + tight tool descriptions, not
  the tools themselves. Forge already has equivalents for read/write/edit/grep/glob/
  run/question.
- Tool gaps worth adopting later: `todowrite` (replace add/complete_subtask),
  `apply_patch`, `webfetch`/`websearch`, `lsp` diagnostics.
- opencode TUI = Solid.js + OpenTUI; we **port patterns, not the stack** (Forge stays
  on blessed).

## 5. Sandboxes
- `sandbox/forge-demo` — slugify task (file-mode, completes, tests pass).
- `sandbox/saas-demo` — blank-dir SaaS landing page (completes end-to-end).
- `sandbox/api-demo` — planned multi-feature verification target.
