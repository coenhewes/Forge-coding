/**
 * Truth maintenance layer.
 *
 * After every observation or verification pass we re-evaluate each
 * claim in the task belief state. The function `runTruthMaintenance`
 * does three things:
 *
 *   1. Recompute each claim's confidence from the current evidence:
 *        confidence = prior + sum(weights_supports) * (1 - prior)
 *                       - sum(weights_contradicts) * prior
 *      clamped to [0, 1].
 *   2. Detect contradictions: a claim that has both supporting AND
 *      contradicting evidence becomes `status: 'contradicted'`.
 *   3. Detect stale: a claim whose last evidence is older than
 *      `staleAfterMs` (default 24h) becomes `status: 'stale'`. The
 *      caller may also pass a `now` clock for deterministic tests.
 *
 * Every status change emits a trace event via the `StateStoreLike`
 * (so the test stub or the real `ForgeStateStore.tx` handle routes
 * the trace to `trace_events` co-transactionally with the claim
 * update).
 */
import type { Claim, EvidenceRef } from '@forge/types'
import type { BeliefStore, StateStoreLike } from './store.js'
import { clamp01 } from './util.js'

export interface EvidenceDescriptor {
  /** The evidence id, used to filter to a single claim. */
  id: string
  /** Polarity: does it support or contradict the claim? */
  polarity: 'supports' | 'contradicts'
  /** Weight (0..1) for the recompute. */
  weight: number
  /** Source artifact (used for stale detection by file mtime). */
  sourceFilePath?: string
  sourceFileMtime?: string
  createdAt: string
}

export interface TruthMaintenanceOptions {
  /** How long evidence counts as fresh. Default 24h. */
  staleAfterMs?: number
  /** Clock for deterministic tests. */
  now?: () => Date
  /**
   * Optional: for each claim, provide its evidence descriptors. If
   * omitted, the truth layer will ask the store for them via
   * `listEvidenceForClaim`. The explicit map is useful in tests and
   * in callers that have already aggregated evidence from elsewhere.
   */
  evidenceByClaim?: Map<string, EvidenceDescriptor[]>
}

export interface TruthMaintenanceReport {
  contradictions: Array<{ claimId: string; evidenceIds: string[] }>
  stale: Array<{ claimId: string; reason: string }>
  updated: Array<{ claimId: string; confidence: number; status: Claim['status'] }>
  traceEventCount: number
}

/**
 * Run truth maintenance for a task. For every claim in the task we:
 *   - recompute confidence from the evidence weights,
 *   - mark conflicts,
 *   - mark stale claims,
 *   - emit a trace event for every status change.
 *
 * Returns a report so callers (and tests) can assert on the outcome
 * without re-querying the store.
 */
export async function runTruthMaintenance(
  store: BeliefStore,
  stateStore: StateStoreLike,
  taskId: string,
  options: TruthMaintenanceOptions = {},
): Promise<TruthMaintenanceReport> {
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000
  const now = options.now ?? (() => new Date())
  const claims = await stateStore.repos.claims.listByTask(taskId)
  const report: TruthMaintenanceReport = {
    contradictions: [],
    stale: [],
    updated: [],
    traceEventCount: 0,
  }

  for (const claimRow of claims) {
    const claim = claimRowToClaim(claimRow)
    const evidence = options.evidenceByClaim?.get(claim.id) ?? (await loadEvidence(stateStore, claim.id))
    const recomputed = recomputeConfidence(claim, evidence)
    let nextStatus: Claim['status'] = claim.status
    let nextConfidence = recomputed.confidence

    // Conflict detection: both supports and contradicts present.
    const hasSupports = evidence.some((e) => e.polarity === 'supports')
    const hasContradicts = evidence.some((e) => e.polarity === 'contradicts')
    if (hasSupports && hasContradicts) {
      nextStatus = 'conflicted'
      report.contradictions.push({ claimId: claim.id, evidenceIds: evidence.map((e) => e.id) })
    }

    // Stale detection: oldest evidence older than threshold, OR every
    // sourceFileMtime is older than the evidence's createdAt.
    const staleReason = detectStale(evidence, now(), staleAfterMs)
    if (staleReason) {
      nextStatus = 'stale'
      report.stale.push({ claimId: claim.id, reason: staleReason })
      // Cap stale confidence at 0.49 so the verifier treats it as
      // not-yet-verified.
      nextConfidence = Math.min(nextConfidence, 0.49)
    }

    // Confidence promotion: if no contradiction, no staleness, and we
    // now have strong support, mark verified at >=0.85.
    if (
      nextStatus !== 'conflicted' &&
      nextStatus !== 'stale' &&
      hasSupports &&
      !hasContradicts &&
      nextConfidence >= 0.85 &&
      evidence.filter((e) => e.polarity === 'supports').length >= 2
    ) {
      nextStatus = 'verified'
    }

    // Persist if anything changed.
    if (nextStatus !== claim.status || Math.abs(nextConfidence - claim.confidence) > 0.005) {
      const before = { status: claim.status, confidence: claim.confidence }
      await store.updateClaimConfidence(taskId, claim.id, nextConfidence, nextStatus)
      report.updated.push({ claimId: claim.id, confidence: nextConfidence, status: nextStatus })
      // Each claim update already emits its own trace event; count
      // that as a single truth-event for the report.
      report.traceEventCount += 1
      // Extra trace event recording the before/after diff for the
      // truth layer (purely informational; co-transactional).
      await stateStore.tx(async (ctx) => {
        await ctx.trace({
          type: 'truth_maintenance_update',
          taskId,
          actor: 'system',
          summary: `Claim ${claim.id} ${before.status}→${nextStatus} (confidence ${before.confidence.toFixed(2)}→${nextConfidence.toFixed(2)})`,
          payload: { claimId: claim.id, before, after: { status: nextStatus, confidence: nextConfidence }, reason: staleReason ?? 'recompute' },
        })
      })
      report.traceEventCount += 1
    }
  }

  return report
}

