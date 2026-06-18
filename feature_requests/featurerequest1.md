# Feature Brief: Active Repo Belief Graph

## One-sentence summary

Add an Active Repo Belief Graph to Forge: a probabilistic, evidence-backed, truth-maintained software-system map that lets Forge localize tasks, choose uncertainty-reducing probes, diagnose failures, avoid stale assumptions, and produce assurance-backed PRs with stronger long-horizon reliability.

## Product name

Working names:

* Active Repo Belief Graph
* Active Software System Map
* Repo Belief Engine
* Active Repo SLAM
* Belief-Guided Repo Intelligence

Recommended internal name: **Active Repo Belief Graph**

Recommended product-facing language: **Forge maps the repo while it works, tracks what it knows and does not know, and uses evidence to decide what to inspect, test, edit, and verify next.**

## Background

Forge already treats a repository as a software system rather than raw text. It maps packages, apps, routes, symbols, tests, migrations, ownership, risk areas, domain boundaries, and verification surfaces. That gives the agent a better operating environment than generic file search and terminal access.

The next step is to make the repo map active, uncertain, and task-aware.

Most repo graphs are static or semi-static. They answer questions like:

```text
Where is this symbol defined?
What imports this module?
Which tests mention this file?
What build target depends on this package?
```

Forge needs to answer higher-level long-horizon engineering questions:

```text
Where is this task actually located?
Which behavioral path implements the feature or bug?
Which hypothesis is most likely?
What evidence supports that hypothesis?
What assumption has been disproven?
Which probe should Forge run next before editing?
Which test will most efficiently distinguish between competing explanations?
Which claims can the final PR safely make?
```

The Active Repo Belief Graph turns the repo map from a static index into a task-localization, diagnosis, and verification control system.

## Core thesis

Long-horizon coding agents fail not only because they lack code context, but because they lack a durable, inspectable belief state about the software system.

They often:

* retrieve too much irrelevant context
* localize the task incorrectly
* edit before understanding the behavioral path
* keep stale assumptions after new evidence contradicts them
* repeat failed hypotheses
* run tests without knowing what uncertainty the tests resolve
* overclaim completion without explicit evidence
* lose diagnostic state across long sessions, restarts, review loops, and CI failures

The Active Repo Belief Graph fixes this by giving Forge a durable structure for:

* what the system currently believes
* why it believes it
* what evidence supports or contradicts it
* what remains uncertain
* what hypotheses are competing
* which probes could reduce uncertainty
* which claims are verified, unverified, or disproven
* which assumptions should be invalidated when new evidence arrives

The result should be higher verified completion on long-horizon tasks, fewer irrelevant edits, fewer repeated failures, better context selection, stronger verification, and more trustworthy PRs.

## Conceptual model

Forge should not just build a repo graph and then use it.

Forge should continuously run this loop:

```text
task arrives
→ create initial task belief state
→ localize likely domains and graph regions
→ generate competing hypotheses
→ select the next best probe
→ observe evidence
→ update beliefs
→ invalidate stale assumptions
→ refine localization
→ propose patch candidate
→ verify against acceptance contract
→ update claim-evidence graph
→ produce assurance-backed PR
```

This is a repo-understanding equivalent of active mapping and diagnosis.

Forge is not passively indexing a codebase. It is actively mapping the parts of the software system relevant to the task, while tracking uncertainty and using evidence to decide what to do next.

## User value

### For individual engineers

Forge becomes easier to trust because it can show:

* what it thinks is happening
* why it thinks that
* what evidence it has
* what remains uncertain
* what it is going to inspect or test next
* which hypotheses it has ruled out
* why it edited a file
* why it chose a specific verification plan

### For reviewers

PRs become easier to review because Forge can show:

* the behavioral path it identified
* the acceptance criteria it verified
* the evidence behind each completion claim
* the failed hypotheses it avoided
* the risky assumptions still requiring human review
* the tests selected and why they were selected

### For teams

Forge becomes a better delegation surface for long-horizon work because it can reduce senior-engineer babysitting. The product becomes less like a chat-based coding agent and more like a task-owning engineering workbench.

## Feature goals

