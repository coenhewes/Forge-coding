# Feature Guide

Forge is a coding agent plus a long-horizon engineering harness. This page documents the major product features.

## Postgres Durable State

Postgres is the primary state store for normal runs.

It stores:

- tasks and task snapshots
- sessions and prompt records
- acceptance criteria
- repo map and graph metadata
- hypotheses, claims, assumptions, contradictions
- evidence and artifact metadata
- failures and decisions
- verification matrix and verification actions
- patch candidates and checkpoints
- trace events

JSON file state is retained only for import/export and degraded fallback.

See [Postgres state](./postgres-state.md).

## Context Server

The model does not query Postgres directly. It receives compact typed state through the Forge Context Server.

Important read capabilities:

- `task.resume`
- `task.get_current_state`
- `belief.get_top_hypotheses`
- `belief.get_open_uncertainties`
- `evidence.get_for_claim`
- `failure.get_disproven_paths`
- `decision.get_relevant_decisions`
- `verification.get_open_matrix`
- `trace.get_recent_events`

Important write capabilities:

- `task.record_snapshot`
- `evidence.record`
- `failure.record`
- `decision.record`
- `verification.record_check`
- `patch.record_candidate`
- `trace.record_event`

Every important write should have a trace event.

## Long-Horizon Run Budget

Normal runs default to:

- 8 hours wall clock
- 10000 emergency iterations

The iteration ceiling is a safety valve, not a product-level task limit. If budget is exhausted, Forge pauses with durable state and can continue later.

## Preflight

Before a run or resume, Forge checks:

- Postgres connection and schema
- project-local state path
- provider configuration
- local model availability
- selected state mode
- run budget

Missing Postgres blocks normal runs. `--state-mode=file` is the explicit degraded fallback.

Missing local models warn and require `--allow-no-local` for long autonomous runs.

Live trial findings are tracked in [the trial log](./trial-log.md). The current quality loop uses agent-accessible stdio tools as test targets so Codex and other agents can verify behavior directly.

## Repo Intelligence

Forge maps a repository before editing.

Repo intelligence tracks:

- packages and apps
- routes and entrypoints
- test commands
- database schema and migrations
- ownership and domain boundaries
- risk areas
- build and typecheck surfaces

This lets the agent act on a software system rather than a flat filesystem.

## Repository Graph

The graph layer represents:

- imports and exports
- symbol definitions and references
- call sites
- routes and components
- package dependencies
- test relationships
- cross-domain edges

The graph supports localization, affected-test selection, verification planning, and review guidance.

## Semantic Domains and Capabilities

Forge routes tasks into engineering domains such as:

- frontend
- backend
- auth
- billing
- database
- tests
- infra
- security

Domains define owned paths, allowed reads, allowed writes, related domains, risks, and verification expectations.

Semantic capabilities give the model engineering-native actions such as:

- `repo.find_definitions`
- `repo.find_callers`
- `auth.trace_permission_check`
- `db.find_migrations_touching_table`
- `tests.find_related_tests`
- `frontend.find_route_component`

## Acceptance Contract

Forge turns vague requests into checkable criteria. Completion is not allowed until the acceptance contract is satisfied or explicitly routed to human review.

Example criteria:

- admin can invite a user
- non-admin cannot invite users
- expired invite cannot be accepted
- migration applies cleanly
- relevant tests pass
- PR includes review guidance

## Belief Graph

The belief graph tracks what Forge currently thinks is true.

It stores:

- top hypotheses
- claim confidence
- supporting evidence
- contradicting evidence
- assumptions
- open uncertainty
- suggested probes

This prevents stale assumptions and repeated failed paths from surviving across long runs.

## Evidence Ledger

Forge records exact evidence instead of relying on model memory.

Evidence can come from:

- file reads
- command output
- tests
- typechecks
- screenshots
- diffs
- CI logs
- human decisions

Large raw outputs are stored as artifacts with stable references.

## Failure Ledger

Forge records failed attempts and lessons learned.

This includes:

- failed commands
- failed tests
- rejected patch candidates
- disproven hypotheses
- bad assumptions
- repair notes

The resume context uses these records to avoid repeating mistakes.

## Decision Ledger

Forge records architecture, product, security, migration, and human decisions.

Human decisions should not be re-litigated unless new evidence changes the situation.

## Checkpointed Patch Search

Forge can preserve multiple patch candidates and promote only the verified one.

Patch candidates track:

- hypothesis
- changed files
- diff artifact
- verification status
- failure reason
- promotion decision

This is central to recovery on hard tasks.

## Active Verification Planner

Verification is claim-driven. Forge selects checks based on expected evidence value, risk, affected areas, and confidence gaps.

Checks can include:

- unit tests
- typecheck
- build
- migration checks
- API probes
- visual checks
- security checks
- human review

High-risk claims require stronger evidence or explicit human review.

## Local Model Layer

Local models are non-authoritative accelerators.

They can help with:

- summarization
- classification
- extraction
- reranking
- embeddings
- context compaction

They never approve changes, verify claims, or replace durable evidence.

See [Local-model layer](./local-model.md).

## TUI Workbench

The TUI is the primary surface for long-horizon inspection and continuation.

It shows:

- task goal and status
- open questions
- evidence
- failures
- decisions
- verification
- checkpoints
- trace
- resume readiness

Paused and blocked tasks should be continued interactively, not by copying a resume command from output.

## PR and Review Output

The final PR should include:

- summary
- motivation
- implementation notes
- acceptance criteria
- verification summary
- risk areas
- known limitations
- screenshots if relevant
- migration notes
- human-review items
- review guidance

The reviewer should be able to understand both the code change and the evidence behind it.
