# Feature Request: Forge State Store and Context Server

## One-sentence summary

Add a Postgres-backed Forge State Store and typed Forge Context Server so Forge can run long-horizon coding sessions without relying on model context as memory.

## Product name

Internal name: **Forge State Store**

Model-facing layer: **Forge Context Server**

Product-facing language: **Durable Task Memory**

## Core thesis

Forge should not remember long tasks by keeping everything in the model context.

Forge should remember long tasks through a durable local Postgres state store, then give the model the right slice of task state, repo state, evidence, decisions, failures, and verification status at the right time.

The model context should be a working set. The Forge State Store should be the source of truth.

## Strategic importance

This is foundational infrastructure for Forge.

Long-horizon software-engineering work can span hours, many tool calls, many files, multiple failed attempts, branch changes, test runs, review comments, CI failures, and human interruptions. A model context window is the wrong durability layer for that work.

Forge already depends on durable task state, evidence memory, failure reflection, checkpointed patch search, verification gates, and reviewable PR output. The Forge State Store is the persistence substrate that makes those systems real, inspectable, resumable, and safe over long sessions.

This should not be treated as a memory add-on. It should be treated as Forge’s local operating state.

## Decision

Forge will use **Postgres from day one**.

There will be no SQLite mode, no lightweight fallback, and no prompt-history-based memory mode for serious task execution.

Forge State Store should support:

* local Postgres for local development and single-user runs
* managed Postgres for hosted or team deployments
* the same schema and state model across local and cloud modes
* durable task recovery after model reset, process restart, terminal crash, or machine interruption

## Goals

1. Store all long-horizon task state outside model context.
2. Let Forge resume a task after context reset, process restart, crash, interruption, branch switch, review loop, or CI failure.
3. Preserve exact evidence, not only summaries.
4. Give the model compact, typed, relevant context slices on demand.
5. Prevent the model from querying raw SQL directly.
6. Support the Active Repo Belief Graph, evidence ledger, failure ledger, decision ledger, verification matrix, patch candidates, and PR state.
7. Make all important task state inspectable in the TUI.
8. Provide a durable event log for traceability, auditability, and debugging.
9. Support multi-agent and subagent workflows without state races.
10. Allow task state to compound across long-running engineering work.

## Non-goals

This feature is not:

* a chat transcript database
* a generic vector memory layer
* raw SQL exposed to the model
* an optional developer convenience
* a cache that can be safely discarded
* a replacement for exact artifacts
* a replacement for the repository graph
* a replacement for the evidence ledger
* a replacement for Git

The Forge State Store is the durable state substrate for the Forge harness.

## Architecture overview

```text
Forge Agent
  |
  | typed context requests
  v
Forge Context Server
  |
  | permissioned queries and writes
  v
Forge State Store, Postgres
  |
  | artifact refs
  v
Forge Artifact Store, local filesystem or object storage
```

The model never talks directly to Postgres.

The model talks to the Forge Context Server through typed capabilities such as:

```text
task.get_current_state
task.get_next_action
belief.get_top_hypotheses
belief.get_open_uncertainties
evidence.get_for_claim
evidence.get_exact_artifact
failure.get_disproven_paths
decision.get_relevant_decisions
repo.get_related_graph_region
tests.get_affected_tests
verification.get_open_matrix
pr.get_review_guidance
trace.get_recent_events
```

The Context Server queries Postgres, assembles a compact response, applies permissions and relevance filters, and returns only the state the model needs for the current step.

## Core design principle

Do not use the database as a place to dump everything and retrieve it with semantic search.

Use Postgres as a typed engineering state system.

Bad pattern:

```text
store every message
retrieve large memory chunks
stuff them into prompt
hope the model remembers correctly
```

Forge pattern:

```text
store typed task objects
store exact evidence references
store hypotheses, decisions, failures, claims, checks, patches, and trace events
retrieve only the relevant state slice through typed capabilities
write every important observation back into durable state
```

## State tiers

### Tier 1: Hot context

Lives in the model prompt.

Contains:

* current task goal
* acceptance contract summary
* current top hypotheses
* active files
* next action
* open risks
* current verification blockers
* relevant failure warnings
* recent trace summary

This should be small and replaceable.

### Tier 2: Warm durable state

Lives in Postgres.

Contains:

* task state
* repo graph
* domain map
* active belief graph
* hypotheses
* claims
* evidence metadata
* failure ledger
* decision ledger
* verification matrix
* patch candidates
* checkpoints
* command runs
* test results
* trace events
* PR state
* review comments
* human decisions

This is the main source of truth.

### Tier 3: Cold exact artifacts

Lives in the artifact store.

Contains:

* full command logs
* full diffs
* patches
* screenshots
* test outputs
* coverage reports
* CI logs
* raw review threads
* full terminal captures
* structured build artifacts

Postgres stores metadata and references. Exact artifacts stay recoverable by stable artifact ID.

## Core data domains

Forge State Store should include the following durable domains.

### 1. Task state

Stores:

* original user request
* interpreted task
* acceptance contract
* assumptions
* open questions
* subtasks
* completed work
* remaining work
* current mode
* current status
* active branch
* current patch candidate
* next action
* resume summary

### 2. Repo state

Stores:

* files
* packages
* apps
* routes
* symbols
* dependencies
* tests
* build targets
* database tables
* migrations
* ownership
* domains
* risk areas
* known flaky tests
* relevant git history

### 3. Active Repo Belief Graph

Stores:

* hypotheses
* beliefs
* confidence
* evidence links
* contradiction links
* assumptions
* invalidations
* open uncertainties
* candidate probes
* task-local graph regions
* domain confidence
* verification implications

### 4. Evidence ledger

Stores:

* evidence records
* exact artifact references
* command outputs
* test results
* screenshots
* logs
* diffs
* runtime observations
* human decisions
* review comments
* claim support links

### 5. Failure ledger

Stores:

* failed hypotheses
* failed patches
* failed commands
* failed tests
* dead ends
* bad assumptions
* reverted changes
* lessons learned
* conditions under which the failed path could become viable again

### 6. Decision ledger

Stores:

* architecture decisions
* product decisions
* security-sensitive decisions
* migration decisions
* rejected alternatives
* rationale
* human approvals
* verification obligations created by decisions

### 7. Verification matrix

Stores:

* acceptance criteria
* verification checks
* check status
* command runs
* test suites
* skipped checks
* blocked checks
* checks needing human review
* evidence per claim
* stale verification after code changes

### 8. Patch candidates and checkpoints

Stores:

* patch candidates
* checkpoint IDs
* base commit
* diff references
* changed files
* hypothesis behind the patch
* verification status
* promotion decision
* rollback state
* failed candidate reasons

### 9. Trace and observability

Stores:

* state transitions
* tool calls
* capability calls
* files read
* files edited
* commands run
* domains selected
* domains expanded
* graph regions inspected
* tests selected
* tests run
* failures observed
* patch candidates created
* patch candidates promoted or rejected
* context slices served to model
* cost and runtime events

## Postgres schema outline

### tasks