/** Pure helper exposed for tests and external callers. */
export function recomputeConfidence(
  claim: Claim,
  evidence: EvidenceDescriptor[],
): { confidence: number; supportsWeight: number; contradictsWeight: number } {
  let prior = clamp01(claim.confidence || 0)
  if (prior === 0) prior = 0.5 // start at a uniform prior when no prior is set
  const supportsWeight = evidence
    .filter((e) => e.polarity === 'supports')
    .reduce((sum, e) => sum + clamp01(e.weight), 0)
  const contradictsWeight = evidence
    .filter((e) => e.polarity === 'contradicts')
    .reduce((sum, e) => sum + clamp01(e.weight), 0)
  const next = prior + supportsWeight * (1 - prior) - contradictsWeight * prior
  return {
    confidence: clamp01(next),
    supportsWeight,
    contradictsWeight,
  }
}

function detectStale(evidence: EvidenceDescriptor[], now: Date, staleAfterMs: number): string | null {
  if (evidence.length === 0) return null
  const nowMs = now.getTime()
  // Stale by age: all evidence older than the threshold.
  const allOld = evidence.every((e) => nowMs - new Date(e.createdAt).getTime() > staleAfterMs)
  if (allOld) return 'evidence older than freshness window'
  // Stale by file edit: a source file was modified after its evidence
  // was attached. We need the most recent mtime across the linked files.
  const mtimeMs = evidence.reduce((max, e) => {
    if (!e.sourceFileMtime) return max
    return Math.max(max, new Date(e.sourceFileMtime).getTime())
  }, 0)
  if (mtimeMs > 0) {
    const latestCreated = evidence.reduce((max, e) => Math.max(max, new Date(e.createdAt).getTime()), 0)
    if (mtimeMs > latestCreated) return 'source file edited after evidence was recorded'
  }
  return null
}

async function loadEvidence(stateStore: StateStoreLike, claimId: string): Promise<EvidenceDescriptor[]> {
  const links = await stateStore.repos.claimEvidenceLinks.listByClaim(claimId)
  const evidence = await stateStore.repos.evidence.listByClaim(claimId)
  const byId = new Map(evidence.map((e) => [e.id, e]))
  return links
    .map((link) => {
      const ev = byId.get(link.evidenceId)
      if (!ev) return null
      return {
        id: ev.id,
        polarity: link.linkType === 'supports' ? 'supports' : 'contradicts',
        weight: 0.6,
        sourceFilePath: (ev.payload as Record<string, unknown> | undefined)?.sourceFilePath as string | undefined,
        sourceFileMtime: (ev.payload as Record<string, unknown> | undefined)?.sourceFileMtime as string | undefined,
        createdAt: ev.createdAt,
      } as EvidenceDescriptor
    })
    .filter((e): e is EvidenceDescriptor => Boolean(e))
}

function claimRowToClaim(row: {
  id: string
  text: string
  status: string
  confidence: number | null
  riskLevel: string | null
  acceptanceCriterionId: string | null
  reviewerGuidance: string | null
}): Claim {
  return {
    id: row.id,
    text: row.text,
    status: row.status as Claim['status'],
    confidence: row.confidence ?? 0,
    riskLevel: (row.riskLevel ?? 'low') as Claim['riskLevel'],
    acceptanceCriterionRefs: row.acceptanceCriterionId ? [row.acceptanceCriterionId] : [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    reviewerGuidance: row.reviewerGuidance ?? undefined,
  }
}

export function evidenceRefsFromDescriptors(evidence: EvidenceDescriptor[]): EvidenceRef[] {
  return evidence.map((e) => ({ id: e.id, summary: e.polarity }))
}
