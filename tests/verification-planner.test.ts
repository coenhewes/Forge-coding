import { describe, it, expect, beforeEach } from 'vitest'
import {
  ActiveVerificationPlanner,
  EvidenceValueScorer,
  applyConfidenceDelta,
  applyResultsToClaims,
  canCompleteAfterHumanReview,
  evaluateCompletion,
  findStaleClaimsForFiles,
  markHumanReview,
  recordActionResult,
  markStaleForChangedFiles,
  updateBeliefGraph,
  type ActionResult,
  type MarkStaleForChangedFilesInput,
  type RecordActionResultInput,
} from '@forge/verification-planner'
import type {
  Claim,
  ClaimVerificationState,
  EvidenceRef,
  GraphEdge,
  GraphNode,
  Hypothesis,
  RepoGraph,
  TaskBeliefState,
  Uncertainty,
  VerificationAction,
} from '@forge/types'
import type { TxContext } from '@forge/state-store'

/**
 * Tests for the active verification planner.
 *
 * These tests intentionally avoid Postgres — they exercise the pure
 * helpers (`evaluateCompletion`, `findStaleClaimsForFiles`,
 * `applyConfidenceDelta`, `applyResultsToClaims`, etc.) directly and
 * stub the state-store `TxContext` for the persistence-bound code
 * paths so the suite stays hermetic.
 */

function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'claim:x',
    text: 'sample claim',
    status: 'unverified',
    confidence: 0.3,
    riskLevel: 'medium',
    acceptanceCriterionRefs: ['c1'],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    ...over,
  }
}

function makeHypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    claim: 'a hypothesis',
    status: 'plausible',
    confidence: 0.5,
    relevantDomains: ['auth'],
    relevantGraphNodes: [],
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

function makeUncertainty(over: Partial<Uncertainty> = {}): Uncertainty {
  return {
    id: 'u1',
    text: 'permission boundary unclear',
    relatedHypotheses: [],
    recommendedProbeIds: [],
    riskLevel: 'high',
    ...over,
  }
}

function makeAction(over: Partial<VerificationAction> = {}): VerificationAction {
  return {
    id: 'verification:task-1:unit_test:claim-x',
    taskId: 'task-1',
    actionType: 'unit_test',
    targetClaims: ['claim:x'],
    targetAcceptanceCriteria: ['c1'],
    targetHypotheses: [],
    targetRisks: ['medium'],
    expectedEvidenceValue: 0,
    selectionReason: 'sample',
    status: 'candidate',
    ...over,
  }
}

function makeGraph(): RepoGraph {
  const nodes: GraphNode[] = [
    { id: 'n1', type: 'file', name: 'src/auth/permissions.ts', path: 'src/auth/permissions.ts' },
    { id: 'n2', type: 'file', name: 'src/api/invites.ts', path: 'src/api/invites.ts' },
    { id: 'n3', type: 'file', name: 'tests/permissions.test.ts', path: 'tests/permissions.test.ts' },
  ]
  const edges: GraphEdge[] = [
    { source: 'n1', target: 'n2', type: 'imports' },
    { source: 'n3', target: 'n1', type: 'tests' },
  ]
  return { nodes, edges, regions: [], symbolDefinitions: [], symbolReferences: [], callSites: [] }
}

