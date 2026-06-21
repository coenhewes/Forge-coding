# Forge Final Product Brief

> **Operating notes** (Postgres setup, migrations, test conventions,
> reference-repo attribution rules) live in `docs/OPERATING_NOTES.md` and
> `docs/REFERENCE_REPOS.md`. This file is the product brief only.

## Product Name

**Forge**

## Product Category

Forge is a standalone long-horizon software engineering agent.

Forge competes directly with Claude Code, Codex, OpenCode, Cursor-style agents, Devin-style autonomous engineering tools, SWE-agent-style systems, OpenHands-style systems, Aider-style tools, and other coding-agent programs.

Forge is not a plugin.

Forge is not a wrapper.

Forge is not an OpenCode extension.

Forge is not a benchmark suite.

Forge is not a generic RAG app.

Forge is not a thin LLM shell around a filesystem.

Forge is a full coding-agent product whose advantage is the harness.

## Core Thesis

The same model should perform better in Forge than in a flatter coding-agent harness because Forge gives the model a better software-engineering operating environment.

Forge does not treat the repository as:

```text
a flat filesystem
a giant context window
a pile of vector chunks
a huge tool list
a long chat transcript
a generic terminal session
```

Forge treats the repository as:

```text
a mapped software system
a graph of software relationships
a set of semantic engineering domains
a typed task environment
a permissioned capability surface
a source of evidence
a verification target
a reviewable PR substrate
a durable state object
```

The core product belief is:

```text
Same model.
Same repo.
Same task.
Better harness.
Better engineering outcomes.
```

## One-Sentence Product Description

Forge is a long-horizon coding agent that turns a real engineering task into a verified, reviewable pull request by operating through a repo-aware semantic MCP fabric, repository graph, durable task state, evidence tracking, failure reflection, checkpointed patch search, affected-test selection, and verification gates.

## Product Promise

Give Forge a real software task:

```text
Add team invitations with roles, expiry, audit logs, backend APIs, frontend UI, tests, and docs.
```

Forge should produce:

```text
a branch
a pull request
a task state TUI dashboard
an implementation plan
a repo impact map
an acceptance contract
a verification matrix
an evidence ledger
a failure ledger
a decision ledger
a risk report
a trace of work performed
a clear review guide
```

The final output is not:

```text
Here is some code.
```

The final output is:

```text
Here is the implemented task, here is the PR, here is the evidence, here is what was verified, here is what failed and was recovered from, here is what still needs human attention, and here is what reviewers should inspect first.
```

## Strategic Positioning

Forge wins by being the best agent for implementation ownership.

Forge is not optimized for autocomplete.

Forge is not optimized for Q&A.

Forge is not optimized for one-shot code edits.

Forge is not optimized for isolated bug fixes.

Forge is optimized for tasks where normal coding agents:

```text
lose state
touch the wrong files
forget failed attempts
repeat disproven hypotheses
overrun context
skip verification
make unreviewable diffs
stop too early
fail to recover from test failures
fail to resume cleanly
fail to explain why a change was made
```

Forge should feel like:

```text
a senior engineer workbench
a task-owning implementation agent
a long-horizon software engineering operating system
a PR-producing engineering collaborator
```

Forge should not feel like:

```text
a chat app that can edit files
```

## Competitive Positioning

Forge is not defensibly differentiated by merely having:

```text
agent modes
subagents
MCP support
file editing
terminal access
permissions
planning prompts
project instructions
context compaction
git commits
test execution
PR generation
```

Those are already normal or increasingly normal primitives in serious coding-agent products.

Forge is differentiated only if the harness is real product infrastructure.

Forge's defensible edge is:

```text
repo intelligence
software graph awareness
semantic domain boundaries
purpose-built agent-computer interfaces
typed task state
context control
evidence memory
failure reflection
acceptance contracts
affected-test selection
checkpointed patch search
verification authority
reviewable PR output
```

Forge should not position itself as "another coding agent."

Forge should position itself as:

```text
the long-horizon software-engineering harness that lets an agent own a task from ticket to verified PR.
```

## Target Task Class

Forge is optimized for:

```text
multi-file tasks
multi-domain tasks
large repos
monorepos
long-running tasks
ambiguous product tasks
tasks requiring tests
tasks requiring frontend and backend changes
tasks requiring database changes
tasks requiring API changes
tasks requiring migration safety
tasks requiring reviewable PRs
tasks requiring pause and resume
tasks where verification matters
tasks where context loss is expensive
tasks where repeated failed attempts are common
tasks where risk must be visible
```

Example target tasks:

```text
Implement team invitations across backend, database, frontend, email, tests, and docs.
Migrate a repo from one auth model to another.
Fix SSO invite permissions after a role-mapping migration.
Replace a billing provider across API, webhooks, UI, and tests.
Refactor permissions without changing behavior.
Upgrade a framework across a monorepo.
Fix a frontend bug using screenshots, logs, and failing tests.
Respond to code review comments and update the PR.
Investigate a production bug and produce a verified patch.
Repair a CI failure introduced by a multi-domain change.
Add a new API surface with docs, tests, migration notes, and review guidance.
```

Forge is not expected to outperform lighter coding agents on every simple task.