```sql
create table tasks (
  id uuid primary key,
  repo_id uuid not null,
  title text not null,
  original_request text not null,
  interpreted_goal text,
  status text not null,
  mode text not null,
  active_branch text,
  active_patch_candidate_id uuid,
  current_summary text,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### task_snapshots

```sql
create table task_snapshots (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  snapshot_type text not null,
  summary text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

### acceptance_criteria

```sql
create table acceptance_criteria (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  text text not null,
  status text not null,
  risk_level text,
  requires_human_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### repo_nodes

```sql
create table repo_nodes (
  id uuid primary key,
  repo_id uuid not null,
  node_type text not null,
  stable_key text not null,
  name text not null,
  path text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, stable_key)
);
```

### repo_edges

```sql
create table repo_edges (
  id uuid primary key,
  repo_id uuid not null,
  source_node_id uuid not null references repo_nodes(id),
  target_node_id uuid not null references repo_nodes(id),
  edge_type text not null,
  confidence numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### domains

```sql
create table domains (
  id uuid primary key,
  repo_id uuid not null,
  name text not null,
  description text,
  owns jsonb not null default '[]'::jsonb,
  allowed_reads jsonb not null default '[]'::jsonb,
  allowed_writes jsonb not null default '[]'::jsonb,
  related_domains jsonb not null default '[]'::jsonb,
  forbidden_by_default jsonb not null default '[]'::jsonb,
  risk_profile jsonb not null default '[]'::jsonb,
  verification jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, name)
);
```

### beliefs

```sql
create table beliefs (
  id uuid primary key,
  task_id uuid references tasks(id),
  repo_id uuid not null,
  belief_type text not null,
  claim text not null,
  status text not null,
  confidence numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### hypotheses

```sql
create table hypotheses (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  claim text not null,
  status text not null,
  confidence numeric not null,
  relevant_domains jsonb not null default '[]'::jsonb,
  relevant_graph_nodes jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### claims

```sql
create table claims (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  acceptance_criterion_id uuid references acceptance_criteria(id),
  text text not null,
  status text not null,
  reviewer_guidance text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### evidence

```sql
create table evidence (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  evidence_type text not null,
  summary text not null,
  status text,
  source_type text not null,
  source_ref text,
  artifact_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### claim_evidence_links

```sql
create table claim_evidence_links (
  id uuid primary key,
  claim_id uuid not null references claims(id),
  evidence_id uuid not null references evidence(id),
  link_type text not null,
  created_at timestamptz not null default now(),
  unique (claim_id, evidence_id, link_type)
);
```

### failures

```sql
create table failures (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  hypothesis_id uuid references hypotheses(id),
  failure_type text not null,
  summary text not null,
  lesson text,
  artifact_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### decisions

```sql
create table decisions (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  decision text not null,
  rationale text not null,
  alternatives_rejected jsonb not null default '[]'::jsonb,
  verification_required jsonb not null default '[]'::jsonb,
  decided_by text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

### probes

```sql
create table probes (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  capability text not null,
  status text not null,
  expected_information_gain text,
  cost text,
  risk text,
  reason text,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

### patch_candidates

```sql
create table patch_candidates (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  name text not null,
  base_commit text not null,
  status text not null,
  hypothesis_id uuid references hypotheses(id),
  diff_artifact_id uuid,
  summary text,
  verification_status text,
  promotion_decision text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### verification_checks

```sql
create table verification_checks (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  acceptance_criterion_id uuid references acceptance_criteria(id),
  claim_id uuid references claims(id),
  check_type text not null,
  command text,
  status text not null,
  evidence_id uuid references evidence(id),
  risk_level text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### commands

```sql
create table commands (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  command text not null,
  cwd text,
  status text not null,
  exit_code integer,
  started_at timestamptz not null,
  completed_at timestamptz,
  stdout_artifact_id uuid,
  stderr_artifact_id uuid,
  summary text,
  payload jsonb not null default '{}'::jsonb
);
```

### artifacts

```sql
create table artifacts (
  id uuid primary key,
  task_id uuid references tasks(id),
  artifact_type text not null,
  path text not null,
  content_hash text,
  size_bytes bigint,
  summary text,
  created_at timestamptz not null default now()
);
```

### trace_events

```sql
create table trace_events (
  id uuid primary key,
  task_id uuid references tasks(id),
  repo_id uuid not null,
  event_type text not null,
  actor text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

## Indexing requirements

Forge State Store should include indexes for:

* task status
* active task by repo
* repo node stable key
* repo node path
* repo edges by source and target
* hypotheses by task and status
* claims by task and status
* evidence by task and type
* verification checks by task and status
* failures by task
* decisions by task
* trace events by task and time
* commands by task and status
* JSONB fields used in capability queries

Add vector indexes for selected semantic retrieval fields:

* task summaries
* evidence summaries
* decision rationales
* failure lessons
* repo region descriptions
* review comments
* documentation chunks
* trace summaries

Vector retrieval should assist typed lookup. It should not replace typed lookup.

## Context Server capabilities

The Forge Context Server exposes typed state access to the agent.

### task.get_current_state

Returns compact current task state:

```json
{
  "task_id": "...",
  "goal": "...",
  "status": "implementing",
  "acceptance_summary": "...",
  "current_patch_candidate": "...",
  "top_hypothesis": "...",
  "open_blockers": [],
  "next_action": "..."
}
```

### task.resume

Returns everything needed after a context reset:

```json
{
  "task_summary": "...",
  "acceptance_contract": [],
  "current_state": "...",
  "files_touched": [],
  "top_hypotheses": [],
  "recent_decisions": [],
  "relevant_failures": [],
  "verification_status": [],
  "next_action": "..."
}
```

### belief.get_top_hypotheses

Returns ranked hypotheses with evidence and contradictions.

### belief.get_open_uncertainties

Returns unresolved uncertainties and recommended probes.

### evidence.get_for_claim

Returns evidence supporting or contradicting a claim.

### evidence.get_exact_artifact

Returns a stable reference or excerpt from exact evidence.

### failure.get_disproven_paths

Returns failed hypotheses, failed patches, and lessons to avoid repeated work.

### decision.get_relevant_decisions

Returns decisions relevant to the current domain, files, acceptance criteria, or risk area.

### repo.get_related_graph_region

Returns a bounded repo graph slice.

### tests.get_affected_tests

Returns tests selected from files changed, graph relationships, domains, risk, and acceptance criteria.

### verification.get_open_matrix

Returns the current verification matrix and unresolved checks.

### pr.get_review_guidance

Returns review guidance derived from claims, risks, evidence gaps, and changed files.

### trace.get_recent_events

Returns a compact recent task trace.

## Write capabilities

The model should not write arbitrary database rows.

Forge internal systems should write through controlled commands:

```text
task.update_state
belief.record_hypothesis
belief.update_confidence
belief.record_contradiction
evidence.record
failure.record
decision.record
verification.record_check
patch.record_candidate
trace.record_event
```

Every write should create a trace event.

Every important write should be attributable to:

* model
* system
* human
* tool
* CI
* reviewer
* verifier

## Transaction model

State updates should be transactional.

Examples:

When a command completes:

```text
insert command result
insert stdout/stderr artifacts
insert evidence if relevant
update verification check if linked
insert trace event
commit
```

When a patch candidate is promoted:

```text
mark previous candidate as rejected or superseded
mark selected candidate as promoted
update task active_patch_candidate_id
update verification obligations
insert decision or trace event
commit
```

When a belief is contradicted:

```text
insert contradicting evidence
update belief status
update hypothesis confidence
mark dependent claims as stale if needed
insert failure if applicable
insert trace event
commit
```

## Resume behavior

Forge must be able to resume a task from Postgres without relying on chat history.

On resume, Forge should:

1. Load task record.
2. Load latest task snapshot.
3. Load active acceptance criteria.
4. Load current top hypotheses.
5. Load relevant evidence and failures.
6. Load active patch candidate.
7. Load verification matrix.
8. Load recent decisions.
9. Load recent trace events.
10. Reconstruct hot context.
11. Continue from the next action.

The resume output should be compact enough to fit into model context.

## Context compaction

Context compaction should not be destructive.

Instead of compressing the whole session into a lossy summary, Forge should:

1. Write exact evidence and trace events to the state store.
2. Create task snapshots at key points.
3. Preserve exact artifacts.
4. Generate compact working summaries from typed state.
5. Rehydrate state on demand through the Context Server.

Context summaries are views over durable state, not the source of truth.

## Artifact storage

Artifacts should be stored outside Postgres by default.

Suggested local layout:

```text
.forge/
  state/
    connection.json
  artifacts/
    <repo_id>/
      <task_id>/
        commands/
        diffs/
        patches/
        screenshots/
        test-results/
        coverage/
        ci/
        review/
```

Postgres stores artifact metadata and stable artifact IDs.

Artifact records include:

* artifact type
* path
* content hash
* size
* creation time
* task ID
* linked evidence ID
* summary

## TUI requirements

Add a **State Store** or **Durable Memory** section to the Forge dashboard.

It should show:

* current task state
* active patch candidate
* last durable snapshot
* top hypotheses
* current evidence count
* failure ledger count
* verification matrix status
* unresolved claims
* open human-review requirements
* recent trace events
* resume readiness
* Postgres connection status

Add a **Resume View**:

```text
Task: Fix SSO invite permissions

Last durable state:
  2026-06-17 11:42

Current status:
  repairing failed auth regression

Top hypothesis:
  role alias normalization happens too late

Active patch candidate:
  attempt-3-auth-layer-normalization

Verification:
  auth regression failed
  invite API tests passed
  typecheck passed

Next action:
  inspect failing auth regression and update role fixture normalization
```

## Operational requirements

### Local Postgres

Forge should manage a local Postgres dependency for local runs.

The user should not need to manually reason about task-state storage.

Forge should provide:

```text
forge state init
forge state status
forge state migrate
forge state doctor
forge state backup
forge state restore
forge state prune
```

### Connection management

Forge should support:

* local Postgres connection string
* managed Postgres connection string
* encrypted credentials
* connection health checks
* migration checks
* schema version checks

### Migrations

Schema changes should use explicit migrations.

Every Forge version should know:

* required schema version
* supported upgrade path
* whether migration is reversible
* whether backup is required before migration

### Backup and restore

Forge should support task-level and repo-level backup.

Examples:

```text
forge state backup --task <task_id>
forge state restore --task <task_id>
forge state export --repo <repo_id>
```

### Retention

Forge should support retention policies for:

* command logs
* trace events
* artifacts
* old task snapshots
* patch candidates
* old repo graph versions

Default should preserve all state for active tasks.

No evidence required by a claim should be pruned while the task or PR is active.

## Security and privacy

Forge State Store may contain sensitive codebase, logs, secrets accidentally printed by commands, CI outputs, branch names, review comments, and internal product details.

Requirements:

* local-first storage
* no external sync unless explicitly configured
* no raw secrets shown to the model if redaction is possible
* artifact redaction hooks
* access controls for team mode
* task-level export and deletion
* audit trace for state access
* configurable retention policies

The Context Server should enforce least-privilege state access.

The model should only receive state relevant to the active task and permitted domains.

## Integration with Active Repo Belief Graph

The Active Repo Belief Graph requires durable storage for:

* beliefs
* hypotheses
* confidence
* uncertainty
* evidence links
* contradictions
* invalidations
* probe recommendations
* diagnosis state
* claim-evidence graph

The Forge State Store is the persistence layer for this feature.

Belief graph updates must be written to Postgres as first-class state, not kept inside the prompt.

## Integration with verification

Verification checks should be durable and claim-linked.

When Forge runs a test, typecheck, lint, build, migration check, visual check, or manual review step, it should record:

* command or check
* start time
* completion time
* status
* output artifact
* linked acceptance criterion
* linked claim
* linked evidence
* stale status if code changes invalidate it

Verification state must survive context resets.

## Integration with patch search

Patch candidates and checkpoints should be durable.

Each patch candidate should record:

* hypothesis
* base commit
* changed files
* diff artifact
* commands run
* verification result
* failure reason
* promotion or rejection decision
* rollback metadata

This lets Forge compare attempts and avoid corrupting the final branch.

## Integration with PR output

The final PR should be generated from durable state.

PR content should use:

* acceptance criteria from Postgres
* implementation summary from task snapshots
* verification matrix from checks
* claim-evidence graph from claims and evidence
* failed hypotheses from failure ledger
* decisions from decision ledger
* risk notes from domain and belief state
* reviewer guide from claims, risks, and evidence gaps

The PR should not rely on whatever the model happens to remember at the end of the session.

## Context Server response shape

Every Context Server response should be:

* compact
* typed
* source-linked
* relevance-scored where appropriate
* explicit about missing state
* explicit about stale state
* explicit about assumptions

Example:

```json
{
  "capability": "belief.get_top_hypotheses",
  "task_id": "task_123",
  "hypotheses": [
    {
      "id": "hyp_1",
      "claim": "SSO role alias is not normalized before invite permission check.",
      "status": "likely",
      "confidence": 0.72,
      "supporting_evidence": ["ev_1", "ev_2"],
      "contradicting_evidence": [],
      "open_uncertainties": ["unc_1"],
      "recommended_probe": "auth.trace_permission_check"
    }
  ],
  "warnings": []
}
```

## Failure modes to design against

### State loss

The system must not lose task state on model reset, process restart, or terminal crash.

### Stale belief

If new evidence contradicts a belief, the belief must be demoted or marked stale.

### Context pollution

The model should not receive unbounded logs, unrelated trace history, or entire chat history.

### Evidence loss

Summaries are not evidence. Exact artifacts must remain recoverable.

### Repeated failed attempts

Failed hypotheses and failed patches must be recorded and retrieved before repeating similar work.

### Raw database misuse

The model must not query or mutate raw SQL.

### Orphaned artifacts

Every important artifact should be linked to a task, command, evidence record, or trace event.

### Silent verification invalidation

If code changes after a verification check, affected checks and claims must be marked stale.

## Acceptance criteria

This feature is complete when:

1. Forge uses Postgres as the durable state store for long-horizon task execution.
2. Forge can resume an active task after model context reset without relying on chat history.
3. Task state, acceptance criteria, hypotheses, claims, evidence, failures, decisions, verification checks, patch candidates, commands, artifacts, and trace events are persisted.
4. The model accesses state through the Forge Context Server, not raw SQL.
5. Context Server capabilities return compact, typed, permissioned state slices.
6. Exact artifacts are preserved and referenced from evidence records.
7. Every important state write creates a trace event.
8. Verification checks are linked to acceptance criteria, claims, evidence, and artifacts.
9. Patch candidates and checkpoints survive process restart.
10. Failed hypotheses can be retrieved before the model repeats a failed path.
11. Claims in final PR output are generated from durable claim-evidence state.
12. The TUI shows current durable state, resume status, evidence, failures, decisions, verification, and active patch candidate.
13. Forge can export, backup, restore, and inspect task state.
14. Schema migrations are versioned and safe.
15. The system supports local Postgres and managed Postgres using the same state model.

## Evaluation criteria

Measure Forge with and without durable Postgres-backed state on long-horizon tasks.

Metrics:

* resume success rate after context reset
* verified completion rate
* repeated failed hypothesis count
* irrelevant files edited
* stale claims caught
* verification checks preserved across sessions
* time to reconstruct state after interruption
* reviewer confidence in PR evidence
* number of final claims backed by durable evidence
* number of task failures caused by lost context
* patch candidate recovery success
* cost per verified task

Target outcome:

Forge should be able to run a 12-hour task where model contexts are periodically reset, while preserving task continuity, evidence, failures, decisions, verification status, patch candidates, and PR readiness.

## Product positioning

This feature supports the core Forge claim:

```text
Forge owns the task from ticket to verified PR.
```

That claim requires more than a large prompt. It requires durable task memory.

Product-facing language:

```text
Forge does not depend on a model remembering the whole session. Every task has durable engineering state: what Forge believes, what it tried, what failed, what was verified, what evidence exists, and what needs review.
```

Technical positioning:

```text
A Postgres-backed durable state store and typed context server for long-horizon software-engineering agents.
```

Strategic positioning:

```text
The memory substrate for task-owning coding agents.
```

## Final recommendation

Build Forge State Store as a first-class platform component.

Use Postgres from day one.

Expose state through typed Context Server capabilities.

Never rely on prompt history as durable memory.

Never expose raw SQL to the model.

Preserve exact evidence outside the prompt.

Make all long-horizon task state inspectable, resumable, verifiable, and PR-facing.

This is not an implementation detail. This is part of the Forge harness advantage.
