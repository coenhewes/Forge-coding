# Forge — Long-Horizon Autonomy Spine

The mechanisms that let Forge run unattended on a large task, decompose it,
self-correct, keep context across a long run, and stop only when the work is
**verifiably** done. Aligns with AGENTS.md: *"treat verified acceptance criteria
as completion"* and *"never rely purely on a long chat transcript."*

## 1. Evidence-backed done-gate
"Done" is a verified acceptance criterion — not the model's say-so.

- Each `AcceptanceCriterion` carries `requiredChecks: ('test'|'typecheck'|'build'|'boot'|'e2e')[]`.
- `update_acceptance("verified")` is **rejected** unless those checks have recently
  **passed** via `run_verification` (`packages/forge-agent/src/tools.ts`).
- `finish_task("completed")` is rejected until **all** criteria are verified.
- The single gate lives in `evaluateCompletion` (`forge-verification-planner/src/gating.ts`),
  wired through `refreshBeliefSnapshot` in the agent loop.

## 2. Verification bar (`verification-bar.ts`)
Auto-detects the project's checks and runs them, recording per-check evidence:

| Check | How it's detected | Pass condition |
|---|---|---|
| `test` | `scripts.test` | command exits 0 |
| `typecheck` | `scripts.typecheck` or a `tsconfig.json` (`tsc --noEmit`) | exits 0 |
| `build` | `scripts.build` | exits 0 |
| `boot` | `scripts.start`/`dev`/`serve` | server stays up / prints readiness, no crash |

The model calls `run_verification` (optionally a subset); results become the
evidence the done-gate checks.

## 3. Decomposition
- `add_acceptance_criterion` lets the agent break a big task into many concrete,
  checkable criteria (with `required_checks`) — persisted durably.
- The system prompt is todo-driven: plan criteria → implement → `run_verification`
  → verify → finish.

## 4. State-backed context (no growing transcript)
Each turn the model sees: the original task + a **SITUATION REPORT regenerated
from durable state** (criteria & check status, open subtasks, recent evidence
*refs*, failures-not-to-repeat, files touched) + only the last ~14 raw turns.
Built by `buildSituationReport()` in `agent-loop.ts`. This bounds context
regardless of run length and makes runs resumable — Postgres/state is the memory,
not the chat log.

## 5. Budget-bounded, resumable loop
- `AgentConfig.budget = { maxWallClockMs?, maxIterations? }`.
- The loop runs until **done**, **blocked** (human needed), or **budget exhausted**
  — then returns a resumable `paused` status.
- CLI: `forge run "<task>" --hours 8` or `--max-iterations 400`; `forge resume <id>`
  reconstructs from durable state and continues.

## 6. Live run UX
`forge run` streams a live, opencode-inspired view (stage headers, three-state
tool lines, errors) to stderr — no longer silent until the end
(`forge-cli/src/commands/run-renderer.ts`). `--json` keeps stdout clean.

## Running a long autonomous task
```bash
cd ~/my-project
forge init                       # once
forge run "build X; tests, typecheck, build, and boot must pass" --hours 4
# ...watch the live stream; if it pauses at budget:
forge resume <taskId>
```

## Validated
`sandbox/api-demo` (dependency-free todo store + HTTP API, multi-file, real test
suite, boot check): MiniMax M3 decomposes into criteria, implements store+server,
runs `run_verification`, and completes only after `test`+`build`+`boot` pass — the
gate forces real evidence (it rejected a `run_tests`-only verify attempt).

## Still ahead (next increments)
Deeper self-correction (checkpoint/rollback + multi-candidate patch search),
E2E/browser verification, review-comment loop, full live panel dashboard.