Forge should outperform flatter agents on long-horizon, multi-domain, verification-heavy software engineering tasks.

## Product Architecture

Forge has two major layers.

```text
Forge Agent
  The user-facing coding-agent product.

Forge Harness
  The long-horizon operating layer that makes the agent better.
```

The user-facing agent is the product.

The harness is the strategic asset.

The product proves the harness works.

## Core Harness Concept

Forge is built around a **Repo-Mapped Semantic MCP Fabric**.

Instead of giving the model direct access to every file and every tool, Forge first understands the repository as a software system, represents that system through a graph and semantic domains, exposes purpose-built capabilities, routes the task to relevant capabilities, controls context, tracks state, records evidence, remembers failures, verifies the result, and produces a reviewable PR.

Conceptual product flow:

```text
User task
  ↓
Task understanding
  ↓
Acceptance contract
  ↓
Repo map and repository graph
  ↓
Domainized MCP fabric
  ↓
Semantic capability router
  ↓
Bounded model context
  ↓
Evidence-backed localization
  ↓
Patch proposals
  ↓
Checkpointed patch search
  ↓
Affected-test selection
  ↓
Verification harness
  ↓
Reviewable PR
```

## Product Principle

The model should not have to carry the repo in its context.

The model should operate through a repo-aware environment that gives it:

```text
the right context
the right files
the right graph relationships
the right tools
the right permissions
the right task state
the right evidence
the right failure memory
the right verification
the right stopping conditions
```

## Core Systems

Forge is made of these conceptual systems:

```text
1. Repo Intelligence
   Maps the codebase, domains, ownership, commands, tests, conventions, and software graph.

2. Repository Graph
   Represents imports, symbols, call sites, routes, test relationships, migrations, ownership, dependencies, and cross-domain edges.

3. Semantic MCP Fabric
   Converts domains into scoped, purpose-built capabilities.

4. Agent-Computer Interface Layer
   Presents software-engineering-native actions instead of a raw tool dump.

5. Task Brain
   Maintains task state, acceptance criteria, assumptions, subtasks, evidence, failures, decisions, risks, and next actions.

6. Execution Harness
   Lets the model propose changes through bounded tools, permissions, state, and checkpoints.

7. Context and Evidence Plane
   Keeps working context bounded while preserving recoverable evidence outside the prompt.

8. Verification and PR Layer
   Proves the work, selects affected checks, produces a reviewable branch, and records what remains unresolved.

9. Trace and Observability Layer
   Makes the task inspectable, auditable, resumable, and reviewable.
```

## 1. Repo Map

Forge builds and maintains a structured understanding of the codebase.

The repo map tracks:

```text
packages
apps
entrypoints
routes
services
components
database schema
migrations
test suites
dependency graph
symbol graph
build commands
lint commands
typecheck commands
ownership boundaries
architectural conventions
recent git history
known flaky tests
project instructions
domain boundaries
risk-sensitive areas
```

The repo map is not just search.

The repo map is Forge's internal model of the software system.

## 2. Repository Graph

Forge must include a real software graph layer.

The repository graph represents:

```text
imports
exports
symbols
definitions
references
call sites
routes
controllers
services
components
database tables
migrations
test relationships
ownership boundaries
package dependencies
runtime dependencies
cross-domain edges
configuration dependencies
CI and build relationships
```

The repository graph strengthens:

```text
file localization
task decomposition
domain routing
affected-test selection
risk detection
review guidance
verification planning
cross-domain change detection
```

Forge should know not just which files contain matching text, but how code paths, ownership, tests, and runtime behavior relate.

## 3. Domainization Layer

Forge divides the repo into logical engineering domains.

Example domains:

```text
frontend
backend
auth
billing
database
tests
infra
docs
CI
shared packages
API
permissions
email
observability
security
```

Each domain has a manifest.

Each manifest includes:

```text
what it owns
what it can read
what it can write
what commands it can run
what tests verify it
what other domains it depends on
what other domains depend on it
what risks are associated with it
what graph nodes it contains
what graph edges connect it to other domains
what human review sensitivity it carries
```

Example domain manifest:

```yaml
domain: auth

owns:
  - packages/auth/**
  - apps/api/src/auth/**
  - apps/api/src/routes/invite.ts

allowed_reads:
  - packages/auth/**
  - apps/api/src/auth/**
  - apps/api/src/routes/**
  - tests/auth/**
  - relevant database schema
  - relevant permission policy files

allowed_writes:
  - packages/auth/**
  - apps/api/src/auth/**
  - tests/auth/**

related_domains:
  - backend
  - database
  - tests
  - frontend
  - security

forbidden_by_default:
  - billing/**
  - infra/**
  - secrets/**

risk_profile:
  - permissions
  - security
  - account access
  - role mapping

verification:
  - auth regression tests
  - invite API tests
  - permission boundary tests
  - affected integration tests
```

## 4. Generated Domain MCP Fabric

Each domain exposes controlled capabilities.

These are not generic filesystem tools.

Weak capability surface:

```text
read_file
write_file
search_files
run_command
```

Strong capability surface:

```text
auth.trace_permission_check
auth.find_policy_sources
auth.find_auth_callers
auth.explain_role_mapping
auth.get_invite_policy
auth.run_auth_regression_tests

db.get_table_schema
db.find_migrations_touching_table
db.check_query_impact
db.run_migration_tests

frontend.find_route_component
frontend.find_state_owner
frontend.find_form_validation
frontend.run_visual_check

tests.find_related_tests
tests.select_affected_tests
tests.detect_coverage_gap
tests.run_verification_plan

repo.find_callers
repo.find_definitions
repo.find_cross_domain_edges
repo.explain_dependency_path
repo.find_ownership_boundary

pr.prepare_review_guide
pr.summarize_diff_by_domain
pr.list_risky_changes
```

The model interacts with repo concepts, not just raw files.

## 5. Agent-Computer Interface Discipline

Forge's semantic MCP fabric is an agent-computer interface, not a tool dump.

The interface must be purpose-built for software engineering work.

Forge's capability layer should expose actions and observations that match engineering concepts:

```text
trace a permission check
find affected callers
identify related tests
explain a route path
inspect a migration impact
find ownership boundaries
detect a coverage gap
summarize a risky diff
compare patch candidates
verify an acceptance criterion
```

Forge should avoid flooding the agent with undifferentiated tools, raw files, raw logs, and unbounded terminal output.

The interface should make the correct engineering action easier than the wrong generic action.

## 6. Semantic Capability Router

Forge includes a local router that selects the relevant domains, capabilities, graph regions, files, evidence, and verification checks for each task.

Input:

```text
Fix the bug where org admins cannot invite users after the SSO migration.
```

Router output:

```yaml
selected_domains:
  - auth
  - backend
  - database
  - tests

possible_adjacent_domains:
  - frontend
  - infra
  - security

withheld_domains:
  - billing
  - docs

selected_graph_regions:
  - invite authorization path
  - role mapping logic
  - SSO user normalization path
  - invite API route
  - relevant database tables
  - related auth tests

selected_capabilities:
  - auth.trace_permission_check
  - auth.find_policy_sources
  - db.get_table_schema
  - tests.select_affected_tests
  - tests.run_verification_plan
```

The router should optimize for high recall.

It is better to include one extra relevant domain than to hide the true source of the bug.

The model must be able to request domain expansion when evidence suggests the initial route was incomplete.

## 7. Bounded Model Context

The model receives:

```text
user task
acceptance contract
current task state
selected repo facts
selected graph facts
selected domain tools
selected evidence
selected verification status
recent trace
open questions
risk constraints
failure-ledger warnings
checkpoint status
```

The model does not receive:

```text
the entire repo
every tool
every file
every past message
every domain
every raw log
every terminal output
unbounded write permissions
```

This is the core performance bet.

Forge should reduce context pollution, reduce context rot, and reduce the chance that irrelevant information crowds out task-critical state.

## 8. Task State Engine

Forge maintains durable task state outside the model context.

It tracks:

```text
original request
current interpretation
acceptance criteria
assumptions
open questions
subtasks
dependencies
completed work
remaining work
files touched
commands run
tests run
failures encountered
decisions made
risks
verification status
evidence links
failed hypotheses
patch candidates
review blockers
next action
```

This state must survive:

```text
long sessions
model context resets
process restarts
human interruptions
user edits
branch changes
resuming tomorrow
review cycles
CI failures
```

The agent should never rely purely on a long chat transcript.

## 9. Acceptance Contract Engine

Forge converts vague tasks into checkable requirements.

Example input:

```text
Add team invitations.
```

Structured acceptance contract:

```text
Admin can invite a user by email.
Invite supports role assignment.
Invite expires after configured duration.
Invitee can accept invite.
Revoked invite cannot be accepted.
Expired invite cannot be accepted.
Non-admin cannot invite users.
Admin can see pending invites.
Relevant tests are added.
Security-sensitive behavior is verified.
Migration behavior is accounted for.
PR includes review guidance.
```

Forge must know what "done" means before it claims completion.

The acceptance contract should drive:

```text
task decomposition
context selection
domain routing
patch evaluation
test selection
evidence requirements
human review requirements
completion gating
```

## 10. Evidence Ledger

Forge attaches evidence to important claims.

Example:

```yaml
claim: Invite expiry is implemented.

evidence:
  - migration adds expires_at
  - acceptance endpoint rejects expired invites
  - expired invite unit test passes
  - expired invite API test passes

unverified:
  - timezone behavior in non-UTC environments
```

Every final claim should be either:

```text
supported by evidence
marked unverified
marked needing human review
```

The evidence ledger must distinguish:

```text
observed facts
inferred facts
test results
code changes
runtime outputs
screenshots
reviewer feedback
human decisions
unverified assumptions
```

The final PR should not rely on the agent's confidence alone.

The final PR should rely on evidence.

## 11. Indexed Evidence Memory

Forge preserves task-relevant observations outside the working prompt.

Evidence memory includes:

```text
exact command outputs
test failures
test passes
diffs
logs
screenshots
error traces
review comments
human decisions
selected files
graph facts
tool results
```

Evidence should be recoverable by stable references.

Evidence memory should prevent lossy summary failures where the system remembers that something existed but cannot recover the exact detail later.

Forge should not treat compaction as the source of truth.

Forge should treat exact evidence as the source of truth.

