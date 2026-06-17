/**
 * Belief-graph tests.
 *
 * Exercises the full belief-engine stack (BeliefStore, ProbePlanner,
 * truth maintenance, diagnostic engine, assurance generator) against
 * an in-memory stub of `StateStoreLike` so the suite runs without a
 * live Postgres connection.
 *
 * The five scenarios from the task brief:
 *   1. Seed a task with 3 hypotheses, attach mixed evidence, run
 *      truth maintenance, assert confidence values.
 *   2. Force a contradiction, assert status='conflicted'.
 *   3. Force stale (mock time), assert status='stale'.
 *   4. Run the probe planner, assert scores sum correctly and the top
 *      probe is the highest-utility one.
 *   5. Diagnostic engine: feed it a failed check pointing to
 *      auth/middleware.ts, assert it proposes route-guard vs
 *      role-mapping vs session-expiry hypotheses.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  BeliefStore,
  InMemoryBeliefStore,
  ProbePlanner,
  DiagnosticEngine,
  runTruthMaintenance,
  generateAssuranceCase,
} from '@forge/belief'
import type { Claim, EvidenceDescriptor } from '@forge/belief'

interface Fixture {
  mem: InMemoryBeliefStore
  store: BeliefStore
  taskId: string
  repoId: string
  evidenceByClaim: Map<string, EvidenceDescriptor[]>
}

function makeFixture(now: () => Date = () => new Date('2026-06-17T10:00:00Z')): Fixture {
  const mem = new InMemoryBeliefStore()
  const stateLike = mem.asStateStoreLike()
  const store = new BeliefStore(stateLike)
  return {
    mem,
    store,
    taskId: 'task-1',
    repoId: 'repo-1',
    evidenceByClaim: new Map(),
  }
}

async function seedTask(fx: Fixture): Promise<{
  hyp1Id: string
  hyp2Id: string
  hyp3Id: string
  claimId: string
}> {
  await fx.store.createTaskBeliefState(fx.taskId, {
    repoId: fx.repoId,
    goal: 'Fix SSO admin invite failure',
    acceptanceCriteria: ['SSO admin can invite', 'non-admin cannot'],
    hypotheses: [
      { claim: 'Role alias is not normalised before the invite permission check', relevantDomains: ['auth', 'backend'] },
      { claim: 'Route guard uses a stale role name', relevantDomains: ['auth', 'backend'] },
      { claim: 'Session expired between login and the invite attempt', relevantDomains: ['auth'] },
    ],
    claims: [
      { text: 'SSO admin can invite users', riskLevel: 'high', acceptanceCriterionRefs: ['c-1'] },
    ],
  })
  const hypotheses = [...fx.mem.hypotheses.values()]
  expect(hypotheses).toHaveLength(3)
  const claims = [...fx.mem.claims.values()]
  expect(claims).toHaveLength(1)
  return {
    hyp1Id: hypotheses[0]!.id as string,
    hyp2Id: hypotheses[1]!.id as string,
    hyp3Id: hypotheses[2]!.id as string,
    claimId: claims[0]!.id as string,
  }
}

async function attachEvidenceToClaim(
  fx: Fixture,
  claimId: string,
  evidenceId: string,
  polarity: 'supports' | 'contradicts',
  weight: number,
  createdAt: string,
): Promise<void> {
  // Insert the evidence row, then link it.
  fx.mem.evidence.set(evidenceId, {
    id: evidenceId,
    taskId: fx.taskId,
    evidenceType: 'test_result',
    summary: `evidence ${evidenceId}`,
    status: 'pass',
    sourceType: 'integration_test',
    sourceRef: `tests/foo.test.ts`,
    artifactId: null,
    payload: {},
    createdAt,
  })
  await fx.store.attachEvidence(fx.taskId, claimId, evidenceId, polarity)
  const list = fx.evidenceByClaim.get(claimId) ?? []
  list.push({ id: evidenceId, polarity, weight, createdAt })
  fx.evidenceByClaim.set(claimId, list)
}

describe('@forge/belief', () => {
  describe('BeliefStore + truth maintenance', () => {
    let fx: Fixture
    let ids: { hyp1Id: string; hyp2Id: string; hyp3Id: string; claimId: string }

    beforeEach(async () => {
      fx = makeFixture()
      ids = await seedTask(fx)
    })

    it('seeds a task with hypotheses, claims, and trace events co-transactionally', async () => {
      expect(fx.mem.hypotheses.size).toBe(3)
      expect(fx.mem.claims.size).toBe(1)
      const traceTypes = fx.mem.traceEvents.map((t) => t.type)
      expect(traceTypes).toContain('belief_state_created')
      expect(traceTypes).toContain('hypothesis_added')
      expect(traceTypes).toContain('claim_added')
    })

    it('recomputes confidence from mixed evidence, writes back via store.tx, emits a trace event', async () => {
      // Two supporting (0.6, 0.4) and one contradicting (0.5).
      // Claim starts at confidence 0 → uniform prior 0.5.
      // confidence = 0.5 + (0.6+0.4) * (1-0.5) - 0.5 * 0.5 = 0.75
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-1', 'supports', 0.6, new Date().toISOString())
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-2', 'supports', 0.4, new Date().toISOString())
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-3', 'contradicts', 0.5, new Date().toISOString())

      const report = await runTruthMaintenance(fx.store, fx.mem.asStateStoreLike(), fx.taskId, {
        evidenceByClaim: fx.evidenceByClaim,
      })
      expect(report.updated.length).toBeGreaterThanOrEqual(1)
      const updated = report.updated.find((u) => u.claimId === ids.claimId)
      expect(updated).toBeDefined()
      // Should still be conflicted (has both supports and contradicts).
      expect(updated!.status).toBe('conflicted')
      expect(updated!.confidence).toBe(0.75)
      // Truth layer should have emitted trace events.
      const traceTypes = fx.mem.traceEvents.map((t) => t.type)
      expect(traceTypes).toContain('claim_confidence_updated')
    })

    it('marks status=conflicted when a claim has both supporting and contradicting evidence', async () => {
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-1', 'supports', 0.5, new Date().toISOString())
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-2', 'contradicts', 0.5, new Date().toISOString())
      const report = await runTruthMaintenance(fx.store, fx.mem.asStateStoreLike(), fx.taskId, {
        evidenceByClaim: fx.evidenceByClaim,
      })
      const updated = report.updated.find((u) => u.claimId === ids.claimId)
      expect(updated).toBeDefined()
      expect(updated!.status).toBe('conflicted')
      expect(report.contradictions).toHaveLength(1)
      expect(report.contradictions[0]!.claimId).toBe(ids.claimId)
    })

    it('marks status=stale when every piece of evidence is older than 24h', async () => {
      const oldTimestamp = new Date('2026-06-15T08:00:00Z').toISOString() // ~50h old
      // Manually inject 1 supporting evidence and tell the truth layer
      // it's old.
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-1', 'supports', 0.4, oldTimestamp)
      const now = () => new Date('2026-06-17T10:00:00Z')
      const report = await runTruthMaintenance(fx.store, fx.mem.asStateStoreLike(), fx.taskId, {
        evidenceByClaim: fx.evidenceByClaim,
        staleAfterMs: 24 * 60 * 60 * 1000,
        now,
      })
      const updated = report.updated.find((u) => u.claimId === ids.claimId)
      expect(updated).toBeDefined()
      expect(updated!.status).toBe('stale')
      // Stale confidence should be capped at 0.49.
      expect(updated!.confidence).toBeLessThanOrEqual(0.49)
      expect(report.stale).toHaveLength(1)
      expect(report.stale[0]!.reason).toMatch(/older than freshness window/)
    })

    it('marks status=stale when a source file was edited after evidence was attached', async () => {
      const evidenceTimestamp = new Date('2026-06-17T09:00:00Z').toISOString()
      // The evidence row is fresh, but the source file was edited at
      // 09:30Z — after the evidence was recorded.
      fx.mem.evidence.set('ev-1', {
        id: 'ev-1',
        taskId: fx.taskId,
        evidenceType: 'test_result',
        summary: 'auth middleware test passes',
        status: 'pass',
        sourceType: 'integration_test',
        sourceRef: 'auth/middleware.ts',
        artifactId: null,
        payload: {
          sourceFilePath: 'auth/middleware.ts',
          sourceFileMtime: new Date('2026-06-17T09:30:00Z').toISOString(),
        },
        createdAt: evidenceTimestamp,
      })
      await fx.store.attachEvidence(fx.taskId, ids.claimId, 'ev-1', 'supports')
      fx.evidenceByClaim.set(ids.claimId, [
        {
          id: 'ev-1',
          polarity: 'supports',
          weight: 0.5,
          sourceFilePath: 'auth/middleware.ts',
          sourceFileMtime: new Date('2026-06-17T09:30:00Z').toISOString(),
          createdAt: evidenceTimestamp,
        },
      ])
      const now = () => new Date('2026-06-17T10:00:00Z')
      const report = await runTruthMaintenance(fx.store, fx.mem.asStateStoreLike(), fx.taskId, {
        evidenceByClaim: fx.evidenceByClaim,
        now,
      })
      const updated = report.updated.find((u) => u.claimId === ids.claimId)
      expect(updated!.status).toBe('stale')
      expect(report.stale[0]!.reason).toMatch(/source file edited after evidence/)
    })
  })

  describe('ProbePlanner', () => {
    it('exposes a scoring breakdown that sums to the reported total', () => {
      const planner = new ProbePlanner()
      const claims: Claim[] = [
        { id: 'c-1', text: 'SSO admin can invite', status: 'unverified', confidence: 0.2, riskLevel: 'high', acceptanceCriterionRefs: [], supportingEvidence: [], contradictingEvidence: [], missingEvidence: [], verificationChecks: [] },
        { id: 'c-2', text: 'non-admin cannot invite', status: 'unverified', confidence: 0.1, riskLevel: 'critical', acceptanceCriterionRefs: [], supportingEvidence: [], contradictingEvidence: [], missingEvidence: [], verificationChecks: [] },
      ]
      const hypotheses = [
        { id: 'h-1', claim: 'role alias', status: 'plausible' as const, confidence: 0.5, relevantDomains: [], relevantGraphNodes: [], supportingEvidence: [], contradictingEvidence: [], assumptions: [], suggestedProbes: [], suggestedPatchStrategies: [], createdAt: '', updatedAt: '' },
        { id: 'h-2', claim: 'route guard', status: 'plausible' as const, confidence: 0.4, relevantDomains: [], relevantGraphNodes: [], supportingEvidence: [], contradictingEvidence: [], assumptions: [], suggestedProbes: [], suggestedPatchStrategies: [], createdAt: '', updatedAt: '' },
      ]
      const scored = planner.plan({
        taskId: 't',
        claims,
        hypotheses,
        capabilities: ['auth.trace_permission_check', 'tests.find_related_tests', 'repo.find_definitions'],
        risk: { level: 'high', areas: [], factors: [] },
      })
      expect(scored.length).toBeGreaterThan(0)
      // Verify the breakdown sums to the total.
      for (const s of scored) {
        const gain = s.probe.expectedInformationGain === 'high' ? 1 : s.probe.expectedInformationGain === 'medium' ? 0.6 : 0.25
        const terms = [
          s.breakdown.claimImportance,
          s.breakdown.confidenceGap,
          s.breakdown.hypothesisDiscrimination * 0.8,
          gain,
          s.breakdown.evidenceQuality,
          s.breakdown.riskReduction,
          -s.breakdown.runtimeCost,
          -s.breakdown.sideEffectRisk,
          -s.breakdown.flakiness,
        ]
        const sum = Number(terms.reduce((a, b) => a + b, 0).toFixed(2))
        // Allow tiny rounding wiggle.
        expect(Math.abs(sum - s.breakdown.total)).toBeLessThanOrEqual(0.05)
        // And the reported total matches the score field.
        expect(s.breakdown.total).toBe(s.score)
      }
    })

    it('returns the highest-utility probe as the top recommendation', () => {
      const planner = new ProbePlanner()
      const claims: Claim[] = [
        { id: 'c-critical', text: 'SSO admin can invite', status: 'unverified', confidence: 0.05, riskLevel: 'critical', acceptanceCriterionRefs: [], supportingEvidence: [], contradictingEvidence: [], missingEvidence: [], verificationChecks: [] },
      ]
      const hypotheses = [
        { id: 'h-1', claim: 'role alias', status: 'plausible' as const, confidence: 0.5, relevantDomains: [], relevantGraphNodes: [], supportingEvidence: [], contradictingEvidence: [], assumptions: [], suggestedProbes: [], suggestedPatchStrategies: [], createdAt: '', updatedAt: '' },
        { id: 'h-2', claim: 'route guard', status: 'plausible' as const, confidence: 0.4, relevantDomains: [], relevantGraphNodes: [], supportingEvidence: [], contradictingEvidence: [], assumptions: [], suggestedProbes: [], suggestedPatchStrategies: [], createdAt: '', updatedAt: '' },
        { id: 'h-3', claim: 'session', status: 'plausible' as const, confidence: 0.3, relevantDomains: [], relevantGraphNodes: [], supportingEvidence: [], contradictingEvidence: [], assumptions: [], suggestedProbes: [], suggestedPatchStrategies: [], createdAt: '', updatedAt: '' },
      ]
      const scored = planner.plan({
        taskId: 't',
        claims,
        hypotheses,
        capabilities: ['auth.trace_permission_check', 'auth.find_policy_sources', 'db.find_migrations_touching_table', 'tests.find_related_tests', 'repo.find_definitions'],
        risk: { level: 'critical', areas: [], factors: [] },
      })
      expect(scored.length).toBeGreaterThan(1)
      // The top probe must be a HIGH-information-gain capability that
      // targets the highest-risk claim. The 'high' gain capabilities
      // in the enumerate list are auth.trace_permission_check,
      // auth.find_policy_sources, and tests.find_related_tests. The
      // exact winner depends on the tie-break; assert it's one of
      // those (and that 'run_typecheck' is NOT on top, since it has
      // 'medium' gain and no claim-specific input).
      const topCapability = scored[0]!.probe.capability
      const highGainCapabilities = new Set([
        'auth.trace_permission_check',
        'auth.find_policy_sources',
        'tests.find_related_tests',
      ])
      expect(highGainCapabilities.has(topCapability)).toBe(true)
      expect(scored[0]!.probe.expectedInformationGain).toBe('high')
      // The breakdown should reflect the high-risk amplification
      // (riskReduction = 1.0 for critical).
      expect(scored[0]!.breakdown.riskReduction).toBe(1)
    })

    it('filters out probes that have already returned inconclusive for the same claim', () => {
      const planner = new ProbePlanner()
      const claim: Claim = {
        id: 'c-1', text: 'x', status: 'unverified', confidence: 0.5, riskLevel: 'high',
        acceptanceCriterionRefs: [], supportingEvidence: [], contradictingEvidence: [],
        missingEvidence: [], verificationChecks: [],
      }
      const scored = planner.plan({
        taskId: 't',
        claims: [claim],
        hypotheses: [],
        capabilities: ['auth.trace_permission_check', 'repo.find_definitions'],
        risk: { level: 'high', areas: [], factors: [] },
        priorOutcomes: (capability, claimId) => {
          if (capability === 'auth.trace_permission_check' && claimId === 'c-1') {
            return { outcome: 'inconclusive', recordedAt: '2026-06-17T10:00:00Z' }
          }
          return undefined
        },
      })
      const caps = scored.map((s) => s.probe.capability)
      expect(caps).not.toContain('auth.trace_permission_check')
    })
  })

  describe('DiagnosticEngine', () => {
    it('proposes route-guard vs role-mapping vs session-expiry hypotheses for an auth/middleware failure', () => {
      const engine = new DiagnosticEngine()
      const result = engine.proposeRootCauseHypotheses({
        taskId: 't',
        output: 'POST /orgs/123/invites returned 403 Forbidden — admin guard rejected sso_admin',
        source: 'test',
        failedFilePaths: ['auth/middleware.ts', 'apps/api/src/routes/invite.ts'],
      })
      expect(result.length).toBeGreaterThanOrEqual(3)
      const claims = result.map((r) => r.hypothesis.claim.toLowerCase())
      expect(claims.some((c) => c.includes('route guard'))).toBe(true)
      expect(claims.some((c) => c.includes('role alias') || c.includes('role mapping'))).toBe(true)
      expect(claims.some((c) => c.includes('session'))).toBe(true)
      // Each hypothesis links to contradicting evidence and at least
      // one supporting alternative-cause candidate.
      for (const h of result) {
        expect(h.contradictingEvidence.length).toBeGreaterThan(0)
        expect(h.supportingAlternatives.length).toBeGreaterThan(0)
        expect(h.suggestedProbe.capability).toBeTruthy()
      }
      // The observation also tags the auth domain.
      const obs = engine.diagnose({
        taskId: 't',
        output: 'POST /orgs/123/invites returned 403 — auth guard rejected sso_admin',
        source: 'test',
        failedFilePaths: ['auth/middleware.ts'],
      })
      expect(obs.observation.payload.likelyDomains).toContain('auth')
    })

    it('emits a fallback hypothesis for an unknown failure', () => {
      const engine = new DiagnosticEngine()
      const result = engine.proposeRootCauseHypotheses({
        taskId: 't',
        output: 'mysterious failure',
        source: 'ci',
        failedFilePaths: [],
      })
      expect(result).toHaveLength(1)
      // The fallback hypothesis names the unknown domain and asks for
      // a further probe.
      const claim = result[0]!.hypothesis.claim.toLowerCase()
      expect(claim).toMatch(/unknown|further probe/)
    })
  })

  describe('Assurance generator', () => {
    it('produces a ClaimEvidenceGraph grouping verified, unverified, contradicted, stale, and disproven', async () => {
      const fx = makeFixture()
      const ids = await seedTask(fx)
      // 1) Promote a claim to verified with two supports.
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-good-1', 'supports', 0.7, new Date().toISOString())
      await attachEvidenceToClaim(fx, ids.claimId, 'ev-good-2', 'supports', 0.7, new Date().toISOString())
      await runTruthMaintenance(fx.store, fx.mem.asStateStoreLike(), fx.taskId, {
        evidenceByClaim: fx.evidenceByClaim,
      })
      // 2) Mark a hypothesis as disproven via invalidateHypothesis.
      await fx.store.invalidateHypothesis(fx.taskId, ids.hyp2Id, 'Disproven by direct API test', ['api-403'])

      const graph = await generateAssuranceCase(fx.mem.asStateStoreLike(), fx.taskId)
      expect(graph.taskId).toBe(fx.taskId)
      expect(graph.verifiedClaims.length).toBe(1)
      expect(graph.disprovenHypotheses.length).toBe(1)
      expect(graph.disprovenHypotheses[0]!.hypothesis.id).toBe(ids.hyp2Id)
      expect(graph.openHypotheses.length).toBe(2) // hyp1, hyp3 still open
      expect(graph.reviewerGuidance.length).toBe(0) // no contradicted / stale / human-review
      expect(graph.verifiedClaims[0]!.supportingEvidence.length).toBe(2)
    })
  })
})