describe('ActiveVerificationPlanner', () => {
  let planner: ActiveVerificationPlanner
  beforeEach(() => {
    planner = new ActiveVerificationPlanner()
  })

  it('returns candidates for a sample-saas invitation task with a security review in the top 3 for auth claims', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'claim:admin_can_invite', text: 'Admin can invite a user', riskLevel: 'high', status: 'unverified', confidence: 0.2 }),
      makeClaim({ id: 'claim:non_admin_blocked', text: 'Non-admin cannot invite users', riskLevel: 'critical', status: 'unverified', confidence: 0.5 }),
      makeClaim({ id: 'claim:invite_expires', text: 'Invite expires after configured duration', riskLevel: 'high', status: 'unverified', confidence: 0.3 }),
    ]
    const plan = planner.plan({
      taskId: 'task-invites',
      claims,
      filesChanged: ['src/auth/permissions.ts', 'src/api/invites.ts'],
      commands: { test: 'pnpm test' },
    })
    expect(plan.candidateActions.length).toBeGreaterThan(0)
    expect(plan.recommendedAction).toBeDefined()

    // Top 3 actions should include a security/review action.
    const top3 = plan.candidateActions.slice(0, 3)
    const hasSecurityOrReview = top3.some(
      (a) =>
        a.actionType === 'security_check' ||
        a.actionType === 'manual_human_review' ||
        a.actionType === 'permission_boundary_check' ||
        a.actionType === 'reviewer_confirmation',
    )
    expect(hasSecurityOrReview).toBe(true)

    // Every candidate must reference at least one claim id and a reason.
    for (const action of plan.candidateActions) {
      expect(action.id).toMatch(/^verification:/)
      expect(action.selectionReason).toBeTruthy()
      expect(action.targetClaims.length).toBeGreaterThan(0)
    }

    // All scores must be deterministic numbers.
    for (const score of plan.scores) {
      expect(typeof score.totalScore).toBe('number')
      expect(Number.isFinite(score.totalScore)).toBe(true)
    }
  })

  it('always includes at least one security/review candidate for high-risk auth tasks', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'claim:auth_a', text: 'Auth flow is enforced', riskLevel: 'critical', status: 'unverified', confidence: 0.4 }),
      makeClaim({ id: 'claim:auth_b', text: 'Permission boundary check is wired', riskLevel: 'high', status: 'unverified', confidence: 0.4 }),
    ]
    const plan = planner.plan({
      taskId: 't',
      claims,
      filesChanged: ['src/auth/permissions.ts'],
      commands: { test: 'pnpm test' },
    })
    const types = plan.candidateActions.map((a) => a.actionType)
    expect(types).toContain('permission_boundary_check')
  })

  it('produces a deterministic ranking across repeated runs', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'claim:a', text: 'a', riskLevel: 'high', status: 'unverified', confidence: 0.4 }),
      makeClaim({ id: 'claim:b', text: 'b', riskLevel: 'medium', status: 'unverified', confidence: 0.4 }),
    ]
    const input = { taskId: 't', claims, commands: { test: 'pnpm test' } }
    const plan1 = planner.plan(input)
    const plan2 = planner.plan(input)
    const ids1 = plan1.candidateActions.map((a) => a.id)
    const ids2 = plan2.candidateActions.map((a) => a.id)
    expect(ids1).toEqual(ids2)
    expect(plan1.candidateActions.map((a) => a.expectedEvidenceValue)).toEqual(
      plan2.candidateActions.map((a) => a.expectedEvidenceValue),
    )
  })
})

describe('EvidenceValueScorer', () => {
  const scorer = new EvidenceValueScorer()

  it('produces a deterministic breakdown for the same input', () => {
    const claims: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.4 })]
    const action = makeAction({ id: 'a1', targetClaims: ['c1'], targetHypotheses: ['h1'], evidenceQuality: 'high', reviewUsefulness: 'high' })
    const a = scorer.score(action, claims)
    const b = scorer.score(action, claims)
    expect(a).toEqual(b)
    expect(a.components.claimImportance).toBeCloseTo(1 * (1 - 0.4), 2)
    expect(a.components.evidenceQuality).toBe(1)
  })

  it('penalises flakiness from history', () => {
    const claims: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'medium', confidence: 0.5 })]
    const action = makeAction({ id: 'a1', targetClaims: ['c1'], actionType: 'unit_test', command: 'pnpm test' })
    const clean = scorer.score(action, claims, { flakinessHistory: { 'unit_test:pnpm test': 0.05 } })
    const flaky = scorer.score(action, claims, { flakinessHistory: { 'unit_test:pnpm test': 0.9 } })
    expect(flaky.totalScore).toBeLessThan(clean.totalScore)
    expect(flaky.components.flakinessPenalty).toBe(0.9)
  })

  it('values high-risk claims over low-risk', () => {
    const low: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'low', confidence: 0.4 })]
    const high: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'critical', confidence: 0.4 })]
    const action = makeAction({ id: 'a1', targetClaims: ['c1'] })
    const sLow = scorer.score(action, low)
    const sHigh = scorer.score(action, high)
    expect(sHigh.totalScore).toBeGreaterThan(sLow.totalScore)
  })
})