## 12. Failure Ledger

Forge records failed attempts as structured knowledge.

Example:

```yaml
failed_attempt:
  hypothesis: Frontend invite form is blocking SSO admins.
  action: Changed frontend role check.
  result: Invite still fails with 403.
  lesson: Failure is server-side.
  next_hypothesis: SSO role mapping changed from org_admin to admin.
```

The failure ledger tracks:

```text
failed hypotheses
failed patches
failed commands
failed tests
dead ends
bad assumptions
reviewer objections
reverted changes
causal lessons
conditions under which a path may become viable again
```

This prevents loops and repeated bad fixes.

## 13. Failure-Ledger Reflection

Forge's failure ledger is not just a log.

Forge must use failed attempts as action-guiding knowledge.

Before repeating a search, patch, command, or hypothesis, Forge should recognize whether that path has already failed.

Failure reflection should help Forge answer:

```text
What have we already tried?
Why did it fail?
What evidence disproved it?
What should not be repeated?
What became newly plausible after later evidence?
What is the next best hypothesis?
```

Forge should explicitly avoid repeating disproven hypotheses unless new evidence changes the conditions.

## 14. Decision Ledger

Forge records important engineering decisions.

Example:

```yaml
decision: Normalize SSO role aliases in auth layer, not invite route.

rationale:
  Invite route should not know provider-specific role names.

alternatives_rejected:
  - patch frontend role check
  - special-case invite route
  - backfill database only

verification_required:
  - old org_admin users can still invite
  - new SSO admin users can invite
  - non-admin users are still blocked
```

The decision ledger makes the agent reviewable and resumable.

It should capture:

```text
architecture choices
product assumptions
security-sensitive decisions
API compatibility choices
migration choices
dependency choices
rejected alternatives
human decisions
verification obligations
```

## 15. Verification Matrix

Forge maintains task-specific verification status.

Example:

```text
Unit tests: passed
API tests: passed
Frontend tests: passed
Typecheck: passed
Lint: passed
Build: passed
Migration up/down: passed
Auth regression: passed
Visual check: not applicable
Security review: needs human review
Performance check: not run
```

Forge distinguishes:

```text
passed
failed
skipped
not applicable
blocked
needs human review
```

The verifier is the authority.

The model proposes.

Forge checks.

Forge should never treat "code was edited" as completion.

Forge should treat verified acceptance criteria as completion.

## 16. Affected-Test Selection

Forge maps code changes, graph relationships, domains, and acceptance criteria to the smallest credible verification set.

Affected-test selection should consider:

```text
files changed
symbols changed
callers affected
routes affected
database tables affected
migrations affected
domains touched
risk profile
historical flaky tests
acceptance criteria
cross-domain edges
review sensitivity
```

Forge should escalate verification when risk is high.

High-risk changes require broader verification.

Low-risk changes can use narrower verification when justified.

Affected-test selection directly supports:

```text
lower cost per verified task
faster repair cycles
better confidence
less random test running
stronger verification coverage
clearer PR review guidance
```

## 17. Evidence-Led Verification and Claim Graph

Forge separates claims from proof.

Completion-relevant claims must attach to evidence.

Example claim graph:

```yaml
claim: Non-admin users cannot invite team members.

evidence:
  - permission policy requires admin role
  - invite API test rejects non-admin user
  - auth regression suite passed

status: verified
```

Example unresolved claim:

```yaml
claim: Existing pending invites survive migration.

evidence:
  - migration preserves invite table rows
  - migration test not present

status: needs human review
```

Forge's final state should make clear:

```text
what was claimed
what supports each claim
what remains unverified
what requires human review
what reviewers should inspect first
```

## 18. Risk Model

Forge classifies risky work and changes behavior accordingly.

High-risk areas:

```text
auth
permissions
billing
payments
data deletion
migrations
cryptography
concurrency
public APIs
privacy
security
deployment config
infrastructure
role mapping
multi-tenant access
secrets
compliance-sensitive flows
```

High-risk tasks require:

```text
more evidence
more verification
more conservative edits
more checkpoints
more explicit human approval
clearer final warnings
stronger review guidance
```

Risk should influence:

```text
domain routing
write permissions
test selection
checkpoint frequency
human escalation
PR summary
review guidance
completion gating
```

## 19. Cross-Domain Change Protocol

Long-horizon work often crosses boundaries.

Forge must support safe domain expansion.

Example:

```yaml
cross_domain_change:
  initiator: auth
  affected_domains:
    - database
    - backend
    - tests
    - frontend

reason:
  SSO role mapping affects invite authorization and admin UI guards.

required_checks:
  - auth regression tests
  - invite API tests
  - migration test
  - frontend admin invite flow
```

The system should start bounded, then expand when evidence demands it.

Forge should record:

```text
why expansion happened
which domains were added
which risks changed
which checks became required
which files became writable
which human approvals became necessary
```

## 20. Localization, Repair, and Validation Discipline

Forge must preserve a disciplined structure for software repair work.

Forge should distinguish:

```text
localization
repair
validation
```

Forge should not jump directly from a vague task to broad editing.

Forge should first establish a credible understanding of the affected area, then patch, then validate against the acceptance contract and verification matrix.

