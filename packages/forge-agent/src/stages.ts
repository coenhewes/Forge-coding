/**
 * Belief-guided stage machine.
 *
 * The agent loop is a sequence of explicit stages driven by belief +
 * verification state. Each stage emits a trace event so the TUI can
 * show what the agent is doing. The stage machine is pure — given a
 * `StageContext` it returns the next stage to run. The orchestrator
 * (the AgentLoop class) handles all I/O.
 */
import type {
  Claim,
  Hypothesis,
  ProbeRecommendation,
  TaskBeliefState,
  VerificationAction,
} from '@forge/types'

export type StageName =
  | 'LOCALIZE'
  | 'PROBE'
  | 'EDIT'
  | 'VERIFY'
  | 'REPAIR'
  | 'FINALIZE'

/** Confidence threshold above which EDIT is allowed. */
export const DEFAULT_EDIT_CONFIDENCE = 0.6

/** Max probes per loop pass before we move to EDIT anyway. */
export const DEFAULT_MAX_PROBES_PER_PASS = 2

export interface StageContext {
  belief: TaskBeliefState | null
  /** Top hypothesis (highest confidence, status ∈ {plausible, likely}). */
  topHypothesis: Hypothesis | null
  /** Open unverified claims ordered by importance (desc). */
  openClaims: Claim[]
  /** Top probe recommendation from ProbePlanner, or null. */
  topProbe: ProbeRecommendation | null
  /** Top verification action from VerificationPlanner, or null. */
  topVerifyAction: VerificationAction | null
  /** True iff `canComplete()` is satisfied. */
  canComplete: boolean
  /** True iff the most recent verify attempt failed. */
  verifyFailed: boolean
  /** Probe iteration counter (resets per loop pass). */
  probesThisPass: number
  /** Pass id — bumped when we re-enter PROBE from REPAIR. */
  passId: number
  /** Free-form notes that downstream stages might consult. */
  notes: Record<string, unknown>
}

export interface StageDecision {
  next: StageName
  /** Free-form reason — emitted on the trace. */
  reason: string
}

/**
 * Decide the next stage from the current state. Pure function — no
 * side effects, no I/O. Used by the orchestrator to drive the loop.
 *
 * The ordering is:
 *   1. If `verifyFailed` → REPAIR.
 *   2. If `canComplete` → FINALIZE.
 *   3. If a high-uncertainty claim exists AND a probe is available
 *      AND we haven't hit the per-pass cap → PROBE.
 *   4. If the top hypothesis has confidence > threshold → EDIT.
 *   5. If the top hypothesis is unknown/contradicted/disproven → REPAIR.
 *   6. Fallback → REPAIR (we don't have a viable plan).
 */
export function nextStage(ctx: StageContext, options: {
  editConfidence?: number
  maxProbesPerPass?: number
} = {}): StageDecision {
  const editConfidence = options.editConfidence ?? DEFAULT_EDIT_CONFIDENCE
  const maxProbes = options.maxProbesPerPass ?? DEFAULT_MAX_PROBES_PER_PASS

  if (ctx.verifyFailed) {
    return { next: 'REPAIR', reason: 'Most recent verify action failed' }
  }

  if (ctx.canComplete) {
    return { next: 'FINALIZE', reason: 'Verification planner reports completion ready' }
  }

  if (
    ctx.topProbe
    && ctx.openClaims.length > 0
    && ctx.probesThisPass < maxProbes
    && hasHighUncertaintyClaim(ctx.openClaims)
  ) {
    return { next: 'PROBE', reason: 'High-uncertainty claim with discriminating probe available' }
  }

  if (ctx.topHypothesis) {
    const h = ctx.topHypothesis
    if (h.status === 'disproven' || h.status === 'contradicted') {
      return { next: 'REPAIR', reason: `Top hypothesis ${h.id} is ${h.status}` }
    }
    if (h.confidence >= editConfidence && h.status !== 'unknown') {
      return { next: 'EDIT', reason: `Top hypothesis ${h.id} confidence ${h.confidence.toFixed(2)} >= ${editConfidence}` }
    }
    // Low-confidence hypothesis: fall through. We only reach here once probing
    // is exhausted (the PROBE branch above didn't fire), so there is no way
    // left to raise confidence by investigating — looping in REPAIR would spin
    // forever. Attempt an implementation instead (see below).
  }

  // No confident/actionable hypothesis. A straightforward implement task may
  // never form one (the work is "just do it", not "investigate"), and once
  // probes are exhausted, attempting an EDIT is how the agent makes progress
  // and generates real evidence. REPAIR is reserved for a failed verify
  // (handled at the top) or a disproven hypothesis (handled above).
  if (ctx.openClaims.length > 0) {
    return { next: 'EDIT', reason: 'Open acceptance criteria remain and probes are exhausted — attempt implementation' }
  }

  return { next: 'REPAIR', reason: 'No viable hypothesis — request diagnostic' }
}

/** Pick the open unverified claims (excluding not_applicable). */
export function openClaimsFor(belief: TaskBeliefState | null): Claim[] {
  if (!belief) return []
  return belief.claims
    .filter((c) => c.status === 'unverified' || c.status === 'partially_verified' || c.status === 'stale' || c.status === 'contradicted')
    .sort((a, b) => claimImportance(b) - claimImportance(a))
}

/** Pick the top hypothesis (highest confidence, status in plausible/likely). */
export function topHypothesisFor(belief: TaskBeliefState | null): Hypothesis | null {
  if (!belief) return null
  const candidates = belief.hypotheses
    .filter((h) => h.status !== 'disproven' && h.status !== 'superseded')
    .sort((a, b) => b.confidence - a.confidence)
  return candidates[0] ?? null
}

function hasHighUncertaintyClaim(claims: Claim[]): boolean {
  return claims.some((c) => c.confidence < 0.5)
}

function claimImportance(c: Claim): number {
  if (c.riskLevel === 'critical') return 1.0
  if (c.riskLevel === 'high') return 0.8
  if (c.riskLevel === 'medium') return 0.5
  return 0.3
}