1. Represent repo understanding as an evidence-backed belief graph, not only as a static graph.
2. Track competing task-localization and fault hypotheses.
3. Attach confidence, evidence, contradictions, and uncertainty to graph claims.
4. Choose context-gathering actions and tests as explicit probes.
5. Update beliefs after observations from code reads, tests, logs, typechecks, screenshots, diffs, CI failures, review comments, and human decisions.
6. Invalidate stale assumptions when new evidence contradicts them.
7. Feed belief state into domain routing, context selection, patch search, test selection, risk handling, and PR generation.
8. Produce final PR output as a claim-evidence assurance graph.
9. Make the system inspectable in the Forge TUI.

## Non-goals

This feature is not:

* a replacement for the existing repo graph
* a replacement for normal static analysis
* a replacement for the semantic capability fabric
* a new model architecture
* a generic vector search system
* a benchmark-only feature
* an autonomous proof of correctness for all software behavior
* a guarantee that human review is unnecessary

The feature is a control layer over Forge’s existing repo graph, task state, evidence memory, failure ledger, verification matrix, and semantic capabilities.

## Key idea

A normal repo graph stores facts:

```yaml
file: apps/api/src/routes/invite.ts
imports:
  - packages/auth/policy.ts
defines:
  - createInvite
references:
  - requireOrgAdmin
```

The Active Repo Belief Graph stores task-relevant beliefs:

```yaml
belief:
  id: belief.sso_admin_invite_failure.auth_role_mapping
  claim: SSO admin invite failure is likely caused by role alias normalization.
  confidence: 0.68
  status: plausible
  supporting_evidence:
    - evidence.api_invite_returns_403_for_sso_admin
    - evidence.sso_migration_touched_role_values
    - evidence.invite_route_uses_require_org_admin
  contradicting_evidence:
    - evidence.frontend_sends_expected_payload
  uncertainty:
    - whether role normalization happens before permission check
    - whether old org_admin values are backfilled
  next_best_probe:
    capability: auth.trace_permission_check
    reason: Distinguishes route guard fault from role normalization fault.
```

The graph does not only know what files exist. It knows what Forge currently believes about the task.

## Primary use case

A user gives Forge a task:

```text
Fix the bug where org admins cannot invite users after the SSO migration.
```

Forge creates an initial belief state:

```yaml
task_belief_state:
  task: Fix org admins cannot invite users after the SSO migration.

  likely_domains:
    auth: 0.82
    backend: 0.74
    database: 0.51
    tests: 0.49
    frontend: 0.28
    billing: 0.02

  candidate_hypotheses:
    - id: hypothesis.role_alias_not_normalized
      claim: SSO role alias is not normalized before invite permission check.
      confidence: 0.61
      status: plausible

    - id: hypothesis.invite_route_guard_wrong
      claim: Invite route guard checks stale role names.
      confidence: 0.42
      status: plausible

    - id: hypothesis.frontend_button_guard
      claim: Frontend admin guard prevents invite submission.
      confidence: 0.21
      status: weak

    - id: hypothesis.migration_backfill_missing
      claim: Migration failed to backfill old admin role values.
      confidence: 0.36
      status: plausible

  next_best_probe:
    action: auth.trace_permission_check
    expected_value: high
    cost: low
    reason: Identifies whether the failure occurs before, inside, or after role normalization.
```

Forge then probes the system before editing. It uses semantic capabilities and existing tools as sensors:

```yaml
probe:
  capability: auth.trace_permission_check
  input:
    actor: sso_org_admin
    action: create_invite
  result:
    permission_check: failed
    observed_role: org_admin
    normalized_role: member
    failing_condition: required admin
```

Forge updates the belief graph:

```yaml
belief_update:
  promoted:
    - hypothesis.role_alias_not_normalized

  demoted:
    - hypothesis.frontend_button_guard

  new_claims:
    - claim: The failure is server-side, not frontend-only.
      support:
        - direct API request returns 403
        - permission trace fails before frontend code is involved

  next_patch_strategy:
    Normalize SSO role aliases in the auth layer rather than special-casing the invite route.

  verification_obligations:
    - old org_admin users can invite
    - new SSO admin users can invite
    - non-admin users cannot invite
    - invite route uses normalized auth state
    - affected auth and invite tests pass
```

The final PR includes a claim-evidence graph:

```yaml
completion_claims:
  - claim: SSO org admins can invite users.
    status: verified
    evidence:
      - sso admin invite API test passed
      - role normalization unit test passed
      - auth regression suite passed

  - claim: Non-admin users cannot invite users.
    status: verified
    evidence:
      - non-admin invite API test passed
      - auth regression suite passed

  - claim: Existing role values remain compatible after migration.
    status: needs_human_review
    evidence:
      - migration inspected
      - backfill behavior inferred
    missing_evidence:
      - production data sample not available
```