This discipline is especially important for:

```text
bug repair
CI failure repair
regression repair
auth issues
database issues
review comment resolution
cross-domain changes
```

Forge should absorb the lesson that simple, disciplined localization and validation can outperform over-orchestrated agent behavior.

## 21. Iterative Context Retrieval

Forge must support evidence-backed context acquisition before editing.

Forge should not rely on one-shot retrieval.

Forge should support a loop of:

```text
context
hypothesis
additional targeted context
refined hypothesis
patch candidate
verification
```

This requirement exists to improve file localization, reduce irrelevant edits, and avoid premature patching.

Forge should be able to update its understanding when new evidence changes the likely source of the task.

## 22. Checkpoints and Rollback

Forge must be able to experiment without corrupting the final branch.

Requirements:

```text
checkpoint before risky changes
record patch candidates
rollback failed attempts
compare alternative patches
preserve known-good states
separate experimental work from final work
recover from bad directions
```

The user should be able to inspect:

```text
Attempt 1: failed
Attempt 2: partially worked
Attempt 3: selected final patch
```

## 23. Checkpointed Patch Search

Forge should support multiple isolated patch attempts.

Patch attempts should be comparable.

Forge should only promote the verified patch candidate.

Patch candidates should preserve:

```text
hypothesis
files changed
reason for change
test result
verification status
failure reason
risk assessment
promotion decision
```

Checkpointed patch search is central to recovery.

Recovery is one of the clearest proofs that Forge is more than a chat-based coding agent.

## 24. Human Checkpoint Protocol

Forge should ask questions only when human input is genuinely needed.

It should detect:

```text
product ambiguity
architecture forks
security-sensitive choices
data migration risks
API compatibility risks
unclear UX behavior
external dependency choices
legal or compliance sensitivity
irreversible changes
high-risk production behavior
```

Questions should be specific and option-based.

Example:

```text
Should invited users be required to accept with the same email address?

Option A:
  Yes. More secure.

Option B:
  No. More flexible but riskier.

Recommendation:
  Option A.
```

Human decisions must be recorded in task state and decision ledgers.

The agent should not re-litigate the same decision later unless new evidence changes the situation.

## 25. PR Generation and Reviewability

Forge must produce PRs that feel like competent engineering work.

PR includes:

```text
clear title
summary
motivation
implementation notes
acceptance criteria
test plan
screenshots if UI changed
migration notes
risk areas
known limitations
follow-up items
review guidance
verification summary
evidence summary
failure and recovery summary
human-review items
```

Diff quality requirements:

```text
minimal unrelated churn
coherent commits
clear naming
repo-style consistency
tests near changed behavior
no hidden broad rewrites
no silent dependency sprawl
no untracked risky changes
no unexplained domain expansion
```

Reviewers should be able to answer:

```text
What changed?
Why did it change?
What acceptance criteria were satisfied?
What evidence supports completion?
What failed along the way?
What was recovered?
What remains unverified?
What should I review first?
```

## 26. Review Comment Resolution

Forge should handle code review loops.

Workflow shape:

```text
read reviewer comments
update task state
classify comments
patch code
respond to comments
rerun relevant checks
update verification matrix
update PR summary
track resolved and unresolved comments
```

This is essential because real engineering work rarely ends at the first PR.

Review comments should become part of:

```text
task state
decision ledger
failure ledger when relevant
evidence ledger
verification matrix
PR readiness
```

## 27. Product Surfaces

Forge should support these product surfaces:

```text
CLI/TUI
TUI dashboard
GitHub PR interface
verification report
IDE extension
CI runner
issue tracker integration
team chat integration
```

The key surface is the TUI dashboard.

The TUI dashboard is what makes Forge not just a chat window.

## 28. TUI Dashboard

The Forge TUI dashboard shows the task as an engineering object.

Required panels:

```text
task goal
acceptance contract
subtasks
current status
open questions
selected domains
domain access
repository graph view
repo impact map
files changed
patch candidates
checkpoint history
evidence ledger
failure ledger
decision ledger
verification matrix
affected-test selection
risk panel
cost and runtime
trace timeline
next action
PR readiness
review guidance
human-review requirements
```

The TUI dashboard should make agent work inspectable, resumable, and reviewable.

## 29. Trace and Observability

Forge must include a full task flight recorder.

Trace includes:

```text
files read
files edited
commands run
tools called
domains selected
domains expanded
graph regions inspected
tests run
failures observed
patch checkpoints
patch candidates
state transitions
human interventions
verification results
cost timeline
review comments
PR updates
```

The user should be able to answer:

```text
Why did it edit this file?
Why did it choose this domain?
Why did it request domain expansion?
What evidence supports this claim?
Where did it fail?
What changed after the failure?
What remains unverified?
What should I review first?
Which patch candidate was promoted?
Which patch candidates were rejected?
Which tests were selected and why?
```

## 30. Context and Tool-Output Control

Forge should not allow raw tool output to dominate the working context.

Tool results, logs, search results, diffs, screenshots, and terminal outputs should become structured task observations.

Forge should preserve exact artifacts in evidence memory while keeping active context bounded.

The model should see:

```text
the relevant observation
the evidence reference
the implication for the task
the next required action
```