describe('Confidence updater', () => {
  it('passes with strong evidence raise confidence but stabilise asymptotically', () => {
    let claim = makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.2, status: 'unverified' })
    const action = makeAction({ id: 'a1', targetClaims: ['c1'] })
    const r1: ActionResult = { status: 'passed', evidenceId: 'ev1', strongEvidence: true }
    const r2: ActionResult = { status: 'passed', evidenceId: 'ev2', strongEvidence: true }
    const r3: ActionResult = { status: 'passed', evidenceId: 'ev3', strongEvidence: true }

    let { next, delta } = applyConfidenceDelta(claim, r1)
    expect(delta.after).toBeGreaterThan(delta.before)
    expect(next.confidence).toBeGreaterThan(claim.confidence)

    let third = applyConfidenceDelta({ ...next }, r2).next
    let fourth = applyConfidenceDelta({ ...third }, r3).next

    // Two passes do not sum linearly — they asymptote.
    const linearProjection = claim.confidence + 3 * (1 - claim.confidence) * 0.5
    expect(fourth.confidence).toBeLessThan(linearProjection)
    expect(fourth.confidence).toBeLessThanOrEqual(0.99)
  })

  it('passes with weak evidence move confidence less than strong evidence', () => {
    const claim = makeClaim({ id: 'c1', riskLevel: 'medium', confidence: 0.3 })
    const strong = applyConfidenceDelta(claim, { status: 'passed', evidenceId: 'e1', strongEvidence: true }).next
    const weak = applyConfidenceDelta(claim, { status: 'passed', evidenceId: 'e1', strongEvidence: false }).next
    expect(strong.confidence).toBeGreaterThan(weak.confidence)
  })

  it('failures reduce confidence but do not reset to 0', () => {
    const claim = makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.8, status: 'verified' })
    const { next, delta } = applyConfidenceDelta(claim, { status: 'failed', evidenceId: 'ev-bad' })
    expect(delta.after).toBeLessThan(delta.before)
    expect(next.confidence).toBeGreaterThan(0)
    expect(next.confidence).toBeLessThan(claim.confidence)
    expect(next.status).toBe('contradicted')
  })

  it('applyResultsToClaims applies many results in sequence', () => {
    const claims: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.1 })]
    const action = makeAction({ id: 'a1', targetClaims: ['c1'] })
    const out = applyResultsToClaims(claims, [
      { action, result: { status: 'passed', evidenceId: 'e1' } },
      { action, result: { status: 'passed', evidenceId: 'e2' } },
    ])
    expect(out[0]!.confidence).toBeGreaterThan(claims[0]!.confidence)
  })

  it('updateBeliefGraph adds evidence + supports/contradicts edges', () => {
    const claim = makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.2 })
    const state: TaskBeliefState = {
      taskId: 't', repoId: 'r', goal: 'g', acceptanceCriteria: [],
      selectedDomains: [], selectedGraphRegions: [],
      hypotheses: [makeHypothesis()], claims: [claim],
      assumptions: [], uncertainties: [], evidenceRefs: [], contradictions: [],
      nodes: [
        { id: 'task:t', type: 'Task', label: 'g' },
        { id: claim.id, type: 'Claim', label: claim.text, status: 'plausible', confidence: claim.confidence },
      ],
      edges: [],
      verificationObligations: [], humanReviewRequirements: [],
      updatedAt: new Date().toISOString(),
    }
    const action = makeAction({ id: 'a1', targetClaims: ['c1'] })
    const passed = updateBeliefGraph(state, { ...claim, confidence: 0.6, status: 'partially_verified' }, { status: 'passed', evidenceId: 'ev1' }, 0.2)
    expect(passed.evidenceRefs.some((e) => e.id === 'ev1')).toBe(true)
    expect(passed.edges.some((e) => e.type === 'supports' && e.targetId === 'c1')).toBe(true)
    expect(passed.nodes.some((n) => n.id === 'evidence:ev1')).toBe(true)

    const failed = updateBeliefGraph(state, { ...claim, status: 'contradicted' }, { status: 'failed', evidenceId: 'ev2' }, 0.2)
    expect(failed.edges.some((e) => e.type === 'contradicts' && e.targetId === 'c1')).toBe(true)
  })

  it('recordActionResult writes through a stub TxContext and emits a trace event', async () => {
    const claim = makeClaim({ id: 'c1', riskLevel: 'high', confidence: 0.3 })
    const beliefState: TaskBeliefState = {
      taskId: 'task-1', repoId: 'r', goal: 'g', acceptanceCriteria: [],
      selectedDomains: [], selectedGraphRegions: [],
      hypotheses: [], claims: [claim],
      assumptions: [], uncertainties: [], evidenceRefs: [], contradictions: [],
      nodes: [{ id: claim.id, type: 'Claim', label: claim.text, status: 'plausible', confidence: claim.confidence }],
      edges: [],
      verificationObligations: [], humanReviewRequirements: [],
      updatedAt: new Date().toISOString(),
    }
    const action = makeAction({ id: 'a1', targetClaims: ['c1'] })
    const tx = makeStubTx()
    const out = await recordActionResult(tx, {
      taskId: 'task-1',
      actionId: 'a1',
      action,
      beliefState,
      result: { status: 'passed', evidenceId: 'ev-1', strongEvidence: true, outputSummary: '3 tests passed' },
    })
    expect(out.confidenceDeltas).toHaveLength(1)
    expect(out.confidenceDeltas[0]!.after).toBeGreaterThan(0.3)
    expect(tx.writes.claims).toHaveLength(1)
    expect(tx.writes.checks).toHaveLength(1)
    expect(tx.traces).toHaveLength(1)
    expect(tx.traces[0]!.type).toBe('verification_action_result')
  })
})