## System components

### 1. Belief Graph Store

A durable graph store for task-specific and repo-level beliefs.

The store should support:

* nodes
* edges
* claims
* hypotheses
* confidence values
* evidence links
* contradiction links
* assumptions
* invalidation rules
* provenance
* timestamps
* task scope
* domain scope
* risk scope
* verification status

The graph should have two layers:

1. **Repo-level belief graph**

   * durable across tasks
   * represents known repository structure, domains, conventions, ownership, test relationships, build relationships, risk areas, and historical observations

2. **Task-level belief graph**

   * created per task
   * represents current task interpretation, likely domains, candidate hypotheses, evidence, uncertainty, failed attempts, decisions, risks, patch candidates, and verification claims

Repo-level beliefs can seed task-level beliefs. Task-level observations can update repo-level beliefs when the observation is reusable beyond the current task.

### 2. Belief Node Types

Initial node types:

```yaml
node_types:
  - Repo
  - Package
  - App
  - File
  - Directory
  - Symbol
  - Function
  - Class
  - Component
  - Route
  - Endpoint
  - Test
  - TestSuite
  - BuildTarget
  - Command
  - DatabaseTable
  - Migration
  - Domain
  - Capability
  - Task
  - AcceptanceCriterion
  - Hypothesis
  - Claim
  - Assumption
  - Evidence
  - Observation
  - Probe
  - PatchCandidate
  - Failure
  - Decision
  - Risk
  - VerificationCheck
  - HumanReviewRequirement
```

### 3. Belief Edge Types

Initial edge types:

```yaml
edge_types:
  structural:
    - contains
    - defines
    - imports
    - exports
    - references
    - calls
    - depends_on
    - owns
    - belongs_to_domain
    - touches_database_table
    - handled_by
    - guarded_by
    - tested_by
    - built_by

  epistemic:
    - supports
    - contradicts
    - assumes
    - invalidates
    - derived_from
    - observed_by
    - inferred_from
    - requires_verification
    - needs_human_review

  task_control:
    - localizes_to
    - suggests_probe
    - suggests_patch
    - verifies_acceptance_criterion
    - blocks_completion
    - expands_domain
    - selected_for_context
    - selected_for_verification
```

### 4. Confidence and Status Model

Each belief should have a status and confidence.

Example statuses:

```yaml
belief_status:
  - unknown
  - plausible
  - likely
  - verified
  - contradicted
  - disproven
  - stale
  - superseded
  - needs_human_review
```

Confidence should not be treated as mathematical certainty. It is an operational ranking signal used to choose context, probes, and patch strategies.

Example:

```yaml
confidence:
  value: 0.72
  interpretation: likely
  reason:
    - two supporting observations
    - no direct contradiction
    - historically related files changed together
```

### 5. Evidence Object

Evidence must be stable and recoverable.

```yaml
evidence:
  id: evidence.auth_regression_passed_2026_06_17_001
  type: test_result
  source: command_output
  command: pnpm test auth
  timestamp: 2026-06-17T10:42:15Z
  status: passed
  artifact_ref: forge://evidence/task-123/auth-regression-output
  summary: Auth regression suite passed.
  exact_output_ref: forge://artifacts/task-123/commands/auth-regression.log
```

Evidence should never only exist as a model summary. The exact artifact remains recoverable.

### 6. Probe Object

A probe is any read-only or low-risk action taken to reduce uncertainty.

Probe types:

```yaml
probe_types:
  - read_file
  - search_symbols
  - trace_call_path
  - trace_permission_check
  - inspect_migration
  - inspect_route
  - inspect_component
  - run_focused_test
  - run_typecheck
  - run_lint
  - run_api_request
  - run_visual_check
  - inspect_git_history
  - inspect_ci_failure
  - ask_human_question
```

Probe selection should consider:

```yaml
probe_selection_factors:
  - expected_information_gain
  - execution_cost
  - runtime_cost
  - risk
  - reversibility
  - confidence_delta
  - number_of_hypotheses_distinguished
  - acceptance_criteria_relevance
  - domain_relevance
  - whether the probe can falsify a leading hypothesis
```

### 7. Probe Planner

The Probe Planner chooses the next best observation.

Input:

```yaml
probe_planner_input:
  task
  acceptance_contract
  current_belief_state
  candidate_hypotheses
  current_uncertainties
  available_capabilities
  domain_permissions
  risk_profile
  cost_mode
  autonomy_mode
```

Output:

```yaml
probe_planner_output:
  selected_probe:
    capability: auth.trace_permission_check
    reason: Distinguishes between role normalization bug and invite route guard bug.
    expected_information_gain: high
    cost: low
    risk: low
    required_permissions:
      - read auth domain
      - run auth diagnostic
```

Probe planning should run before editing and after any failed verification.

### 8. Hypothesis Engine

The Hypothesis Engine creates and updates candidate explanations.

It should be used for:

* bug repair
* CI failure repair
* failed tests
* review comment resolution
* ambiguous feature implementation
* migration-sensitive changes
* cross-domain tasks
* production bug investigation

Example hypothesis:

```yaml
hypothesis:
  id: hypothesis.invite_expiry_missing_backend_check
  claim: Expired invites are not rejected because the backend accept endpoint does not check expires_at.
  confidence: 0.57
  status: plausible
  relevant_domains:
    - backend
    - database
    - auth
    - tests
  supporting_evidence:
    - migration defines expires_at
    - accept endpoint does not reference expires_at
  contradicting_evidence: []
  next_best_probe:
    capability: tests.find_related_tests
    input:
      behavior: expired invite acceptance
```

The Hypothesis Engine should not only generate ideas. It should maintain the current hypothesis set, demote disproven hypotheses, and prevent repeated failed paths unless new evidence changes the conditions.

### 9. Truth Maintenance Layer

The Truth Maintenance Layer tracks justifications and invalidates beliefs when their support is contradicted.

Example:

```yaml
belief:
  claim: Invite failure is frontend-only.
  support:
    - admin invite button appears disabled
  status: plausible

new_observation:
  claim: Direct API request returns 403.
  type: contradiction

truth_maintenance_update:
  belief: Invite failure is frontend-only.
  new_status: contradicted
  reason: API failure occurs without frontend involvement.
  downstream_updates:
    - frontend domain confidence lowered
    - backend and auth domain confidence raised
    - frontend edit permission withheld until new evidence appears
```

This is critical for long-horizon reliability because it prevents stale assumptions from surviving after contradictory evidence appears.

### 10. Diagnostic Engine

The Diagnostic Engine maps failed observations to likely fault locations.

It should consume:

* failing tests
* stack traces
* type errors
* lint errors
* runtime logs
* API responses
* screenshots
* CI failures
* review comments
* user bug reports

It should produce:

* candidate fault components
* likely causal paths
* discriminating probes
* affected domains
* verification obligations

Example:

```yaml
diagnosis:
  observed_failure:
    test: invite API rejects SSO org admin
    error: expected 200, received 403

  candidate_faults:
    - component: role normalization
      confidence: 0.64
    - component: invite route guard
      confidence: 0.41
    - component: test fixture role setup
      confidence: 0.33
    - component: frontend guard
      confidence: 0.08

  next_discriminating_probe:
    action: auth.trace_permission_check
    reason: Separates auth-layer fault from route-layer fault.
```

### 11. Assurance Case Generator

The final PR should include a structured claim-evidence argument.

The output should answer:

* what was implemented
* which acceptance criteria were satisfied
* which claims are verified
* what evidence supports each claim
* what remains unverified
* what needs human review
* what failed along the way
* how failed hypotheses were resolved
* why the selected verification plan was credible

Example:

```yaml
assurance_case:
  top_claim:
    Team invitations with roles, expiry, audit logs, UI, tests, and docs are implemented.

  subclaims:
    - claim: Admins can invite users by email.
      status: verified
      evidence:
        - invite API test passed
        - frontend invite form test passed

    - claim: Non-admins cannot invite users.
      status: verified
      evidence:
        - permission boundary test passed
        - auth regression suite passed

    - claim: Invites expire after configured duration.
      status: verified
      evidence:
        - expired invite unit test passed
        - API test rejects expired invite

    - claim: Migration is safe for existing invite rows.
      status: needs_human_review
      evidence:
        - migration inspected
        - migration test added
      reviewer_guidance:
        - inspect default value and backfill behavior
```

This turns the PR from “here is some code and tests” into “here is the argument that this task is complete.”

## Integration with existing Forge systems

### Repo Intelligence

