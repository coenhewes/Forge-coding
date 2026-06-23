# Feature Request: Active Verification Planner

## One-sentence summary

Add an Active Verification Planner to Forge: a claim-driven, belief-aware, risk-weighted, cost-sensitive system that chooses the next verification action by expected evidential value rather than merely running related tests.

## Product name

Internal name: **Active Verification Planner**

Related system names:

* Evidence Value Scorer
* Verification Action Planner
* Claim-Driven Verification Engine
* Adaptive Verification Loop

Product-facing language:

**Forge does not just run related tests. It actively chooses the checks that produce the strongest evidence for the claims the PR needs to make.**

## Strategic importance

Forge’s core promise is not “write code.” It is “produce a verified, reviewable pull request.”

That requires more than affected-test selection. Affected-test selection can tell Forge which tests are related to a code change. It does not fully answer the more important question:

```text
What evidence is required before Forge can responsibly claim this task is complete?
```

The Active Verification Planner makes verification claim-driven. It treats tests, typechecks, builds, migration checks, visual checks, API probes, security checks, and human review as evidence-gathering actions. Each action is selected based on how much it improves confidence in the acceptance contract, current hypotheses, risk model, and PR claim-evidence graph.

This becomes a key piece of the Forge harness advantage.

## Core thesis

Long-horizon agents often fail because they stop at “the related tests passed” instead of asking whether the right claims have been proven.

A PR can pass some tests and still be unsafe, incomplete, or poorly evidenced. Forge should not equate green tests with completion. Forge should maintain a structured view of:

* what the task claims to implement
* which claims are verified
* which claims are weak
* which claims are risky
* which assumptions remain unverified
* which tests or checks would most improve confidence
* which verification actions are too expensive, flaky, irrelevant, or low-value
* when human review is required

The Active Verification Planner gives Forge a verification control loop.

## The current baseline

A normal coding agent does something like:

```text
change files
→ run obvious tests
→ fix failures
→ maybe run broader tests
→ claim done
```

Forge already improves on this with acceptance contracts, evidence ledgers, affected-test selection, risk models, verification matrices, and reviewable PR output.

The Active Verification Planner adds the next layer:

```text
acceptance claims
+ belief state
+ patch candidate
+ risk model
+ repo graph
+ test history
+ cost model
+ evidence gaps
→ choose next verification action by expected evidential value
```

## The key shift

From:

```text
Which tests are related to these changed files?
```

To:

```text
Which verification action most increases justified confidence in the claims Forge needs to make?
```

Affected-test selection is repo-centric.

Active verification is claim-centric.

Forge should use both.

## Cross-domain inspiration

The strongest cross-domain analogues are:

1. **Bayesian experimental design**

   * Choose experiments by expected utility or expected information gain.

2. **Medical diagnostic testing**

   * Choose tests based on how much they move belief about a condition.

3. **Expected value of sample information**

   * Run an additional test only if its decision value exceeds its cost.

4. **Computerized adaptive testing**

   * Choose the next test item based on current uncertainty and information value.

5. **Risk-based safety testing**

   * Scale verification intensity based on severity and likelihood of failure.

6. **Hardware intelligent verification**

   * Use feedback from coverage and prior results to target unverified behavior.

Forge’s version combines these into a software-engineering agent system:

```text
claim-driven
+ belief-aware
+ risk-weighted
+ cost-sensitive
+ adaptive
+ evidence-linked
+ PR-facing
```

## Goals

1. Select verification actions based on expected evidential value.
2. Link every important verification action to a claim, acceptance criterion, hypothesis, or risk.
3. Prioritize checks that reduce uncertainty in the current task.
4. Avoid wasting time on low-value checks when higher-value checks exist.
5. Escalate verification for high-risk domains such as auth, billing, permissions, migrations, data deletion, security, privacy, and multi-tenant access.
6. Use historical test performance, flakiness, runtime, and failure signal to improve check selection.
7. Update the verification matrix and claim-evidence graph after each check.
8. Provide a principled stopping condition for “verified enough” versus “requires more evidence.”
9. Make verification decisions inspectable in the TUI and PR.
10. Improve verified completion per dollar.