describe('Stale-claim invalidation', () => {
  it('markStaleForChangedFiles flips a verified claim to stale when a referenced file is edited', () => {
    const claim = makeClaim({
      id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.95,
      supportingEvidence: [{ id: 'ev1', artifactRef: 'src/auth/permissions.ts' }],
    })
    const out = findStaleClaimsForFiles([claim], ['src/auth/permissions.ts'])
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('stale')
    expect(out[0]!.confidence).toBeLessThanOrEqual(0.49)
    expect(out[0]!.staleReason).toBeTruthy()
  })

  it('does not flip claims that have no evidence referencing a changed file', () => {
    const claim = makeClaim({
      id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.95,
      supportingEvidence: [{ id: 'ev1', artifactRef: 'src/api/invites.ts' }],
    })
    const out = findStaleClaimsForFiles([claim], ['src/auth/permissions.ts'])
    expect(out).toHaveLength(0)
  })

  it('markStaleForChangedFiles also flips claims whose evidence references a transitively reachable file', () => {
    // Direct change: src/api/invites.ts. Transitively, src/auth/permissions.ts
    // is reachable via the graph (auth imports api). A claim with evidence
    // pointing at the auth file should still be invalidated.
    const graph = makeGraph()
    const claim = makeClaim({
      id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.9,
      supportingEvidence: [{ id: 'ev1', artifactRef: 'src/auth/permissions.ts' }],
    })
    const out = findStaleClaimsForFiles([claim], ['src/api/invites.ts'], { repoGraph: graph })
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('stale')
  })

  it('markStaleForChangedFiles persists the invalidation in a stub TxContext', async () => {
    const claim = makeClaim({
      id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.95,
      supportingEvidence: [{ id: 'ev1', artifactRef: 'src/auth/permissions.ts' }],
    })
    const tx = makeStubTx()
    const out = await markStaleForChangedFiles(tx, {
      taskId: 't', filesChanged: ['src/auth/permissions.ts'], claims: [claim],
    })
    expect(out.invalidated).toHaveLength(1)
    expect(out.traceEventId).toBeTruthy()
    expect(tx.writes.claims).toHaveLength(1)
    expect(tx.writes.claims[0]!.status).toBe('stale')
  })

  it('returns no claims when no files changed', () => {
    const claim = makeClaim({ id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.95 })
    expect(findStaleClaimsForFiles([claim], [])).toHaveLength(0)
  })
})