Repo Intelligence continues to build the base map:

* packages
* apps
* entrypoints
* routes
* services
* components
* database schema
* migrations
* tests
* dependency graph
* symbol graph
* build commands
* ownership
* conventions
* git history
* flaky tests
* project instructions
* domain boundaries
* risk areas

The Active Repo Belief Graph sits above this and adds epistemic state:

* confidence
* hypotheses
* uncertainty
* evidence
* contradictions
* invalidations
* task relevance
* next probes

### Repository Graph

The existing repository graph remains the structural source of truth for code relationships.

The belief graph references repository graph nodes and adds task-specific meaning.

Example:

```yaml
repo_graph_fact:
  invite_route calls requireOrgAdmin

belief_graph_claim:
  The invite failure likely occurs in the auth permission path.

support:
  - invite_route calls requireOrgAdmin
  - direct API request returns 403
  - SSO role value changed in migration
```

### Semantic Capability Fabric

Capabilities become probe actions.

Example capabilities:

```text
auth.trace_permission_check
auth.find_policy_sources
auth.explain_role_mapping
db.find_migrations_touching_table
tests.select_affected_tests
tests.detect_coverage_gap
repo.find_dependency_path
frontend.find_route_component
pr.prepare_review_guide
```

Each capability should return both an observation and a belief-update suggestion.

Example:

```yaml
capability_result:
  observation:
    type: permission_trace
    summary: SSO org_admin normalizes to member before invite check.
  belief_updates:
    - promote hypothesis.role_alias_not_normalized
    - demote hypothesis.frontend_guard_bug
  suggested_next_probe:
    capability: tests.find_related_tests
```

### Semantic Router

The existing router selects domains and graph regions. The Belief Graph adds confidence and uncertainty.

Instead of:

```yaml
selected_domains:
  - auth
  - backend
  - database
  - tests
```

The router should emit:

```yaml
selected_domains:
  - domain: auth
    confidence: 0.82
    reason: Invite failure is permission-related.
  - domain: backend
    confidence: 0.74
    reason: Direct API request fails.
  - domain: database
    confidence: 0.51
    reason: SSO migration touched role values.
  - domain: frontend
    confidence: 0.28
    reason: UI guard may be involved, but API failure suggests not primary.
```

The model can request domain expansion, but the system should record why expansion happened and which uncertainty justified it.

### Task Brain

The Task Brain becomes the owner of the task-level belief state.

It should display and persist:

* current top hypothesis
* alternative hypotheses
* disproven hypotheses
* open uncertainties
* next best probe
* accepted evidence
* contradictions
* assumptions
* stale beliefs
* verification obligations

### Evidence Ledger

The Evidence Ledger becomes the source of support for belief claims.

Every important belief should link to evidence or be marked as assumption, inference, unverified, contradicted, or needs human review.

### Failure Ledger

The Failure Ledger feeds the truth-maintenance system.

Failed hypotheses should become explicit contradicted or demoted beliefs.

Example:

```yaml
failed_attempt:
  hypothesis: Frontend invite form is blocking SSO admins.
  result: Direct API request still fails with 403.
  belief_update:
    hypothesis.frontend_only_failure:
      status: contradicted
      confidence: 0.04
```

### Verification Matrix

The Verification Matrix should be generated from:

* acceptance contract
* touched domains
* candidate risks
* belief graph claims
* evidence gaps
* human-review requirements

Verification is not just “run tests.” Verification should answer: which claim does this check support or disprove?

### PR Layer

The PR summary should include:

* task summary
* implementation summary
* acceptance criteria
* verification plan
* claim-evidence table
* failure and recovery summary
* remaining unverified claims
* human-review requirements
* reviewer guide

## TUI requirements

Add an **Active Map** panel to the Forge dashboard.

### Panel: Current belief state

Shows:

```text
Top hypothesis:
  SSO role alias is not normalized before invite permission check.

Confidence:
  0.68, likely

Supporting evidence:
  direct API request returns 403
  SSO migration touched role values
  invite route uses requireOrgAdmin

Contradictions:
  none

Open uncertainty:
  whether old role values are backfilled

Next best probe:
  auth.trace_permission_check
```

### Panel: Hypothesis board

Shows competing hypotheses:

```text
Likely:
  SSO role alias normalization bug

Plausible:
  invite route guard checks stale role name
  migration backfill missing

Weak:
  frontend-only guard issue

Disproven:
  invite email provider failure
```