## Non-goals

This feature is not:

* a replacement for affected-test selection
* a replacement for the verification matrix
* a replacement for human review
* a guarantee of correctness
* a generic CI test prioritizer
* a pure ML test-ordering system
* a system that simply runs fewer tests
* a way to skip required safety checks
* a benchmark-only feature

The Active Verification Planner is a decision layer over Forge’s existing verification, evidence, risk, and repo graph systems.

## Core concept

Verification actions are sensors.

Each check has properties:

```yaml
verification_action:
  id: invite_api_expiry_test
  type: api_test
  runtime_cost: medium
  flakiness_risk: low
  setup_cost: low
  claim_coverage:
    - expired_invites_are_rejected
    - invite_acceptance_uses_expiry
  risk_coverage:
    - auth
    - permissions
  hypothesis_discrimination:
    - backend_expiry_check_missing
    - frontend_validation_only
  evidence_quality: high
  review_usefulness: high
```

The planner chooses the next action based on its expected value:

```text
Evidence Value Score =
  claim importance
  × expected confidence shift
  × risk weight
  × hypothesis discrimination
  × evidence quality
  × review usefulness
  - runtime cost
  - flakiness cost
  - setup cost
  - context cost
```

This can begin as a deterministic scoring system and become learned over time using Forge’s Postgres State Store.

## Verification action types

Forge should treat the following as verification actions:

```yaml
verification_action_types:
  - unit_test
  - api_test
  - integration_test
  - e2e_test
  - frontend_component_test
  - visual_check
  - screenshot_check
  - typecheck
  - lint
  - build
  - migration_up_check
  - migration_down_check
  - seed_data_check
  - security_check
  - permission_boundary_check
  - performance_check
  - static_analysis_check
  - direct_api_probe
  - runtime_trace
  - manual_human_review
  - reviewer_confirmation
```

Each action can produce evidence.

Each evidence record can support, contradict, or partially support one or more claims.

## Verification object model

### VerificationAction

```typescript
type VerificationAction = {
  id: string;
  taskId: string;
  actionType:
    | "unit_test"
    | "api_test"
    | "integration_test"
    | "e2e_test"
    | "frontend_component_test"
    | "visual_check"
    | "typecheck"
    | "lint"
    | "build"
    | "migration_check"
    | "security_check"
    | "permission_boundary_check"
    | "performance_check"
    | "static_analysis_check"
    | "direct_api_probe"
    | "runtime_trace"
    | "manual_human_review";

  command?: string;
  capability?: string;

  targetClaims: string[];
  targetAcceptanceCriteria: string[];
  targetHypotheses: string[];
  targetRisks: string[];

  estimatedRuntimeMs?: number;
  estimatedCost?: "low" | "medium" | "high";
  flakinessRisk?: "low" | "medium" | "high";
  setupCost?: "low" | "medium" | "high";
  evidenceQuality?: "low" | "medium" | "high";
  reviewUsefulness?: "low" | "medium" | "high";

  expectedEvidenceValue: number;
  selectionReason: string;

  status:
    | "candidate"
    | "selected"
    | "running"
    | "passed"
    | "failed"
    | "blocked"
    | "skipped"
    | "stale"
    | "needs_human_review";

  resultEvidenceId?: string;
};
```

### ClaimVerificationState

```typescript
type ClaimVerificationState = {
  claimId: string;
  text: string;
  status:
    | "unverified"
    | "partially_verified"
    | "verified"
    | "contradicted"
    | "stale"
    | "needs_human_review"
    | "not_applicable";

  confidence: number;
  riskLevel: "low" | "medium" | "high" | "critical";

  supportingEvidence: string[];
  contradictingEvidence: string[];
  missingEvidence: string[];

  requiredActions: string[];
  candidateActions: string[];
  lastVerifiedAt?: string;
  staleReason?: string;
};
```