The model should not be forced to carry:

```text
unbounded logs
stale terminal output
irrelevant diffs
repeated tool payloads
old failed context
unstructured screenshots
entire file dumps by default
```

## 31. Cost and Autonomy Modes

Forge should support operating modes:

```text
Cheap
Fast
Balanced
Thorough
Conservative
Autonomous
Review-only
```

The key metric is:

```text
verified completed tasks per dollar
```

Forge should not optimize for cheapest model call.

Forge should optimize for cheapest verified completed task.

## 32. Product Modes

## Explore Mode

Purpose:

```text
Understand the task and repo before editing.
```

Outputs:

```text
task interpretation
acceptance criteria
repo impact map
selected domains
selected graph regions
open questions
implementation plan
risk analysis
initial verification plan
```

## Implement Mode

Purpose:

```text
Make controlled code changes.
```

Outputs:

```text
patches
commits
updated task state
evidence
failure records
decision records
verification status
checkpoint history
```

## Repair Mode

Purpose:

```text
Fix test failures, CI failures, regressions, and review comments.
```

Outputs:

```text
failure diagnosis
localized cause
patch candidate
rerun evidence
updated PR
updated verification matrix
updated failure ledger
```

## Review Mode

Purpose:

```text
Review human or agent-authored code.
```

Outputs:

```text
bugs
missing tests
security concerns
style issues
risk notes
suggested fixes
review comments
verification gaps
claim-evidence gaps
```

## Maintain Mode

Purpose:

```text
Perform routine low-risk engineering maintenance.
```

Outputs:

```text
dependency updates
lint fixes
test additions
docs sync
CI cleanup
small safe PRs
verification reports
```

## Research Mode

Purpose:

```text
Investigate technical options before implementation.
```

Outputs:

```text
options
tradeoffs
impact map
recommendation
risk comparison
implementation plan
acceptance criteria
verification implications
```

## 33. Baseline Comparison Harness

Forge must include a way to evaluate itself against flat or less-structured coding-agent harnesses.

The comparison claim:

```text
Same model.
Same repo.
Same task.
Better harness.
Higher verified completion.
```

Evaluation task classes:

```text
multi-file feature implementation
auth or permissions bug
database migration plus backend change
frontend plus backend change
review comment resolution
CI failure repair
resume after interruption
large repo navigation
cross-domain regression
long-running refactor
production bug investigation
```

Metrics:

```text
verified completion rate
cost per completed task
runtime per completed task
irrelevant files edited
number of failed loops
number of repeated failed attempts
number of human interventions
resume success rate
regression rate
PR reviewability
acceptance-criteria coverage
verification coverage
affected-test precision
affected-test recall
domain-routing recall
domain-routing overreach
patch candidate success rate
failure recovery rate
claim-evidence coverage
```

The winning claim should be:

```text
On long-horizon multi-file tasks, the same model completes more tasks in Forge than in a flat coding-agent harness, with fewer unrelated edits, better state retention, stronger verification, better recovery, and lower cost per verified completion.
```

## 34. Killer Demo

The strongest public demo:

```text
Task:
  Add organization invitations with roles, expiry, audit logs, admin UI, email sending, tests, and docs.

Repo:
  Nontrivial SaaS app with frontend, backend, database, auth, tests, and CI.

Forge behavior:
  maps repo
  builds repo graph
  selects auth/backend/db/frontend/tests domains
  creates acceptance contract
  localizes relevant code paths
  identifies affected tests
  implements backend
  implements database migration
  implements frontend
  adds tests
  catches a failed auth regression
  records failed attempt
  avoids repeating disproven hypothesis
  creates alternate patch candidate
  promotes verified patch
  runs verification matrix
  produces PR
  shows evidence ledger
  shows failure ledger
  shows risk report
  shows review guidance
```

The demo should show Forge recovering from a real failure, not just succeeding cleanly.

Recovery is the proof.

## 35. What Makes Forge Better

Forge is better if it can show:

```text
better first-pass file localization
better task decomposition
better context control
better tool selection
better domain routing
better affected-test selection
fewer irrelevant edits
fewer repeated failures
stronger resume behavior
stronger verification
better PR reviewability
lower cost per verified completion
higher long-horizon task completion
better failure recovery
better claim-evidence coverage
better human review guidance
```

## 36. What Makes Forge Defensible

Forge's defensibility comes from the harness layer.

Key assets:

```text
repo mapping system
repository graph
domainization logic
capability router
domain MCP generation
agent-computer interface discipline
task state engine
acceptance contract engine
indexed evidence memory
evidence ledger
failure ledger
failure reflection
decision ledger
verification planner
affected-test selection
risk model
checkpointed patch search
trace data
task-completion dataset
cost and performance ablations
baseline comparison harness
```

The user-facing agent is the product.

The harness is the technology that could become the durable asset.

## 37. Non-Goals

Forge is not primarily:

```text
a chatbot
a code autocomplete tool
a benchmark suite
a generic RAG app
an OpenCode fork
a Claude Code plugin
a Codex integration
a thin wrapper around an LLM
a one-shot code generator
a generic terminal shell
a prompt pack
```

Benchmarks are proof.

The product is the agent.

The strategic asset is the harness.

