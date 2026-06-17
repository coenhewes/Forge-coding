/**
 * PR generator tests — exercise the belief + verification-state aware API
 * (`generatePRSummary`) end-to-end with three real-shaped fixtures:
 *
 *  1. clean-task           — all claims verified, no stale, no human review
 *  2. stale-claims         — one claim invalidated by a file edit
 *  3. high-risk-domain     — auth/billing task with contradicted claims,
 *                            open human-review requirements, security_review
 *                            verification action, and explicit human approval
 *
 * Each test asserts the output structure (sections, meta, body) — not
 * hand-rolled expected strings — so a regression in section ordering or
 * field population shows up here.
 */
import { describe, it, expect } from 'vitest'
import { generatePRSummary } from '@forge/pr'
import type {
  AcceptanceContract,
  Checkpoint,
  DecisionEntry,
  EvidenceEntry,
  FailureEntry,
  PatchCandidate,
  TaskState,
  VerificationEntry,
  TaskBeliefState,
  ActiveVerificationPlan,
  TaskRiskAssessment,
} from '@forge/types'
import type { ClaimEvidenceGraph } from '@forge/belief'
import type { ArtifactRef } from '@forge/pr'

const SECTIONS = [
  'acceptance',
  'claim-evidence',
  'active-verification',
  'failures',
  'decisions',
  'risk-review',
  'changed-domains',
  'human-review',
  'reviewer-guide',
  'artifacts',
] as const

function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: 't-fixture',
    originalRequest: 'Add team invitations with roles, expiry, audit logs',
    currentInterpretation: 'Add team invitations with roles, expiry, audit logs',
    status: 'implementing',
    acceptanceCriteria: [],
    assumptions: [],
    openQuestions: [],
    subtasks: [],
    dependencies: [],
    completedWork: [],
    remainingWork: [],
    filesTouched: [],
    commandsRun: [],
    testsRun: [],
    failuresEncountered: [],
    decisionsMade: [],
    risks: [],
    verificationStatus: {},
    evidenceLinks: [],
    failedHypotheses: [],
    patchCandidates: [],
    reviewBlockers: [],
    nextAction: 'continue',
    updatedAt: '2026-06-17T00:00:00.000Z',
    createdAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function makeContract(criteria: Array<{ id: string; status: AcceptanceContract['criteria'][number]['status']; description: string; riskArea?: string }>): AcceptanceContract {
  return {
    taskId: 't-fixture',
    description: 'Acceptance contract for team invitations',
    criteria: criteria.map((c) => ({
      id: c.id,
      description: c.description,
      status: c.status,
      evidenceRefs: [],
      riskArea: c.riskArea,
    })),
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
  }
}