### EvidenceValueScore

```typescript
type EvidenceValueScore = {
  actionId: string;
  totalScore: number;

  components: {
    claimImportance: number;
    expectedConfidenceShift: number;
    riskWeight: number;
    hypothesisDiscrimination: number;
    evidenceQuality: number;
    reviewUsefulness: number;
    runtimePenalty: number;
    flakinessPenalty: number;
    setupPenalty: number;
    contextPenalty: number;
  };

  explanation: string;
};
```

## Active verification loop

The planner should run this loop:

```text
1. Load current acceptance contract.
2. Load current claim-evidence graph.
3. Load current belief state and hypotheses.
4. Identify weakest important claims.
5. Identify high-risk unverified claims.
6. Enumerate possible verification actions.
7. Score each action by expected evidential value.
8. Select the best next action, subject to risk policy.
9. Run the action.
10. Record exact evidence.
11. Update claim confidence and verification matrix.
12. Mark stale or contradicted claims if needed.
13. Repeat until completion gate is satisfied.
```

## Example

Task:

```text
Add team invitations with roles, expiry, audit logs, backend APIs, frontend UI, tests, and docs.
```

Current claim state:

```yaml
claims:
  - id: claim.admin_can_invite
    status: partially_verified
    confidence: 0.74
    risk_level: high

  - id: claim.invites_expire
    status: unverified
    confidence: 0.31
    risk_level: high

  - id: claim.audit_log_written
    status: unverified
    confidence: 0.42
    risk_level: medium

  - id: claim.non_admin_blocked
    status: unverified
    confidence: 0.48
    risk_level: critical
```

Candidate checks:

```yaml
candidate_actions:
  - id: run_auth_permission_boundary_tests
    expected_evidence_value: 0.91
    cost: low
    reason: Directly verifies critical non-admin boundary claim.

  - id: run_invite_api_expiry_tests
    expected_evidence_value: 0.84
    cost: medium
    reason: Directly verifies invite expiry claim.

  - id: run_frontend_component_tests
    expected_evidence_value: 0.52
    cost: medium
    reason: Verifies UI behavior but does not prove backend permission safety.

  - id: run_full_e2e_suite
    expected_evidence_value: 0.78
    cost: high
    reason: Broad signal but slower than targeted critical checks.

  - id: run_lint
    expected_evidence_value: 0.21
    cost: low
    reason: Useful but weak evidence for task completion.
```

Planner decision:

```text
Run auth permission boundary tests first.
```

Reason:

```text
This check has the highest risk-weighted evidence value. It is low cost, directly verifies the critical non-admin boundary claim, and strongly affects whether the PR can safely claim permission behavior is correct.
```

After result:

```yaml
result:
  action: run_auth_permission_boundary_tests
  status: passed
  evidence:
    - non_admin_invite_api_test_passed
    - auth_regression_suite_passed

claim_update:
  claim.non_admin_blocked:
    confidence: 0.48 -> 0.89
    status: verified
```

Next planner selection:

```text
Run invite API expiry tests.
```

Reason:

```text
The highest remaining claim-evidence gap is invite expiry behavior.
```

## Integration with Forge systems

### Acceptance Contract Engine

The Active Verification Planner starts from the acceptance contract.

Every acceptance criterion should become one or more claims.

Example:

```text
Acceptance criterion:
  Expired invites cannot be accepted.

Claim:
  Backend accept endpoint rejects expired invites.

Potential verification actions:
  expired invite unit test
  expired invite API test
  migration expiry field check
```

### Active Repo Belief Graph

The planner uses the belief graph to know:

* current hypotheses
* uncertain behavior
* weak claims
* contradicted assumptions
* likely fault locations
* selected domains
* confidence levels
* evidence gaps

The belief graph answers:

```text
What do we currently believe?
```

The verification planner answers:

```text
What evidence should we collect next?
```

### Evidence Ledger

Every verification result must create or update evidence.

Evidence must be exact, durable, and linked to claims.