## 38. Final Requirements Summary

Forge must have:

```text
standalone coding-agent product
repo-aware domain map
repository graph
generated semantic MCP fabric
agent-computer interface layer
local capability router
bounded model context
least-privilege tool access
structured task state
acceptance contract engine
iterative context retrieval
localization, repair, validation discipline
indexed evidence memory
evidence ledger
failure ledger
failure-ledger reflection
decision ledger
verification matrix
evidence-led claim graph
affected-test selection
risk model
cross-domain expansion protocol
checkpoint and rollback
checkpointed patch search
human checkpoint protocol
PR generation
review comment handling
TUI dashboard
trace viewer
cost/runtime reporting
baseline comparison harness
```

## 39. Final Product Identity

Forge should feel like:

```text
a senior engineer workbench
a task-owning implementation agent
a long-horizon software engineering operating system
a PR-producing engineering collaborator
a repo-aware verification harness
```

Forge should not feel like:

```text
a chat app that can edit files
a generic agent terminal
a wrapper around existing tools
a benchmark demo
a prompt-driven coding assistant
```

## 40. North Star

Forge owns the task.

From ticket to verified PR.

With bounded repo access, durable state, repo graph awareness, semantic capabilities, evidence, verification, failure reflection, checkpointed recovery, and reviewability.

The core promise:

```text
Same model.
Better harness.
Better engineering outcomes.
```

---

# Engineering Status & Harness Findings (LIVING — read before continuing harness work)

_Last updated: 2026-06-21. Working state of the Forge-vs-opencode benchmark loop and the harness lessons.
Deep running log: auto-memory file `forge-vs-opencode-loop.md`. Structural opencode comparison:
`docs/harness-comparison-opencode.md`. Read all three._

## The goal (how we measure "better harness")
Same model (**MiniMax-M3**), same hardware (24GB M4 mini). On real OSS long-horizon tasks Forge must:
(1) COMPLETE the task (gate); (2) use FEWER main-model tokens than `opencode` **quality-adjusted** (a
bigger/non-minimal diff for the same outcome is WORSE — judge tokens against fix minimality); (3) degrade
less as tasks get harder/longer. Local-model (Ollama) work is unmetered and does NOT count. A run without
real local-model offload is INVALID.

## Environment (verify before ANY run — never skip)
- **Postgres** on port 54329 (Forge is Postgres-first). Start: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
  /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D <repo>/.local/pgdata -l <repo>/.local/pgdata/server.log start`.
  Verify: `pg_isready -p 54329`; `node -r dotenv/config packages/forge-cli/dist/cli.js doctor`.
- **Ollama**: instruct=`qwen2.5-coder:14b` (~8.5GB), embed=`nomic-embed-text` (dim 768). Run with
  `OLLAMA_KEEP_ALIVE=30s` (the 14B + a heavy test suite OOMs 24GB if pinned). Verify REAL (not fallback):
  `node -r dotenv/config packages/forge-cli/dist/cli.js local test` → "summarize: ollama …", "embed: ok
  dim=768". Forge `run` preflight does its OWN cold smoke test → warm the model right before launching (the
  gauntlet harness does this automatically).
- **MiniMax**: key in `.env` (MINIMAX_API_KEY) and `.forge/config.json`. Anthropic-style endpoint
  `https://api.minimax.io/anthropic/v1/messages`; caching field `cache_read_input_tokens`.
- Build/test: `pnpm build` (tsc project refs), `pnpm test` (~312 pass).

