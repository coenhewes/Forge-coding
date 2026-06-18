import { randomUUID } from 'node:crypto'
import type { Claim, VerificationAction } from '@forge/types'

/**
 * Completion gating for the verification planner.
 *
 * `canComplete` returns whether a task is safe to mark complete, plus
 * a list of human-readable blockers. The rules (from the spec):
 *
 *   - High/critical-risk claims MUST be `verified` OR
 *     `needs_human_review` (or `not_applicable`) before completion.
 *   - Stale claims block completion until re-verified.
 *   - Contradicted claims block completion until resolved (status no
 *     longer 'contradicted').
 *   - Skipped high-value actions must have a recorded `selectionReason`.
 *
 * The pure helper `evaluateCompletion` is exported for unit tests.
 */

export interface CompletionInput {
  claims: Claim[]
  actions?: VerificationAction[]
  /** Minimum evidence value for an action to be "high-value". Defaults to 0.7. */
  highValueThreshold?: number
  /**
   * Acceptance-criteria progress. When provided, completion additionally
   * requires that every acceptance criterion is verified — and that at least
   * one exists. This closes the "vacuously ready" hole where an empty belief
   * set (no claims) would otherwise pass the gate with zero work done.
   */
  acceptance?: { total: number; verified: number }
}

export interface CompletionResult {
  ready: boolean
  blockers: string[]
  /** For TUI/PR — counts by status, useful for status display. */
  summary: {
    totalClaims: number
    verified: number
    partiallyVerified: number
    unverified: number
    stale: number
    contradicted: number
    needsHumanReview: number
    highRiskUnverified: number
  }
}

const DEFAULT_HIGH_VALUE_THRESHOLD = 0.7

export function evaluateCompletion(input: CompletionInput): CompletionResult {
  const claims = input.claims
  const actions = input.actions ?? []
  const threshold = input.highValueThreshold ?? DEFAULT_HIGH_VALUE_THRESHOLD
  const blockers: string[] = []

  // Track status counts.
  const summary = {
    totalClaims: claims.length,
    verified: 0,
    partiallyVerified: 0,
    unverified: 0,
    stale: 0,
    contradicted: 0,
    needsHumanReview: 0,
    highRiskUnverified: 0,
  }
  for (const claim of claims) {
    switch (claim.status) {
      case 'verified': summary.verified++; break
      case 'partially_verified': summary.partiallyVerified++; break
      case 'unverified': summary.unverified++; break
      case 'stale': summary.stale++; break
      case 'contradicted': summary.contradicted++; break
      case 'needs_human_review': summary.needsHumanReview++; break
      case 'not_applicable': break
    }
    if ((claim.riskLevel === 'high' || claim.riskLevel === 'critical')
      && claim.status !== 'verified'
      && claim.status !== 'needs_human_review'
      && claim.status !== 'not_applicable') {
      summary.highRiskUnverified++
      blockers.push(`High-risk claim requires verification or human review: ${claim.text}`)
    }
    if (claim.status === 'stale') {
      blockers.push(`Stale claim must be re-verified: ${claim.text}`)
    }
    if (claim.status === 'contradicted') {
      blockers.push(`Contradicted claim must be resolved: ${claim.text}`)
    }
  }

  // Skipped high-value actions must have a reason.
  for (const action of actions) {
    if (action.status === 'skipped' && action.expectedEvidenceValue >= threshold && !action.selectionReason) {
      blockers.push(`Skipped high-value verification action without reason: ${action.id}`)
    }
  }

  // Acceptance criteria must all be verified (and at least one must exist).
  // This prevents "completion" with no work done / nothing established.
  if (input.acceptance) {
    const { total, verified } = input.acceptance
    if (total === 0) {
      blockers.push('No acceptance criteria defined; nothing has been established to verify.')
    } else if (verified < total) {
      blockers.push(`Acceptance criteria not all verified (${verified}/${total}).`)
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    summary,
  }
}

export interface MarkHumanReviewInput {
  taskId: string
  claim: Claim
  reason: string
  reviewer?: string
}

/**
 * Pure helper: mark a claim as `needs_human_review` so it stops
 * blocking completion. Use this from a CLI command or TUI when a
 * human explicitly accepts the risk.
 */
export function markHumanReview(claim: Claim, reason: string, _reviewer?: string): Claim {
  return {
    ...claim,
    status: 'needs_human_review',
    reviewerGuidance: reason,
    staleReason: claim.status === 'stale' ? undefined : claim.staleReason,
  }
}

/**
 * Convenience wrapper that re-evaluates after marking a claim for
 * human review. Useful from a TUI command.
 */
export function canCompleteAfterHumanReview(input: CompletionInput, claimId: string, reason: string): CompletionResult {
  const claims = input.claims.map((c) => (c.id === claimId ? markHumanReview(c, reason) : c))
  return evaluateCompletion({ ...input, claims })
}

export function generateReviewId(): string {
  return `human-review:${randomUUID()}`
}