A passing test is not just a green check. It is evidence supporting one or more claims.

A failing test is not just a failure. It is evidence contradicting a claim or supporting a failure hypothesis.

### Verification Matrix

The verification matrix becomes the planner’s execution board.

Each check should have:

* status
* target claim
* target acceptance criterion
* target risk
* command or capability
* evidence produced
* stale status
* reason selected
* reason skipped, if skipped

### Affected-Test Selection

Affected-test selection remains a candidate generator.

It should propose tests based on:

* changed files
* changed symbols
* affected routes
* affected database tables
* related domains
* build graph
* historical failures
* co-change history
* test imports
* coverage links

The Active Verification Planner ranks those candidates by evidence value.

### Risk Model

The risk model adjusts thresholds and required evidence.

For low-risk tasks:

```text
A focused verification set may be enough.
```

For high-risk tasks:

```text
Forge requires stronger evidence, broader verification, and explicit human review where needed.
```

High-risk domains include:

* auth
* permissions
* billing
* payments
* data deletion
* migrations
* cryptography
* concurrency
* public APIs
* privacy
* security
* deployment config
* role mapping
* multi-tenant access
* secrets
* compliance-sensitive flows

### Postgres State Store

The planner requires durable state.

Persist:

* candidate verification actions
* evidence value scores
* selected actions
* action results
* linked claims
* linked acceptance criteria
* linked risks
* historical runtime
* historical flakiness
* historical detection value
* claim confidence updates
* stale verification status

This lets Forge learn over time which checks are valuable in a repo.

## Postgres schema additions

### verification_actions

```sql
create table verification_actions (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  action_type text not null,
  command text,
  capability text,
  status text not null,
  expected_evidence_value numeric,
  selection_reason text,
  estimated_runtime_ms integer,
  estimated_cost text,
  flakiness_risk text,
  setup_cost text,
  evidence_quality text,
  review_usefulness text,
  result_evidence_id uuid references evidence(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### verification_action_claim_links

```sql
create table verification_action_claim_links (
  id uuid primary key,
  verification_action_id uuid not null references verification_actions(id),
  claim_id uuid not null references claims(id),
  link_type text not null,
  expected_confidence_delta numeric,
  actual_confidence_delta numeric,
  created_at timestamptz not null default now(),
  unique (verification_action_id, claim_id, link_type)
);
```

### verification_action_scores

```sql
create table verification_action_scores (
  id uuid primary key,
  verification_action_id uuid not null references verification_actions(id),
  total_score numeric not null,
  claim_importance numeric not null,
  expected_confidence_shift numeric not null,
  risk_weight numeric not null,
  hypothesis_discrimination numeric not null,
  evidence_quality numeric not null,
  review_usefulness numeric not null,
  runtime_penalty numeric not null,
  flakiness_penalty numeric not null,
  setup_penalty numeric not null,
  context_penalty numeric not null,
  explanation text not null,
  created_at timestamptz not null default now()
);
```

### verification_history

```sql
create table verification_history (
  id uuid primary key,
  repo_id uuid not null,
  action_signature text not null,
  action_type text not null,
  command text,
  domain text,
  average_runtime_ms integer,
  failure_rate numeric,
  flake_rate numeric,
  historical_detection_value numeric,
  last_run_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, action_signature)
);
```

## Context Server capabilities

Add the following Context Server capabilities.

### verification.plan_next_action

Returns the next recommended verification action.

Input:

```json
{
  "task_id": "task_123",
  "patch_candidate_id": "patch_456",
  "mode": "balanced"
}
```

Output:

```json
{
  "recommended_action": {
    "id": "action_789",
    "type": "api_test",
    "command": "pnpm test invite-api",
    "expected_evidence_value": 0.84,
    "target_claims": ["claim_invites_expire"],
    "selection_reason": "Highest remaining claim-evidence gap for high-risk invite expiry behavior."
  },
  "alternatives": [],
  "warnings": []
}
```

### verification.list_candidate_actions

Returns all candidate verification actions and scores.

### verification.get_claim_gaps

Returns claims with missing, weak, stale, or contradictory evidence.

### verification.record_action_result

Records the result of a verification action.

### verification.update_claim_confidence

Updates claim confidence based on verification result.

### verification.mark_stale_for_changed_files

Marks checks and claims stale after code changes invalidate prior evidence.

### verification.explain_plan

Explains why Forge selected, skipped, or deferred verification actions.

## TUI requirements

Add an **Active Verification** panel.

It should show:

```text
Current weakest important claim:
  Expired invites cannot be accepted.