### Panel: Probe queue

Shows candidate probes:

```text
1. auth.trace_permission_check
   value: high
   cost: low
   distinguishes: role mapping vs route guard

2. db.find_migrations_touching_table
   value: medium
   cost: low
   distinguishes: migration issue vs auth-only issue

3. tests.run_auth_regression_tests
   value: medium
   cost: medium
   verifies: permission boundary behavior
```

### Panel: Assumption and contradiction tracker

Shows:

```text
Assumption:
  Existing org_admin values should map to admin.

Status:
  unverified

Required evidence:
  migration backfill test or code inspection

Potential consequence:
  cannot claim migration safety until verified
```

### Panel: Assurance case

Shows final PR claim tree:

```text
Top claim:
  Team invitations are implemented.

Verified:
  admins can invite
  non-admins are blocked
  expired invites are rejected

Needs human review:
  production migration safety
  copy and UX wording
```

## Data model sketch

### TaskBeliefState

```typescript
type TaskBeliefState = {
  taskId: string;
  repoId: string;
  goal: string;
  acceptanceCriteria: AcceptanceCriterionRef[];
  selectedDomains: DomainBelief[];
  selectedGraphRegions: GraphRegionBelief[];
  hypotheses: Hypothesis[];
  claims: Claim[];
  assumptions: Assumption[];
  uncertainties: Uncertainty[];
  evidenceRefs: EvidenceRef[];
  contradictions: Contradiction[];
  nextBestProbe?: ProbeRecommendation;
  verificationObligations: VerificationObligation[];
  humanReviewRequirements: HumanReviewRequirement[];
  updatedAt: string;
};
```

### Hypothesis

```typescript
type Hypothesis = {
  id: string;
  claim: string;
  status:
    | "unknown"
    | "plausible"
    | "likely"
    | "verified"
    | "contradicted"
    | "disproven"
    | "stale"
    | "superseded"
    | "needs_human_review";
  confidence: number;
  relevantDomains: string[];
  relevantGraphNodes: string[];
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  assumptions: AssumptionRef[];
  suggestedProbes: ProbeRecommendation[];
  suggestedPatchStrategies: PatchStrategy[];
  createdAt: string;
  updatedAt: string;
};
```

### ProbeRecommendation

```typescript
type ProbeRecommendation = {
  id: string;
  capability: string;
  input: Record<string, unknown>;
  expectedInformationGain: "low" | "medium" | "high";
  cost: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  distinguishesHypotheses: string[];
  verifiesClaims: string[];
  reason: string;
  requiredPermissions: string[];
};
```

### Claim

```typescript
type Claim = {
  id: string;
  text: string;
  status:
    | "unverified"
    | "verified"
    | "contradicted"
    | "needs_human_review"
    | "not_applicable";
  acceptanceCriterionRefs: string[];
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  verificationChecks: VerificationCheckRef[];
  reviewerGuidance?: string;
};
```

## Agent loop changes

### Current simplified loop

```text
understand task
→ retrieve context
→ plan
→ edit
→ test
→ repair
→ PR
```

### New belief-guided loop

```text
understand task
→ create acceptance contract
→ initialize task belief state
→ localize likely domains and graph regions
→ generate candidate hypotheses
→ select next best probe
→ run probe
→ record observation
→ update beliefs
→ repeat until localization is sufficient
→ create patch candidate
→ verify against claim graph
→ update evidence and failure ledgers
→ repair through diagnostic loop if needed
→ produce assurance-backed PR
```

## Completion gating

Forge should not claim completion unless:

1. Every acceptance criterion has at least one associated claim.
2. Every completion claim is verified, explicitly unverified, not applicable, or marked for human review.
3. Every high-risk claim has sufficient evidence or human-review requirement.
4. Every failed verification has either been repaired or recorded as unresolved.
5. Every disproven hypothesis is preserved in the failure ledger.
6. The PR contains a reviewer guide based on the assurance case.
7. The final verification matrix is consistent with the claim-evidence graph.

## Implementation plan

### Phase 1: Task-level belief state

Implement the task-level data model:

* hypotheses
* claims
* assumptions
* uncertainties
* evidence links
* contradictions
* next best probe
* verification obligations

Integrate it with Task Brain, Evidence Ledger, Failure Ledger, and Verification Matrix.

MVP behavior:

* Forge creates initial hypotheses after task understanding.
* Forge records support and contradictions.
* Forge shows current top hypothesis in the TUI.
* Forge demotes a hypothesis when direct contradictory evidence appears.
* Forge links final PR claims to evidence.

### Phase 2: Probe planner

Implement probe recommendations over existing capabilities.

MVP probe types:

* read relevant file
* find definitions
* find references
* trace call path
* inspect migration
* find related tests
* run focused test
* inspect recent git changes
* run typecheck
* run lint

Probe selection can initially use a scored heuristic:

```text
score =
  information_gain_estimate
  + acceptance_relevance
  + hypothesis_discrimination
  + risk_reduction
  - execution_cost
  - context_cost
  - permission_cost
```

This does not need perfect probabilistic inference at first. It needs to make uncertainty visible and choose better next actions than generic retrieval.

### Phase 3: Belief updates from observations

Add structured observation outputs from capabilities.

Each capability should optionally return:

```yaml
observation
belief_updates
new_uncertainties
suggested_next_probes
verification_implications
```

Example:

```yaml
observation:
  route: POST /orgs/:id/invites
  guard: requireOrgAdmin
  role_source: session.user.role

belief_updates:
  - supports: hypothesis.invite_route_guard_involved
  - suggests_probe: auth.explain_role_mapping

verification_implications:
  - invite API tests required
  - auth regression tests required
```

### Phase 4: Truth maintenance

Add invalidation and contradiction logic.

Initial rules:

* If direct runtime/test evidence contradicts an inferred belief, demote the inferred belief.
* If a hypothesis is disproven by a test or trace, prevent repeated patch attempts based on that hypothesis unless new evidence appears.
* If a claim depends on a stale assumption, mark the claim as needing re-verification.
* If a patch changes a dependency of a verified claim, mark the claim as stale until rechecked.
* If a human decision resolves an ambiguity, record it and do not re-litigate it unless new evidence changes the conditions.

### Phase 5: Diagnostic engine

Use failed tests, stack traces, CI failures, review comments, and runtime logs to generate candidate fault hypotheses.

MVP diagnostic behavior:

* parse failing command output into structured observation
* identify likely affected files, symbols, domains, and tests
* generate candidate fault hypotheses
* suggest discriminating probes
* update failure ledger after each failed patch
* avoid repeated failed attempts

### Phase 6: Assurance-case PR output

Generate a final claim-evidence tree in the PR summary and TUI.

PR sections:

```markdown
## Acceptance Criteria

## Implementation Summary

## Claim-Evidence Summary

## Verification Matrix

## Failed Hypotheses and Recovery

## Known Unverified Claims

## Human Review Required

## Reviewer Guide
```

Each final claim should have status:

```text
verified
needs human review
unverified
not applicable
```

### Phase 7: Repo-level learning

Promote reusable task observations to durable repo-level beliefs.

Examples:

* this repo’s auth domain owns role normalization
* invite API tests cover invite permission behavior
* this test is flaky
* this package is high-risk
* this migration pattern requires human review
* this component is the frontend entry point for team settings
* these files are frequently co-changed

This is where the graph compounds over time.

## Initial MVP scope

The MVP should focus on bug repair and CI failure repair because those make belief updates and diagnostic value obvious.

### MVP task classes

1. Auth or permission bug
2. CI failure after a PR
3. Test failure repair
4. Migration-sensitive backend change
5. Review comment resolution

### MVP capabilities

* create initial hypotheses
* select likely domains
* recommend next probe
* record observations
* promote or demote hypotheses
* link evidence to claims
* mark stale or contradicted beliefs
* generate claim-evidence PR summary

### MVP excluded

* full Bayesian inference
* perfect probabilistic graph updates
* full program-wide dynamic tracing
* automatic proof of correctness
* universal framework support
* fully automated human-review replacement

## Success metrics

Measure against Forge without Active Repo Belief Graph.

Primary metrics:

* verified completion rate on long-horizon tasks
* first-pass localization accuracy
* number of irrelevant files edited
* repeated failed hypothesis count
* successful recovery after failed test
* time and cost to verified PR
* number of claims with explicit evidence
* percentage of final claims marked verified vs unverified
* reviewer acceptance rate
* review comment volume
* CI repair success rate
* task resume success after interruption

Secondary metrics:

* average number of probes before first edit
* information value of probes
* affected-test precision
* affected-test recall
* domain-routing recall
* domain overreach
* number of stale beliefs invalidated
* number of patch candidates rejected for evidence-backed reasons
* human-review requirement precision