function makeBelief(overrides: Partial<TaskBeliefState> = {}): TaskBeliefState {
  return {
    taskId: 't-fixture',
    repoId: 't-fixture',
    goal: 'Add team invitations with roles, expiry, audit logs',
    acceptanceCriteria: [],
    selectedDomains: [],
    selectedGraphRegions: [],
    hypotheses: [],
    claims: [],
    assumptions: [],
    uncertainties: [],
    evidenceRefs: [],
    contradictions: [],
    nodes: [],
    edges: [],
    verificationObligations: [],
    humanReviewRequirements: [],
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function makeClaim(overrides: Partial<TaskBeliefState['claims'][number]>): TaskBeliefState['claims'][number] {
  return {
    id: 'c-1',
    text: 'sample claim',
    status: 'verified',
    confidence: 0.9,
    riskLevel: 'medium',
    acceptanceCriterionRefs: [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    ...overrides,
  }
}

function makeHypothesis(overrides: Partial<TaskBeliefState['hypotheses'][number]>): TaskBeliefState['hypotheses'][number] {
  return {
    id: 'h-1',
    claim: 'sample hypothesis',
    status: 'plausible',
    confidence: 0.6,
    relevantDomains: [],
    relevantGraphNodes: [],
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function makeGraph(overrides: Partial<ClaimEvidenceGraph>): ClaimEvidenceGraph {
  return {
    taskId: 't-fixture',
    topClaim: 'top claim',
    generatedAt: '2026-06-17T00:00:00.000Z',
    verifiedClaims: [],
    unverifiedClaims: [],
    contradictedClaims: [],
    staleClaims: [],
    needsHumanReview: [],
    disprovenHypotheses: [],
    openHypotheses: [],
    reviewerGuidance: [],
    ...overrides,
  }
}

function makePlan(overrides: Partial<ActiveVerificationPlan>): ActiveVerificationPlan {
  return {
    taskId: 't-fixture',
    candidateActions: [],
    scores: [],
    claimGaps: [],
    warnings: [],
    generatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function makeRisk(overrides: Partial<TaskRiskAssessment>): TaskRiskAssessment {
  return {
    level: 'low',
    requiresMoreEvidence: false,
    requiresMoreVerification: false,
    requiresConservativeEdits: false,
    requiresMoreCheckpoints: false,
    requiresExplicitHumanApproval: false,
    requiresClearerWarnings: false,
    requiresStrongerReviewGuidance: false,
    notes: [],
    ...overrides,
  }
}

function makeArtifacts(): ArtifactRef[] {
  return [
    {
      id: 'sha-abc',
      kind: 'test_output',
      path: 'artifacts/test-output.txt',
      title: 'Invite expiry test output',
      summary: 'Failed test run before fix; green after fix',
    },
    {
      id: 'sha-def',
      kind: 'command_output',
      path: 'artifacts/permission-check.log',
      title: 'Permission check log',
    },
  ]
}

// ---------------------------------------------------------------------------
// Fixture 1 — clean task (all verified)
// ---------------------------------------------------------------------------

async function runCleanFixture() {
  const verifiedClaim = makeClaim({
    id: 'c-admin',
    text: 'Admin can create an invitation',
    status: 'verified',
    confidence: 0.95,
    riskLevel: 'medium',
    acceptanceCriterionRefs: ['ac-1'],
    supportingEvidence: [{ id: 'e1', summary: 'admin-invite test passed', artifactRef: 'sha-abc' }],
  })
  const memberClaim = makeClaim({
    id: 'c-member',
    text: 'Member cannot create an invitation',
    status: 'verified',
    confidence: 0.95,
    riskLevel: 'high',
    acceptanceCriterionRefs: ['ac-2'],
  })
  const expiryClaim = makeClaim({
    id: 'c-expiry',
    text: 'Expired invite cannot be accepted',
    status: 'verified',
    confidence: 0.9,
    riskLevel: 'medium',
    acceptanceCriterionRefs: ['ac-3'],
  })
  const topHyp = makeHypothesis({ id: 'h-impl', claim: 'Implement invite route via permissions helper', confidence: 0.92, status: 'likely' })
  const plan = makePlan({
    candidateActions: [
      {
        id: 'va-1',
        taskId: 't-fixture',
        actionType: 'unit_test',
        command: 'pnpm test src/auth/invitations.test.ts',
        targetClaims: ['c-admin', 'c-member', 'c-expiry'],
        targetAcceptanceCriteria: ['ac-1', 'ac-2', 'ac-3'],
        targetHypotheses: ['h-impl'],
        targetRisks: [],
        expectedEvidenceValue: 0.9,
        selectionReason: 'Verifies permission boundary at unit level',
        status: 'passed',
        resultEvidenceId: 'e1',
      },
      {
        id: 'va-2',
        taskId: 't-fixture',
        actionType: 'security_check',
        command: 'pnpm audit',
        targetClaims: ['c-member'],
        targetAcceptanceCriteria: ['ac-2'],
        targetHypotheses: ['h-impl'],
        targetRisks: [],
        expectedEvidenceValue: 0.6,
        selectionReason: 'Standard pre-merge security check',
        status: 'passed',
      },
    ],
  })
  return generatePRSummary({
    task: makeTaskState({
      filesTouched: ['src/auth/invitations.ts', 'src/db/schema.ts', 'tests/auth/invitations.test.ts'],
    }),
    contract: makeContract([
      { id: 'ac-1', status: 'verified', description: 'Admin can create an invite' },
      { id: 'ac-2', status: 'verified', description: 'Non-admin cannot create an invite' },
      { id: 'ac-3', status: 'verified', description: 'Expired invite cannot be accepted' },
    ]),
    verification: [
      { check: 'pnpm test', status: 'passed' },
      { check: 'pnpm lint', status: 'passed' },
    ],
    evidence: [
      { id: 'e1', claim: 'admin invite test', evidence: ['test passed'], unverified: [], status: 'verified', kind: 'test_result', referencableId: 'e1', timestamp: '2026-06-17T00:00:00.000Z' },
    ],
    failures: [],
    decisions: [
      {
        id: 'd-1',
        decision: 'Normalize role checks via existing permissions helper',
        rationale: 'Avoid duplicating role logic across invite routes',
        alternativesRejected: ['inline check in route handler', 'new policy module'],
        verificationRequired: ['unit test for non-admin path'],
        author: 'agent',
        timestamp: '2026-06-17T00:00:00.000Z',
      } as DecisionEntry,
    ],
    checkpoints: [
      {
        id: 'cp-1',
        hypothesis: 'use permissions helper',
        filesChanged: ['src/auth/invitations.ts'],
        reason: 'first patch attempt',
        verificationStatus: 'passed',
        riskAssessment: 'medium',
        promotionDecision: 'promoted',
        childCheckpointIds: [],
        createdAt: '2026-06-17T00:00:00.000Z',
      } as Checkpoint,
    ],
    patches: [
      {
        id: 'pc-1',
        checkpointId: 'cp-1',
        hypothesis: 'use permissions helper',
        diff: 'diff --git a/src/auth/invitations.ts ...',
        filesChanged: [{ path: 'src/auth/invitations.ts', changeType: 'modify', hunks: 4 }],
        testResults: [{ suite: 'invitations', passed: 3, failed: 0, skipped: 0 }],
        verificationOutcome: 'passed',
        riskScore: 0.3,
        promoted: true,
        timestamp: '2026-06-17T00:00:00.000Z',
      } as PatchCandidate,
    ],
    belief: makeBelief({
      selectedDomains: [
        { domain: 'auth', confidence: 0.9, reason: 'invite permission checks' },
        { domain: 'database', confidence: 0.7, reason: 'invite table + expiry column' },
        { domain: 'tests', confidence: 0.85, reason: 'unit + api test coverage' },
      ],
      hypotheses: [topHyp],
      claims: [verifiedClaim, memberClaim, expiryClaim],
    }),
    claimEvidenceGraph: makeGraph({
      topClaim: 'Admin can create an invitation',
      verifiedClaims: [
        { claim: verifiedClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.95, status: 'verified' },
        { claim: memberClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.95, status: 'verified' },
        { claim: expiryClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.9, status: 'verified' },
      ],
    }),
    activeVerification: plan,
    artifactRefs: makeArtifacts(),
    riskAssessment: makeRisk({ level: 'medium', notes: ['Touches auth domain'] }),
  })
}

// ---------------------------------------------------------------------------
// Fixture 2 — task with stale claims
// ---------------------------------------------------------------------------

async function runStaleFixture() {
  const verifiedClaim = makeClaim({
    id: 'c-1',
    text: 'Invite route uses permission helper',
    status: 'verified',
    confidence: 0.8,
    riskLevel: 'medium',
    staleReason: 'src/auth/permissions.ts edited after verification',
  })
  const staleClaim = makeClaim({
    id: 'c-2',
    text: 'Expiry column exists on invite table',
    status: 'stale',
    confidence: 0.5,
    riskLevel: 'high',
    staleReason: 'src/db/schema.ts edited after verification',
  })
  return generatePRSummary({
    task: makeTaskState({
      filesTouched: ['src/auth/invitations.ts', 'src/db/schema.ts'],
    }),
    contract: makeContract([
      { id: 'ac-1', status: 'verified', description: 'Invite route delegates to permissions helper' },
      { id: 'ac-2', status: 'failed', description: 'Expiry column migration applied' },
    ]),
    verification: [{ check: 'pnpm test', status: 'failed', notes: 'migration check failed' }],
    evidence: [],
    failures: [
      {
        id: 'f-1',
        hypothesis: 'Migration ran cleanly in test DB',
        action: 'ran pnpm migrate',
        result: 'migration check failed',
        lesson: 'test DB schema drift',
        nextHypothesis: 'Recreate test DB from scratch',
        evidenceRefs: [],
        timestamp: '2026-06-17T00:00:00.000Z',
      } as FailureEntry,
    ],
    decisions: [],
    checkpoints: [],
    patches: [],
    belief: makeBelief({
      selectedDomains: [
        { domain: 'auth', confidence: 0.6, reason: 'permissions helper touched' },
        { domain: 'database', confidence: 0.5, reason: 'schema change' },
      ],
      claims: [verifiedClaim, staleClaim],
    }),
    claimEvidenceGraph: makeGraph({
      topClaim: 'Invite route uses permission helper',
      verifiedClaims: [
        { claim: verifiedClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.8, status: 'verified' },
      ],
      staleClaims: [
        { claim: staleClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.5, status: 'stale' },
      ],
    }),
    activeVerification: makePlan({
      candidateActions: [
        {
          id: 'va-1',
          taskId: 't-fixture',
          actionType: 'migration_up_check',
          command: 'pnpm migrate:up',
          targetClaims: ['c-2'],
          targetAcceptanceCriteria: ['ac-2'],
          targetHypotheses: [],
          targetRisks: [],
          expectedEvidenceValue: 0.8,
          selectionReason: 'Re-verify migration after schema edit',
          status: 'failed',
        },
      ],
      warnings: ['Claim c-2 is stale; re-verify before merge'],
    }),
    artifactRefs: [makeArtifacts()[1]],
    riskAssessment: makeRisk({
      level: 'high',
      requiresMoreVerification: true,
      requiresStrongerReviewGuidance: true,
      notes: ['Database schema drift detected'],
    }),
  })
}

// ---------------------------------------------------------------------------
// Fixture 3 — high-risk domain with contradicted claims + human review
// ---------------------------------------------------------------------------

async function runHighRiskFixture() {
  const contradictedClaim = makeClaim({
    id: 'c-billing',
    text: 'Billing webhook handler is idempotent',
    status: 'contradicted',
    confidence: 0.3,
    riskLevel: 'critical',
    contradictingEvidence: [
      { id: 'ev-1', summary: 'duplicate-charge repro' },
    ],
  })
  const humanReviewClaim = makeClaim({
    id: 'c-roles',
    text: 'SSO role alias mapping is exhaustive',
    status: 'needs_human_review',
    confidence: 0.6,
    riskLevel: 'critical',
    reviewerGuidance: 'Confirm role mapping with security team',
  })
  const verifiedClaim = makeClaim({
    id: 'c-audit',
    text: 'Audit log records role changes',
    status: 'verified',
    confidence: 0.85,
    riskLevel: 'high',
  })
  return generatePRSummary({
    task: makeTaskState({
      filesTouched: [
        'src/billing/webhook.ts',
        'src/auth/permissions.ts',
        'src/auth/sso.ts',
        'src/audit/log.ts',
      ],
    }),
    contract: makeContract([
      { id: 'ac-1', status: 'failed', description: 'Billing webhook is idempotent', riskArea: 'billing' },
      { id: 'ac-2', status: 'needs_review', description: 'SSO role mapping covers all providers', riskArea: 'security' },
      { id: 'ac-3', status: 'verified', description: 'Audit log captures role changes', riskArea: 'audit' },
    ]),
    verification: [
      { check: 'pnpm test', status: 'failed' },
      { check: 'security review', status: 'needs_human_review' },
    ],
    evidence: [
      { id: 'ev-1', claim: 'webhook idempotency', evidence: ['repro: double-charge'], unverified: [], status: 'needs_review', kind: 'runtime_output', referencableId: 'ev-1', timestamp: '2026-06-17T00:00:00.000Z' },
    ],
    failures: [
      {
        id: 'f-1',
        hypothesis: 'idempotency_key column prevents duplicates',
        action: 'applied unique index',
        result: 'duplicate charge still observed',
        lesson: 'race condition in webhook handler',
        nextHypothesis: 'add distributed lock on webhook ingestion',
        evidenceRefs: ['ev-1'],
        timestamp: '2026-06-17T00:00:00.000Z',
      } as FailureEntry,
    ],
    decisions: [
      {
        id: 'd-1',
        decision: 'Add distributed lock for webhook ingestion',
        rationale: 'DB unique index insufficient under concurrent retries',
        alternativesRejected: ['advisory lock', 'idempotency window'],
        verificationRequired: ['integration test for concurrent webhooks'],
        domain: 'billing',
        author: 'agent',
        timestamp: '2026-06-17T00:00:00.000Z',
      } as DecisionEntry,
    ],
    checkpoints: [
      {
        id: 'cp-1',
        hypothesis: 'DB unique index on idempotency_key',
        filesChanged: ['src/billing/webhook.ts'],
        reason: 'first attempt',
        verificationStatus: 'failed',
        riskAssessment: 'critical',
        promotionDecision: 'rejected',
        failureReason: 'duplicate charge repro',
        childCheckpointIds: [],
        createdAt: '2026-06-17T00:00:00.000Z',
      } as Checkpoint,
    ],
    patches: [],
    belief: makeBelief({
      selectedDomains: [
        { domain: 'billing', confidence: 0.7, reason: 'webhook handler changed' },
        { domain: 'auth', confidence: 0.8, reason: 'SSO + permissions' },
        { domain: 'security', confidence: 0.9, reason: 'role mapping' },
        { domain: 'tests', confidence: 0.6, reason: 'concurrent webhook test' },
      ],
      claims: [contradictedClaim, humanReviewClaim, verifiedClaim],
      humanReviewRequirements: [
        { id: 'hrr-1', reason: 'Confirm SSO role alias coverage', relatedClaims: ['c-roles'], riskLevel: 'critical', status: 'open' },
      ],
      uncertainties: [
        { id: 'u-1', text: 'Are all SSO providers enumerated?', relatedHypotheses: [], recommendedProbeIds: [], riskLevel: 'high' },
      ],
    }),
    claimEvidenceGraph: makeGraph({
      topClaim: 'Billing webhook is idempotent',
      verifiedClaims: [
        { claim: verifiedClaim, supportingEvidence: [], contradictingEvidence: [], confidence: 0.85, status: 'verified' },
      ],
      contradictedClaims: [
        {
          claim: contradictedClaim,
          supportingEvidence: [],
          contradictingEvidence: [{ id: 'ev-1', summary: 'duplicate-charge repro', polarity: 'contradicts', createdAt: '2026-06-17T00:00:00.000Z' }],
          confidence: 0.3,
          status: 'contradicted',
        },
      ],
      needsHumanReview: [
        {
          claim: humanReviewClaim,
          supportingEvidence: [],
          contradictingEvidence: [],
          confidence: 0.6,
          status: 'needs_human_review',
        },
      ],
      reviewerGuidance: [
        'Resolve contradiction on claim "Billing webhook handler is idempotent"',
        'Confirm role mapping with security team',
      ],
    }),
    activeVerification: makePlan({
      candidateActions: [
        {
          id: 'va-1',
          taskId: 't-fixture',
          actionType: 'integration_test',
          command: 'pnpm test:billing-webhook-concurrent',
          targetClaims: ['c-billing'],
          targetAcceptanceCriteria: ['ac-1'],
          targetHypotheses: [],
          targetRisks: ['billing'],
          expectedEvidenceValue: 0.95,
          selectionReason: 'Direct evidence for idempotency under concurrency',
          status: 'running',
        },
        {
          id: 'va-2',
          taskId: 't-fixture',
          actionType: 'security_check',
          command: 'pnpm security:review --sso',
          targetClaims: ['c-roles'],
          targetAcceptanceCriteria: ['ac-2'],
          targetHypotheses: [],
          targetRisks: ['security'],
          expectedEvidenceValue: 0.8,
          selectionReason: 'Mandatory security review for high-risk auth change',
          status: 'selected',
        },
        {
          id: 'va-3',
          taskId: 't-fixture',
          actionType: 'manual_human_review',
          command: 'security-team-review',
          targetClaims: ['c-roles'],
          targetAcceptanceCriteria: ['ac-2'],
          targetHypotheses: [],
          targetRisks: ['security'],
          expectedEvidenceValue: 0.5,
          selectionReason: 'Hard gate: SSO mapping requires human sign-off',
          status: 'needs_human_review',
        },
      ],
    }),
    artifactRefs: makeArtifacts(),
    riskAssessment: makeRisk({
      level: 'critical',
      requiresMoreEvidence: true,
      requiresMoreVerification: true,
      requiresConservativeEdits: true,
      requiresMoreCheckpoints: true,
      requiresExplicitHumanApproval: true,
      requiresClearerWarnings: true,
      requiresStrongerReviewGuidance: true,
      notes: ['Billing + security touched', 'One claim contradicted', 'SSO mapping needs human sign-off'],
    }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generatePRSummary', () => {
  it('fixture 1 (clean task): produces 10 sections in prescribed order with all claims verified', async () => {
    const out = await runCleanFixture()

    expect(out.title).toMatch(/team invitations/i)
    expect(out.summary.split('\n').length).toBeLessThanOrEqual(8)

    // Section ordering
    expect(out.sections.map((s) => s.id)).toEqual([...SECTIONS])

    // Meta — no risk flags, no human review, no stale
    expect(out.meta.acceptedCount).toBe(3)
    expect(out.meta.totalCriteria).toBe(3)
    expect(out.meta.riskLevel).toBe('medium')
    expect(out.meta.hasStaleClaims).toBe(false)
    expect(out.meta.hasContradictedClaims).toBe(false)
    expect(out.meta.hasHumanReviewItems).toBe(false)
    expect(out.meta.topHypothesisConfidence).toBeCloseTo(0.92, 2)
    expect(out.meta.artifactCount).toBe(2)

    // Body composition
    expect(out.body).toContain('# ' + out.title)
    expect(out.body).toContain('## Acceptance status')
    expect(out.body).toContain('## Claim-Evidence Summary')
    expect(out.body).toContain('## Active Verification Summary')
    expect(out.body).toContain('## Failed Hypotheses and Recovery')
    expect(out.body).toContain('## Decisions Ledger')
    expect(out.body).toContain('## Risk Review Guide')
    expect(out.body).toContain('## Changed Domains')
    expect(out.body).toContain('## Human Review Required')
    expect(out.body).toContain('## Reviewer Guide')
    expect(out.body).toContain('## Exact Artifact References')

    // Body content — clean task has no stale, no contradicted, no human review
    expect(out.body).toContain('Admin can create an invite')
    expect(out.body).toContain('Verified')
    expect(out.body).not.toContain('### Contradicted')
    expect(out.body).not.toContain('### Stale')
    expect(out.body).toContain('_No human review items flagged._')

    // Promoted patch is surfaced
    expect(out.promotedPatch?.id).toBe('pc-1')
  })

  it('fixture 2 (stale claims): surfaces the stale claim and the related failure', async () => {
    const out = await runStaleFixture()

    expect(out.meta.hasStaleClaims).toBe(true)
    expect(out.meta.hasContradictedClaims).toBe(false)
    expect(out.meta.riskLevel).toBe('high')
    expect(out.meta.riskFlags.requiresMoreVerification).toBe(true)
    expect(out.meta.riskFlags.requiresStrongerReviewGuidance).toBe(true)
    expect(out.meta.acceptedCount).toBe(1)
    expect(out.meta.totalCriteria).toBe(2)

    // The stale claim should be surfaced in the Claim-Evidence section.
    const claimSec = out.sections.find((s) => s.id === 'claim-evidence')!
    expect(claimSec.markdown).toContain('### Stale')
    expect(claimSec.markdown).toContain('Expiry column exists on invite table')

    // Active verification surfaces the failing migration_up_check
    const verifySec = out.sections.find((s) => s.id === 'active-verification')!
    expect(verifySec.markdown).toContain('migration_up_check')
    expect(verifySec.markdown).toMatch(/re-verify migration/i)

    // Failure ledger surfaces the failure
    const failSec = out.sections.find((s) => s.id === 'failures')!
    expect(failSec.markdown).toContain('test DB schema drift')

    // Risk review surfaces the requiresMoreVerification safeguard
    const riskSec = out.sections.find((s) => s.id === 'risk-review')!
    expect(riskSec.markdown).toContain('**Overall risk: `high`**')
    expect(riskSec.markdown).toContain('more verification')
  })

  it('fixture 3 (high-risk domain): surfaces contradicted, needs-review, security review, and human approval', async () => {
    const out = await runHighRiskFixture()

    // Meta — every risk flag should be on
    expect(out.meta.riskLevel).toBe('critical')
    expect(out.meta.riskFlags.requiresMoreEvidence).toBe(true)
    expect(out.meta.riskFlags.requiresMoreVerification).toBe(true)
    expect(out.meta.riskFlags.requiresConservativeEdits).toBe(true)
    expect(out.meta.riskFlags.requiresMoreCheckpoints).toBe(true)
    expect(out.meta.riskFlags.requiresExplicitHumanApproval).toBe(true)
    expect(out.meta.riskFlags.requiresClearerWarnings).toBe(true)
    expect(out.meta.riskFlags.requiresStrongerReviewGuidance).toBe(true)
    expect(out.meta.hasContradictedClaims).toBe(true)
    expect(out.meta.hasNeedsHumanReviewClaims).toBe(true)
    expect(out.meta.hasHumanReviewItems).toBe(true)
    expect(out.meta.topHypothesisConfidence).toBe(0)
    expect(out.meta.acceptedCount).toBe(1)
    expect(out.meta.totalCriteria).toBe(3)

    // Claim-Evidence surfaces contradicted, needs_review, and verified buckets
    const claimSec = out.sections.find((s) => s.id === 'claim-evidence')!
    expect(claimSec.markdown).toContain('### Contradicted')
    expect(claimSec.markdown).toContain('Billing webhook handler is idempotent')
    expect(claimSec.markdown).toContain('### Needs human review')
    expect(claimSec.markdown).toContain('SSO role alias mapping is exhaustive')
    expect(claimSec.markdown).toContain('### Verified')
    expect(claimSec.markdown).toContain('Audit log records role changes')

    // Active verification surfaces the security_check and manual_human_review
    const verifySec = out.sections.find((s) => s.id === 'active-verification')!
    expect(verifySec.markdown).toContain('security_check')
    expect(verifySec.markdown).toContain('manual_human_review')
    expect(verifySec.markdown).toContain('integration_test')

    // Human review checklist is non-empty
    const humanSec = out.sections.find((s) => s.id === 'human-review')!
    expect(humanSec.markdown).toMatch(/- \[ \] /)
    expect(humanSec.markdown).toContain('SSO role alias')
    expect(humanSec.markdown).toContain('explicit human approval before merge')

    // Risk review guide surfaces every active flag
    const riskSec = out.sections.find((s) => s.id === 'risk-review')!
    expect(riskSec.markdown).toContain('explicit human approval')
    expect(riskSec.markdown).toContain('more evidence')
    expect(riskSec.markdown).toContain('conservative edits')
    expect(riskSec.markdown).toContain('more checkpoints')

    // Reviewer guide mentions promoted patch absent + uncertainty + human approval
    const guideSec = out.sections.find((s) => s.id === 'reviewer-guide')!
    expect(guideSec.markdown).toContain('No patch was promoted')
    expect(guideSec.markdown).toContain('explicit human approval')
    expect(guideSec.markdown).toContain('Are all SSO providers enumerated?')

    // Changed domains — belief surfaces billing/auth/security/tests
    const domainsSec = out.sections.find((s) => s.id === 'changed-domains')!
    expect(domainsSec.markdown).toContain('billing')
    expect(domainsSec.markdown).toContain('auth')
    expect(domainsSec.markdown).toContain('security')

    // No patch promoted
    expect(out.promotedPatch).toBeUndefined()
  })

  it('renders PR body when all optional ledgers are empty', async () => {
    const out = await generatePRSummary({
      task: makeTaskState(),
      contract: undefined,
      verification: [],
      evidence: [],
      failures: [],
      decisions: [],
      checkpoints: [],
      patches: [],
      belief: makeBelief(),
      claimEvidenceGraph: makeGraph({}),
      activeVerification: makePlan({}),
      artifactRefs: [],
      riskAssessment: makeRisk({}),
    })
    expect(out.sections).toHaveLength(SECTIONS.length)
    expect(out.body).toContain('## Acceptance status')
    expect(out.body).toContain('## Exact Artifact References')
    expect(out.meta.artifactCount).toBe(0)
    expect(out.meta.topHypothesisConfidence).toBe(0)
  })
})