Status:
  unverified

Risk:
  high

Recommended next check:
  run invite API expiry tests

Why:
  directly verifies expiry behavior,
  medium cost,
  high evidence quality,
  required for PR completion claim.

Alternative checks:
  migration expiry field test
  unit test for expiry helper
  full e2e invite flow
```

Add a **Claim Evidence Gaps** panel:

```text
Verified:
  Admin can invite user
  Non-admin cannot invite user

Partially verified:
  Invitee can accept invite

Unverified:
  Invite expires after configured duration
  Audit log is written

Needs human review:
  Migration safety for existing production invite rows
```

Add a **Verification Plan Explanation** panel:

```text
Selected:
  auth permission boundary tests

Reason:
  critical risk claim, low runtime, strong behavioral signal.

Deferred:
  full e2e suite

Reason:
  high runtime, broad but lower marginal value until targeted API checks pass.
```

## PR output requirements

The final PR should include an Active Verification Summary.

Example:

```markdown
## Active Verification Summary

Forge selected verification actions based on claim-evidence gaps, risk, expected evidence value, and affected repo areas.

### Verified claims

1. Admins can invite users.
   Evidence:
   - Invite API test passed.
   - Team invitation service unit test passed.

2. Non-admins cannot invite users.
   Evidence:
   - Permission boundary test passed.
   - Auth regression suite passed.

3. Expired invites cannot be accepted.
   Evidence:
   - Expired invite API test passed.
   - Expiry unit test passed.

### Deferred checks

1. Full e2e suite.
   Reason:
   - Lower marginal evidence after targeted API and auth checks passed.
   - Not required by risk policy for this change.

### Human review required

1. Migration behavior for existing production invite rows.
   Reason:
   - Requires production data assumption that Forge cannot verify locally.
```

## Completion gating

Forge cannot mark a task complete unless:

1. Every acceptance criterion maps to one or more claims.
2. Every claim is verified, explicitly unverified, not applicable, stale, contradicted, or marked as needing human review.
3. High-risk claims satisfy the required evidence threshold.
4. Contradicted claims block completion unless resolved or marked out of scope by a human.
5. Stale checks are rerun or explicitly justified as not required.
6. Every skipped high-value verification action has a recorded reason.
7. The final PR includes a claim-evidence verification summary.

## Risk-based thresholds

Example thresholds:

```yaml
risk_thresholds:
  low:
    required_status: verified_or_not_applicable
    minimum_evidence_quality: medium
    human_review_required: false

  medium:
    required_status: verified
    minimum_evidence_quality: medium
    human_review_required: false

  high:
    required_status: verified
    minimum_evidence_quality: high
    human_review_required: conditional

  critical:
    required_status: verified
    minimum_evidence_quality: high
    human_review_required: true_if_external_assumptions_remain
