import type { Claim, EvidenceValueScore, VerificationAction, RiskSeverity } from '@forge/types'

/**
 * Optional context the scorer can use to break ties / refine weight.
 * Lives in this file (not in @forge/types) so it's a planner-only
 * concern; other packages can keep importing the bare scorer if they
 * want.
 */
export interface ScorerContext {
  /** Historical flakiness for a given action signature, 0-1. */
  flakinessHistory?: Record<string, number>
  /** Historical average runtime (ms) for a given action signature. */
  runtimeHistory?: Record<string, number>
  /** Setup cost from historical data, 0-1. */
  setupHistory?: Record<string, number>
  /** Per-action flakiness score override, 0-1. */
  flakinessScoreOverride?: number
  /** Number of affected tests for this task. */
  affectedTestCount?: number
}

/**
 * Deterministic scoring for verification actions. The same `(action,
 * claims, ctx)` triple must always produce the same `EvidenceValueScore`.
 *
 * Components (positive = value, negative = cost):
 *   uncertainty_reduction   = claim_importance * (1 - current_confidence)
 *   hypothesis_discrimination
 *   risk
 *   evidence_quality
 *   review_usefulness
 *   runtime_penalty
 *   setup_penalty
 *   flakiness_penalty
 */
export class EvidenceValueScorer {
  score(action: VerificationAction, claims: Claim[], ctx: ScorerContext = {}): EvidenceValueScore {
    const targetClaims = claims.filter((claim) => action.targetClaims.includes(claim.id))
    const claimImportance = computeClaimImportance(targetClaims)
    const currentConfidence = averageConfidence(targetClaims)
    const uncertaintyReduction = claimImportance * (1 - currentConfidence)
    const hypothesisDiscrimination = Math.min(1, action.targetHypotheses.length * 0.35)
    const risk = maxRiskWeight(targetClaims)
    const evidenceQuality = qualityWeight(action.evidenceQuality ?? 'medium')
    const reviewUsefulness = qualityWeight(action.reviewUsefulness ?? 'medium')

    const runtimePenalty = costPenalty(action.estimatedCost ?? 'medium')
    const flakinessPenalty = computeFlakinessPenalty(action, ctx)
    const setupPenalty = computeSetupPenalty(action, ctx)
    const contextPenalty = action.actionType === 'e2e_test' || action.actionType === 'build' ? 0.2 : 0.05

    const totalScore =
      uncertaintyReduction +
      hypothesisDiscrimination +
      risk +
      evidenceQuality +
      reviewUsefulness -
      runtimePenalty -
      flakinessPenalty -
      setupPenalty -
      contextPenalty

    const rounded = round2(totalScore)
    return {
      actionId: action.id,
      totalScore: rounded,
      components: {
        claimImportance: round2(uncertaintyReduction),
        expectedConfidenceShift: round2(hypothesisDiscrimination),
        riskWeight: round2(risk),
        hypothesisDiscrimination: round2(hypothesisDiscrimination),
        evidenceQuality: round2(evidenceQuality),
        reviewUsefulness: round2(reviewUsefulness),
        runtimePenalty: round2(runtimePenalty),
        flakinessPenalty: round2(flakinessPenalty),
        setupPenalty: round2(setupPenalty),
        contextPenalty: round2(contextPenalty),
      },
      explanation: `score=${rounded}: uncertainty_reduction=${round2(uncertaintyReduction)} (imp=${round2(claimImportance)} × 1−conf=${round2(1 - currentConfidence)}) + risk=${round2(risk)} + evidence=${round2(evidenceQuality)} + review=${round2(reviewUsefulness)} − runtime=${round2(runtimePenalty)} − flake=${round2(flakinessPenalty)} − setup=${round2(setupPenalty)} − ctx=${round2(contextPenalty)}`,
    }
  }
}

function computeClaimImportance(claims: Claim[]): number {
  if (claims.length === 0) return 0.5
  const max = claims.reduce((m, c) => Math.max(m, riskWeight(c.riskLevel)), 0)
  return max
}

function averageConfidence(claims: Claim[]): number {
  if (claims.length === 0) return 0
  return claims.reduce((s, c) => s + c.confidence, 0) / claims.length
}

function maxRiskWeight(claims: Claim[]): number {
  if (claims.length === 0) return 0.5
  return claims.reduce((m, c) => Math.max(m, riskWeight(c.riskLevel)), 0)
}

function computeFlakinessPenalty(action: VerificationAction, ctx: ScorerContext): number {
  if (ctx.flakinessScoreOverride !== undefined) {
    return clamp01(ctx.flakinessScoreOverride)
  }
  const signature = actionSignature(action)
  const historical = ctx.flakinessHistory?.[signature]
  if (historical !== undefined) {
    return clamp01(historical)
  }
  return costPenalty(action.flakinessRisk ?? 'low')
}

function computeSetupPenalty(action: VerificationAction, ctx: ScorerContext): number {
  const signature = actionSignature(action)
  const historical = ctx.setupHistory?.[signature]
  if (historical !== undefined) {
    return clamp01(historical)
  }
  return costPenalty(action.setupCost ?? 'low')
}

function actionSignature(action: VerificationAction): string {
  return `${action.actionType}:${action.command ?? action.capability ?? ''}`
}

function riskWeight(risk: RiskSeverity): number {
  if (risk === 'critical') return 1.4
  if (risk === 'high') return 1
  if (risk === 'medium') return 0.65
  return 0.35
}

function qualityWeight(value: 'low' | 'medium' | 'high'): number {
  if (value === 'high') return 1
  if (value === 'medium') return 0.6
  return 0.25
}

function costPenalty(value: 'low' | 'medium' | 'high'): number {
  if (value === 'high') return 0.8
  if (value === 'medium') return 0.4
  return 0.1
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
