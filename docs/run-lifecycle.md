# Run Lifecycle

Forge runs are designed for long-horizon work. The lifecycle is preflight, execution, verification, pause/resume, and delivery.

## 1. Preflight

`forge run` and `forge resume` run preflight before the agent starts.

Preflight checks:

- state mode
- Postgres connection
- schema version
- project state directory
- local model availability
- configured budget

Normal mode requires Postgres. If Postgres is missing, Forge stops and explains how to fix it.

The explicit fallback is:

```bash
forge run --state-mode=file --allow-no-local "task"
```

## 2. Local Model Check

Forge probes the local-model layer with a small summarize/embed smoke test.

If Ollama or another local provider is unavailable:

- normal correctness is not affected
- deterministic fallback compaction can be used
- long autonomous runs require explicit `--allow-no-local`

Local models are never authoritative for verification or approval.

## 3. Long-Horizon Budget

Default budget:

```text
wall clock: 8 hours
iterations: 10000 emergency ceiling
```

The iteration ceiling prevents runaway loops. It should not be hit in ordinary use.

If the budget is exhausted, Forge returns `paused`, writes durable state, and can continue later.

## 4. Repo Intelligence

Before editing, Forge scans the current work directory.

It builds:

- repo map
- repo graph
- domain selection
- risk assessment
- bounded context
- semantic capability fabric

## 5. Acceptance Contract

Forge converts the task into checkable criteria and persists them.

The agent should not claim completion until criteria are verified or explicitly marked as needing human review.

## 6. Stage Machine

The agent loop moves through:

```text
LOCALIZE -> PROBE -> EDIT -> VERIFY -> REPAIR -> FINALIZE
```

The exact path is data-driven. Failed verification should lead to repair, not premature completion.

## 7. Evidence and Trace

During the run, Forge records:

- tool calls
- command outputs
- files touched
- evidence entries
- failures
- decisions
- checkpoints
- verification results
- trace events

Large output is stored as artifacts and referenced by stable id.

## 8. Human Decisions

Forge should ask humans only when needed:

- destructive shell commands
- irreversible external actions
- high-risk security/product/migration choices
- missing mandatory infrastructure

Scope-down questions should not stop a run when there is a safe recommended default. Forge records the decision and continues.

## 9. Pause and Resume

Paused or blocked tasks are meant to be continued interactively through the TUI.

CLI fallback:

```bash
forge resume <taskId>
```

Resume loads task state from Postgres through the Context Server. It does not depend on the previous chat transcript.

## 10. Delivery

A complete run should produce:

- branch
- commit
- PR body or PR link
- verification summary
- evidence summary
- risk notes
- failure/recovery notes
- human-review items

If verification is incomplete, Forge should say so and leave the task paused or needing human review.