describe('Completion gating', () => {
  it('blocks completion when a high-risk claim is unverified', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'c1', riskLevel: 'low', status: 'verified', confidence: 0.9 }),
      makeClaim({ id: 'c2', riskLevel: 'critical', status: 'unverified', confidence: 0.2 }),
    ]
    const result = evaluateCompletion({ claims })
    expect(result.ready).toBe(false)
    expect(result.blockers.some((b) => b.includes('High-risk'))).toBe(true)
    expect(result.summary.highRiskUnverified).toBe(1)
  })

  it('blocks completion when a stale claim is present', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'c1', riskLevel: 'medium', status: 'verified', confidence: 0.9 }),
      makeClaim({ id: 'c2', riskLevel: 'medium', status: 'stale', confidence: 0.4 }),
    ]
    const result = evaluateCompletion({ claims })
    expect(result.ready).toBe(false)
    expect(result.blockers.some((b) => b.includes('Stale'))).toBe(true)
  })

  it('blocks completion when a contradiction is unresolved', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'c1', riskLevel: 'medium', status: 'verified', confidence: 0.9 }),
      makeClaim({ id: 'c2', riskLevel: 'high', status: 'contradicted', confidence: 0.2 }),
    ]
    const result = evaluateCompletion({ claims })
    expect(result.ready).toBe(false)
    expect(result.blockers.some((b) => b.includes('Contradicted'))).toBe(true)
  })

  it('allows completion when high-risk claims are needs_human_review', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'c1', riskLevel: 'critical', status: 'needs_human_review', confidence: 0.5 }),
      makeClaim({ id: 'c2', riskLevel: 'medium', status: 'verified', confidence: 0.9 }),
    ]
    const result = evaluateCompletion({ claims })
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('blocks when a high-value action is skipped without a reason', () => {
    const claims: Claim[] = [makeClaim({ id: 'c1', riskLevel: 'medium', status: 'verified', confidence: 0.9 })]
    const actions: VerificationAction[] = [makeAction({ id: 'a1', status: 'skipped', expectedEvidenceValue: 5, selectionReason: '' })]
    const result = evaluateCompletion({ claims, actions })
    expect(result.ready).toBe(false)
    expect(result.blockers.some((b) => b.includes('Skipped'))).toBe(true)
  })

  it('canCompleteAfterHumanReview flips a high-risk claim to needs_human_review and unblocks', () => {
    const claims: Claim[] = [
      makeClaim({ id: 'c1', riskLevel: 'critical', status: 'unverified', confidence: 0.2 }),
    ]
    const result = evaluateCompletion({ claims })
    expect(result.ready).toBe(false)

    const after = canCompleteAfterHumanReview({ claims }, 'c1', 'reviewed by on-call')
    expect(after.ready).toBe(true)
  })

  it('markHumanReview preserves claim evidence and adds reviewer guidance', () => {
    const ev: EvidenceRef = { id: 'e1' }
    const claim = makeClaim({ id: 'c1', riskLevel: 'high', status: 'verified', confidence: 0.9, supportingEvidence: [ev] })
    const out = markHumanReview(claim, 'Accepted by reviewer', 'coen')
    expect(out.status).toBe('needs_human_review')
    expect(out.reviewerGuidance).toBe('Accepted by reviewer')
    expect(out.supportingEvidence).toEqual([ev])
  })
})

/* ---------------------------------------------------------------- *
 *  Stub TxContext
 * ---------------------------------------------------------------- */

interface StubTx extends TxContext {
  writes: {
    claims: Array<{ id: string; status?: string; confidence?: number }>
    checks: Array<{ id: string; checkType: string; status: string; evidenceId: string | null }>
  }
  traces: Array<{ id: string; type: string; summary: string }>
}

function makeStubTx(): StubTx {
  const writes: StubTx['writes'] = { claims: [], checks: [] }
  const traces: StubTx['traces'] = []
  let traceCounter = 0
  return {
    writes,
    traces,
    repos: {
      claims: {
        update: async (id: string, patch: { status?: string; confidence?: number }) => {
          writes.claims.push({ id, status: patch.status, confidence: patch.confidence })
          return { id, taskId: 't', acceptanceCriterionId: null, text: '', status: patch.status ?? 'unverified', confidence: patch.confidence ?? null, riskLevel: null, reviewerGuidance: null, payload: {}, createdAt: '', updatedAt: '' }
        },
      } as never,
      verificationChecks: {
        insert: async (input: { id: string; checkType: string; status: string; evidenceId: string | null }) => {
          writes.checks.push(input)
          return { ...input, taskId: 't', acceptanceCriterionId: null, claimId: null, command: null, riskLevel: null, reason: null, staleReason: null, payload: {}, createdAt: '', updatedAt: '' }
        },
      } as never,
    } as never,
    trace: async (event: { type: string; summary: string }) => {
      traceCounter += 1
      const id = `trace-${traceCounter}`
      traces.push({ id, type: event.type, summary: event.summary })
      return { id, createdAt: new Date().toISOString() }
    },
  }
}