## The rigorous gauntlet (use THIS, not the older _bench/gauntlet/)
`_bench/golden/golden-gauntlet.mjs` — ground-truth harness. **Unit = a real merged upstream fixing PR** (or a
multi-bug set). Mechanism: `git fetch --depth 2 <fixCommit>` → APFS-clonefile worktree → pre-fix checkout (or
reverse-apply each bug's SOURCE hunks onto current main) → lay down the PR's **golden test** → assert it FAILS
(bug reproduced). Both agents get the IDENTICAL fix-free task ("failing tests present; localize root cause in
source; fix minimally; don't edit tests; full suite must pass"). Gate = re-apply golden test (anti-gaming) +
FULL verify suite green + no test-weakening. Quality = agent non-test diff lines vs the PR's reference diff
(over-engineering penalty >2.5×). Per-run fresh DB; local-model preflight enforced. **Multi-run for MM3
variance: `--runs N` → pass-rate + median tokens/minimality, reliability-first verdict.**
- Run: `node _bench/golden/golden-gauntlet.mjs --case GL02 --runs 3` (both agents), `--agent forge`, or
  validate with `--case X --prep-only`. Results in `_bench/golden/results/<id>/`. Forge live feed needs
  `--text` (the harness uses it). Cases (`_bench/golden/manifest.json`): GG01 (zod 1-bug gate), GL01 (4
  harder zod bugs — fix-difficulty-dominated), **GL02 (4 EASY independent zod bugs — the cleanest
  multi-bug-retention test, Forge's edge)**. Repo caches: `_bench/repos/<id>` (clonefiles of a zod clone).
- GOTCHAS: zod tests run from REPO ROOT (`pnpm test`); date-fns needs `--exclude '**/*.tp.ts'`. Never run
  vitest in a worktree while its Forge agent is live (OOM). Reverse-apply only works if the bug's file
  hasn't changed since the fix (`git apply -R --check`; pick recent PRs).

## Current standing (2026-06-21)
- **GG01** (1 bug): Forge ~47K vs opencode ~45K, more minimal — competitive.
- **GL02** (4 easy bugs), CLEAN-CORE: **Forge PASS 4/4 @ 84K tok (was FAIL 1/4 @ 196K); opencode PASS 4/4
  @ 124K.** Forge now CONVERGES and wins TOKENS ~32%, but over-engineered (2.82× ref vs 0.55×) → opencode
  wins minimality. First real Forge multi-bug win (a quality-adjusted TRADE). `--runs 3` + a minimal-fix
  steer were in flight at handoff.
- **GL01** (4 harder bugs): opencode PASS 168K; Forge fixed 7/9 then ground >200K.

## ROOT-CAUSE DIAGNOSIS — "right blocks, stacked wrong"
The thesis is NOT wrong — it was mis-scoped. Forge ran heavy machinery in the HOT PATH (every turn), which
crippled the SAME model vs opencode's clean loop. Failures + fixes (SHIPPED unless noted):
1. **Over-compaction**: compacted at 30 messages → per-turn prompt only ~8–15K → model LOST ITS PLAN →
   fixed 1 bug then wandered. FIX: compact only at OVERFLOW (`CONTEXT_COMPACT_BUDGET=100K` via
   `lastPromptTokens` = uncached+cacheRead), keep a large tail. Full transcript like opencode; caching = cheap.
2. **`read_file` truncation**: `DEFAULT_TOOL_RESULT_BUDGET` was 4000 bytes → ~100-line reads chopped to a
   ref-stub → model couldn't see files → endless grep. FIX: 16000. (Biggest crippler across ~17 runs.)
3. **`search_semantic` permission-DENIED since built** (`permissions.ts` allowlist omitted it) → model looped
   calling its steered tool. FIX: allow-listed it (read-only).
4. **Off-ramps**: completion gated on acceptance criteria (a stop shortcut); a SUBSET test run showing "0
   failing" made the model finish early. FIXES: persistence prompt ("full suite is the bar; multiple
   failures = a checklist, fix ALL; subset ≠ done"); subset-run guard (`testState` tracks `fullSuiteTotal`,
   ignores runs with total < 0.5×full).
5. **Context offload**: SHIPPED `parseTestFailures` (each test run → structured remaining-failures list in
   the situation report) + in-place idempotent tool-output compaction. PRINCIPLE: local/embed models
   LIGHTEN LOAD (retrieval/compaction/rerank) — they must NOT DIAGNOSE; the MAIN model reasons.
6. **Spin controls fighting the model** (debugged all session): opencode uses ONE doom-loop guard (same
   tool+input 3× → stop). Forge currently keeps a redundant-full-suite-rerun block + soft incremental nudge.
   STILL TODO: replace remaining forcing with a single doom-loop guard; slim/retire the now-redundant
   regenerated situation report (transcript is kept now); make finish_task require the FULL suite green.
   DO NOT re-introduce a fixed localisation/read cap — reads are cheap (cached); capping hurts large repos.

## Token-efficiency facts (verified live)
- MiniMax caching WORKS (`minimax.ts` marks system + last tool + the append-only history boundary via
  `cacheBoundary`→`__cacheBoundary` with `cache_control:ephemeral`). `input_tokens` = UNCACHED portion;
  `cache_read_input_tokens` → `mainModelUsage.cacheReadTokens` + CLI "Cache-read tokens" line.
- Transcript MUST be append-only for caching (a sliding window shifts the prefix → 0 cache). Per-turn
  tool-output compaction must be idempotent/in-place or it breaks caching.

## Semantic retrieval (now-wired dormant edge)
`packages/forge-agent/src/semantic-index.ts` + `EmbeddingRepo.nearest()`. Startup (agent-loop Phase 2d):
chunk repo source (50-line windows, tests excluded, embed input capped 2000 chars to avoid nomic HTTP 400),
embed into Postgres. `search_semantic` tool: embed query → cosine → snippets re-read from disk. Model tends
to prefer read_file/grep; it's available + steered but optional. NEXT (on-thesis): have the LOCAL model
RERANK retrieved chunks (dormant rerank fns) — local model as curating interface, never diagnostician.

## Next steps (priority)
1. Finish GL02 `--runs 3`; confirm the minimal-fix steer cut 2.82×→~1×.
2. Re-validate GG01 + GL01 with clean-core.
3. Finish clean-core #6 (doom-loop guard; slim situation report; gate=full-suite).
4. Expand the gauntlet across repos (immer/TanStack-query/… verify offline tests + reverse-appliable recent
   PRs) and to genuinely LONG / compaction-heavy tasks — where "degrade less" should let Forge win decisively.

## Cruft to clean up
`forge-types/src/local-model 2.ts` (duplicate source) + `dist/* 2.ts` artifacts. The older `_bench/gauntlet/`
harness has validity holes (no golden gate, tokens-only scoring, truncated opencode task) — DO NOT use it for
measured results; `_bench/golden/` supersedes it.
