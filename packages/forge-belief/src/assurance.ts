/**
 * Assurance-case generator.
 *
 * Produces a `ClaimEvidenceGraph` that the PR generator (Track 6)
 * can drop into the PR body. The graph is the "what we claim + what
 * proves it" section of the assurance case.
 *
 * The generator works off the typed repositories directly — it does
 * not require a hydrated `TaskBeliefState` in memory, so the PR
 * generator can run on a cold start (e.g. resuming after restart).
 */
import type { Claim, EvidenceRef, Hypothesis } from '@forge/types'
import type { StateStoreLike } from './store.js'

export interface ClaimEvidenceGraph {
  taskId: string
  topClaim: string
  generatedAt: string
  verifiedClaims: ClaimEntry[]
  unverifiedClaims: ClaimEntry[]
  contradictedClaims: ClaimEntry[]
  staleClaims: ClaimEntry[]
  needsHumanReview: ClaimEntry[]
  disprovenHypotheses: HypothesisEntry[]
  openHypotheses: HypothesisEntry[]
  reviewerGuidance: string[]
}

export interface ClaimEntry {
  claim: Claim
  supportingEvidence: EvidenceEntry[]
  contradictingEvidence: EvidenceEntry[]
  confidence: number
  status: Claim['status']
}

export interface HypothesisEntry {
  hypothesis: Hypothesis
  confidence: number
  status: Hypothesis['status']
}

export interface EvidenceEntry extends EvidenceRef {
  /** Mirrors `ClaimEvidenceLinkRow.linkType` for cheap join access. */
  polarity: 'supports' | 'contradicts'
  createdAt: string
}

export interface AssuranceGeneratorOptions {
  /** Clock for deterministic output. */
  now?: () => Date
}

/** Generates the assurance case for a task. */
export async function generateAssuranceCase(
  stateStore: StateStoreLike,
  taskId: string,
  options: AssuranceGeneratorOptions = {},
): Promise<ClaimEvidenceGraph> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString()
  const claims = await stateStore.repos.claims.listByTask(taskId)
  const hypotheses = await stateStore.repos.hypotheses.listByTask(taskId)

  const claimEntries: ClaimEntry[] = []
  for (const row of claims) {
    const claim = rowToClaim(row)
    const links = await stateStore.repos.claimEvidenceLinks.listByClaim(claim.id)
    const supporting: EvidenceEntry[] = []
    const contradicting: EvidenceEntry[] = []
    for (const link of links) {
      const ev = await stateStore.repos.evidence.get(link.evidenceId)
      if (!ev) continue
      const entry: EvidenceEntry = {
        id: ev.id,
        summary: ev.summary,
        artifactRef: ev.artifactId ?? undefined,
        polarity: link.linkType === 'supports' ? 'supports' : 'contradicts',
        createdAt: ev.createdAt,
      }
      if (link.linkType === 'supports') supporting.push(entry)
      else contradicting.push(entry)
    }
    claimEntries.push({
      claim,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      confidence: claim.confidence,
      status: claim.status,
    })
  }

  const verified = claimEntries.filter((c) => c.status === 'verified')
  const contradicted = claimEntries.filter((c) => c.status === 'contradicted')
  const stale = claimEntries.filter((c) => c.status === 'stale')
  const needsHuman = claimEntries.filter((c) => c.status === 'needs_human_review')
  const unverified = claimEntries.filter(
    (c) => c.status === 'unverified' || c.status === 'partially_verified' || c.status === 'conflicted',
  )

  const disproven = hypotheses
    .filter((h) => h.status === 'disproven' || h.status === 'contradicted')
    .map(hypToEntry)
  const open = hypotheses
    .filter((h) => !['disproven', 'contradicted'].includes(h.status))
    .map(hypToEntry)

  const topClaim = pickTopClaim(claimEntries) ?? 'Task has no completion claim recorded yet.'
  const reviewerGuidance = [
    ...contradicted.map((c) => `Resolve contradiction on claim "${c.claim.text}"`),
    ...stale.map((c) => `Re-verify stale claim "${c.claim.text}"`),
    ...needsHuman.map((c) => c.claim.reviewerGuidance ?? `Review claim "${c.claim.text}"`),
  ]

  return {
    taskId,
    topClaim,
    generatedAt: nowIso,
    verifiedClaims: verified,
    unverifiedClaims: unverified,
    contradictedClaims: contradicted,
    staleClaims: stale,
    needsHumanReview: needsHuman,
    disprovenHypotheses: disproven,
    openHypotheses: open,
    reviewerGuidance,
  }
}

function pickTopClaim(entries: ClaimEntry[]): string | undefined {
  const verified = entries.find((c) => c.status === 'verified' && c.claim.riskLevel !== 'low')
  return (verified ?? entries[0])?.claim.text
}

function rowToClaim(row: {
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

function hypToEntry(row: {
  id: string
  claim: string
  status: string
  confidence: number
  relevantDomains: string[]
  relevantGraphNodes: string[]
  createdAt: string
  updatedAt: string
}): HypothesisEntry {
  return {
    hypothesis: {
      id: row.id,
      claim: row.claim,
      status: row.status as Hypothesis['status'],
      confidence: row.confidence,
      relevantDomains: row.relevantDomains,
      relevantGraphNodes: row.relevantGraphNodes,
      supportingEvidence: [],
      contradictingEvidence: [],
      assumptions: [],
      suggestedProbes: [],
      suggestedPatchStrategies: [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    confidence: row.confidence,
    status: row.status as Hypothesis['status'],
  }
}