## Evaluation design

Create paired evaluations:

```text
same model
same repo
same task
same time/cost budget
Forge baseline vs Forge with Active Repo Belief Graph
```

Task set:

* SSO invite permission bug
* billing webhook regression
* database migration plus API change
* frontend plus backend feature
* CI failure repair
* review-comment resolution
* monorepo framework upgrade
* auth refactor without behavior change
* production bug investigation
* resume task after interruption

Expected improvement:

* better localization
* fewer irrelevant edits
* fewer repeated failures
* stronger verification coverage
* better PR reviewability
* higher completion rate
* lower cost per verified task

## Product positioning

This feature strengthens Forge’s core positioning:

```text
Same model, same repo, same task, better harness, better engineering outcomes.
```

The Active Repo Belief Graph makes the harness more than a repo index. It makes Forge an active software-system mapper and verifier.

Product-facing claim:

```text
Forge does not just search your repo. It builds a living map of what it knows, what it believes, what it has disproven, and what evidence proves the work is done.
```

Technical positioning:

```text
A probabilistic, evidence-backed, truth-maintained repo belief graph for long-horizon software-engineering agents.
```

Commercial positioning:

```text
The missing trust layer for autonomous coding agents: explicit task localization, evidence-backed claims, diagnostic recovery, and reviewable verification.
```

## Why this is differentiated

Many systems have code search, symbol graphs, build graphs, test selection, and agent memory.

This feature combines them into a single control loop:

```text
belief state
→ active probe
→ evidence
→ belief update
→ patch candidate
→ verification
→ assurance-backed PR
```

The differentiation is not the existence of a repo graph. The differentiation is that the repo graph is:

* task-aware
* probabilistic
* evidence-backed
* truth-maintained
* probe-driven
* diagnosis-aware
* verification-linked
* PR-facing

That should be meaningfully stronger for long-horizon work than a static code index or a generic agent memory layer.

## Example final PR section

```markdown
## Claim-Evidence Summary

Top claim: SSO org admins can invite users again without weakening non-admin permission boundaries.

### Verified claims

1. SSO org admins can create invites.
   Evidence:
   - Added regression test for SSO org admin invite flow.
   - Invite API test passes.
   - Auth regression suite passes.

2. Non-admin users cannot create invites.
   Evidence:
   - Existing permission boundary test passes.
   - New non-admin invite regression test passes.

3. Role alias normalization happens in the auth layer.
   Evidence:
   - Role normalization unit test passes.
   - Invite route continues to depend on normalized auth state rather than provider-specific aliases.

### Failed hypotheses

1. Frontend-only invite guard issue.
   Result:
   - Disproven by direct API request returning 403 without frontend involvement.

2. Invite email provider issue.
   Result:
   - Disproven because failure occurred before invite creation.

### Human review recommended

1. Confirm production role aliases match the migration assumptions.
2. Inspect auth-layer normalization because it affects permission-sensitive behavior.
```

## Acceptance criteria for this feature

The feature is complete when:

1. Forge creates a task-level belief state for every long-horizon task.
2. The belief state includes hypotheses, confidence, evidence, contradictions, uncertainties, and next best probe.
3. Semantic capabilities can return structured observations and belief-update suggestions.
4. Forge uses probe recommendations before risky edits.
5. Failed hypotheses are recorded and not repeated unless new evidence changes the conditions.
6. Claims in the final PR are linked to evidence or marked as unverified, not applicable, or needing human review.
7. The TUI shows the current belief state, hypothesis board, probe queue, and assurance case.
8. The verification matrix is generated from acceptance criteria, risk, touched domains, and claim-evidence gaps.
9. The evaluation harness can compare Forge with and without the feature on the same task set.
10. The system improves long-horizon verified completion, localization accuracy, or failure recovery in baseline comparisons.

## Strategic importance

This feature should be treated as a core Forge advantage, not a side module.

It turns Forge from:

```text
a coding agent with repo intelligence
```

into:

```text
an active software-system mapper, diagnostic engine, and verification harness
```

That is exactly aligned with Forge’s core thesis: the same model performs better when the harness gives it durable task state, bounded context, software-system structure, evidence, failure memory, verification, and reviewable output.

The Active Repo Belief Graph is the unifying layer that makes those pieces operate as one long-horizon engineering control system.