```

## Stale verification rules

Verification becomes stale when:

* a file changes after its related test passed
* a symbol used by a verified claim changes
* a dependency of a verified route changes
* a migration changes after migration tests passed
* a patch candidate is replaced
* a domain expansion introduces new affected behavior
* a human decision changes acceptance criteria
* a failure contradicts a previously verified claim

When stale, Forge must either rerun the check, replace the evidence, or mark the claim as needing human review.

## Implementation plan

### Phase 1: Candidate action generation

Build candidate verification actions from:

* acceptance criteria
* touched files
* repo graph
* affected-test selection
* domain map
* risk model
* current claims
* current hypotheses

### Phase 2: Evidence Value Scorer

Add deterministic scoring:

```text
claim importance
+ risk weight
+ expected confidence shift
+ hypothesis discrimination
+ evidence quality
+ review usefulness
- runtime cost
- flakiness cost
- setup cost
- context cost
```

The score should produce an explanation.

### Phase 3: Claim confidence updates

After each action, update:

* claim status
* claim confidence
* verification matrix
* evidence ledger
* belief graph
* stale checks
* remaining evidence gaps

### Phase 4: TUI integration

Add:

* Active Verification panel
* Claim Evidence Gaps panel
* Verification Plan Explanation panel
* Stale Checks panel

### Phase 5: PR integration

Generate verification summary from durable state.

### Phase 6: Historical learning

Use the Postgres State Store to track:

* runtime
* failure rate
* flake rate
* detection value
* claim coverage
* review usefulness
* repeated value across similar tasks

Over time, use this to calibrate the Evidence Value Score per repo.

## Acceptance criteria

This feature is complete when:

1. Forge can enumerate candidate verification actions for a task.
2. Each verification action is linked to claims, acceptance criteria, risks, and hypotheses.
3. Forge scores candidate actions by expected evidential value.
4. Forge selects the next verification action with an explanation.
5. Forge records verification results as evidence.
6. Forge updates claim status and confidence after verification results.
7. Forge marks stale checks when later changes invalidate prior evidence.
8. Forge blocks completion on unresolved high-risk claim-evidence gaps.
9. Forge records skipped high-value checks with reasons.
10. Forge exposes active verification state in the TUI.
11. Forge includes a claim-driven verification summary in the PR.
12. Verification action history is stored in Postgres.
13. Forge can learn per-repo runtime, flakiness, and detection value over time.
14. The system improves verified completion per dollar compared with affected-test selection alone.

## Evaluation plan

Compare:

```text
Forge with affected-test selection only
vs.
Forge with Active Verification Planner
```

Use the same model, repo, task, and cost budget.

Task classes:

* auth permission bug
* billing webhook change
* migration plus backend API change
* frontend plus backend feature
* review comment resolution
* CI failure repair
* production bug investigation
* framework upgrade
* long-running refactor
* multi-domain feature implementation

Metrics:

* verified completion rate
* cost per verified task
* runtime to credible verification
* number of unverified claims in final PR
* number of stale claims caught
* number of high-risk gaps caught
* irrelevant tests run
* missed affected tests
* reviewer confidence
* review comment count
* regression rate
* failure recovery success
* evidence coverage per claim

Expected result:

Forge should produce stronger claim-evidence coverage with less wasted verification effort and fewer unsafe completion claims.

## Product positioning

Active Verification Planner strengthens Forge’s core market position:

```text
Forge is the long-horizon engineering harness that lets an agent own a task from ticket to verified PR.
```

The differentiator is not just that Forge runs tests.

The differentiator is that Forge knows:

* which claims need evidence
* which evidence is missing
* which check is most valuable next
* which checks are stale
* which risks require stronger proof
* when human review is required
* why the PR is safe to review

Product-facing claim:

```text
Forge does not stop at green tests. It builds a claim-evidence verification plan and actively chooses the checks that prove the PR is ready.
```

Technical positioning:

```text
A claim-driven, belief-aware, risk-weighted active verification planner for long-horizon software-engineering agents.
```

Strategic positioning:

```text
The verification intelligence layer for task-owning coding agents.
```

## Final recommendation

Build Active Verification Planner as a core Forge system.

It should sit between:

```text
Acceptance Contract
Active Repo Belief Graph
Affected-Test Selection
Risk Model
Evidence Ledger
Verification Matrix
Postgres State Store
PR Layer
```

This system converts verification from a passive checklist into an active evidence-gathering loop.

That is a major improvement over ordinary affected-test selection and a strong fit for Forge’s core promise: verified, reviewable PRs from long-horizon autonomous engineering work.
