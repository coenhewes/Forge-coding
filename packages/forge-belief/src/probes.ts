import type { Claim, Hypothesis, ProbeRecommendation, TaskRiskAssessment } from '@forge/types'

/**
 * Inputs to the probe planner.
 *
 * The previous stub accepted a flat `ProbeCandidateInput`; this version
 * keeps the legacy fields for back-compat but layers in:
 *   - a `capabilityHistory` callback so the planner can filter out
 *     probes that already returned `inconclusive` for the same claim;
 *   - a `riskAssessment` for risk-weighted scoring;
 *   - an `evidenceQuality` and `flakiness` map for the optional cost
 *     factors the spec calls out.
 */
export interface ProbeCandidateInput {
  taskId: string
  claims: Claim[]
  hypotheses: Hypothesis[]
  capabilities: string[]
  risk?: TaskRiskAssessment
  /**
   * Optional lookup: `(capability, claimId) → ProbeOutcomeSummary`.
   * If the lookup returns `inconclusive`, the probe is filtered out
   * for that claim (it already failed to give us information).
   */
  priorOutcomes?: (capability: string, claimId: string) => ProbeOutcomeSummary | undefined
  /**
   * Optional lookup for evidence quality. `evidenceQuality` is
   * interpreted as 'low' | 'medium' | 'high' (default 'medium').
   */
  evidenceQuality?: (capability: string) => 'low' | 'medium' | 'high'
  /** Optional flakiness lookup. Default 'low'. */
  flakiness?: (capability: string) => 'low' | 'medium' | 'high'
  /** Optional side-effect risk. Default 'low'. */
  sideEffectRisk?: (capability: string) => 'low' | 'medium' | 'high'
}

export interface ProbeOutcomeSummary {
  outcome: 'supports' | 'contradicts' | 'inconclusive'
  notes?: string
  recordedAt: string
}

/**
 * The full scoring breakdown — every term that contributed to the
 * final score, exposed so the harness can render an explanation in
 * the TUI and the tests can pin the math.
 */
export interface ScoredProbeBreakdown {
  /** Claim importance contribution (0..N) */
  claimImportance: number
  /** Confidence gap = 1 - current_confidence, weighted by claim importance. */
  confidenceGap: number
  /** Discrimination across open hypotheses. */
  hypothesisDiscrimination: number
  /** Quality of the evidence the probe is expected to produce. */
  evidenceQuality: number
  /** Risk reduction (risk-weighted task amplification). */
  riskReduction: number
  /** Runtime cost (subtractive). */
  runtimeCost: number
  /** Side-effect risk (subtractive). */
  sideEffectRisk: number
  /** Flakiness (subtractive). */
  flakiness: number
  /** Final score. */
  total: number
  /** Human-readable summary. */
  explanation: string
}

export interface ScoredProbe {
  probe: ProbeRecommendation
  score: number
  breakdown: ScoredProbeBreakdown
}

const WEIGHT = { high: 1, medium: 0.6, low: 0.25 } as const
const COST = { high: 1, medium: 0.6, low: 0.25 } as const
const FLAKINESS_PENALTY = { high: 0.4, medium: 0.2, low: 0.05 } as const
const SIDE_EFFECT_PENALTY = { high: 0.4, medium: 0.2, low: 0.05 } as const

export class ProbePlanner {
  plan(input: ProbeCandidateInput): ScoredProbe[] {
    const probes = this.enumerate(input)
    return probes
      .map((probe) => {
        const breakdown = scoreProbe(probe, input)
        return { probe, score: breakdown.total, breakdown }
      })
      .filter((scored) => !isBlockedByPriorInconclusive(scored.probe, input))
      .sort((a, b) => b.score - a.score)
  }

  /** The top probe (or `undefined` if no probes are available). */
  next(input: ProbeCandidateInput): ScoredProbe | undefined {
    return this.plan(input)[0]
  }

  private enumerate(input: ProbeCandidateInput): ProbeRecommendation[] {
    const weakClaims = input.claims.filter(
      (c) =>
        c.status === 'unverified' ||
        c.status === 'stale' ||
        c.status === 'partially_verified' ||
        c.status === 'contradicted',
    )
    const plausible = input.hypotheses.filter(
      (h) =>
        h.status === 'plausible' ||
        h.status === 'likely' ||
        h.status === 'unknown' ||
        h.status === 'contradicted',
    )
    const probes: ProbeRecommendation[] = []

    if (input.capabilities.includes('repo.find_definitions')) {
      probes.push(
        makeProbe(input.taskId, 'repo.find_definitions', 'Find definitions for likely affected symbols before editing.', weakClaims, plausible, 'medium'),
      )
    }
    if (input.capabilities.includes('repo.find_callers')) {
      probes.push(
        makeProbe(input.taskId, 'repo.find_callers', 'Trace callers to distinguish direct and downstream behavior.', weakClaims, plausible, 'high'),
      )
    }
    if (input.capabilities.includes('tests.find_related_tests')) {
      probes.push(
        makeProbe(
          input.taskId,
          'tests.find_related_tests',
          'Identify focused tests that can validate or falsify current claims.',
          weakClaims,
          plausible,
          'high',
        ),
      )
    }
    if (input.capabilities.includes('db.get_table_schema')) {
      probes.push(
        makeProbe(
          input.taskId,
          'db.get_table_schema',
          'Inspect database schema for migration or persistence-sensitive claims.',
          weakClaims,
          plausible,
          'medium',
        ),
      )
    }
    if (input.capabilities.includes('auth.trace_permission_check')) {
      probes.push(
        makeProbe(
          input.taskId,
          'auth.trace_permission_check',
          'Trace a permission check end-to-end to localize auth-layer failures.',
          weakClaims,
          plausible,
          'high',
        ),
      )
    }
    if (input.capabilities.includes('auth.find_policy_sources')) {
      probes.push(
        makeProbe(
          input.taskId,
          'auth.find_policy_sources',
          'Locate the policy source(s) responsible for the current guard.',
          weakClaims,
          plausible,
          'medium',
        ),
      )
    }
    if (input.capabilities.includes('db.find_migrations_touching_table')) {
      probes.push(
        makeProbe(
          input.taskId,
          'db.find_migrations_touching_table',
          'Find migrations that touched the table behind the failing claim.',
          weakClaims,
          plausible,
          'medium',
        ),
      )
    }

    probes.push(
      makeProbe(input.taskId, 'run_typecheck', 'Run typecheck as a low-risk consistency probe.', weakClaims, plausible, 'medium'),
    )
    return probes
  }
}

function makeProbe(
  taskId: string,
  capability: string,
  reason: string,
  claims: Claim[],
  hypotheses: Hypothesis[],
  gain: 'low' | 'medium' | 'high',
): ProbeRecommendation {
  return {
    id: `probe:${taskId}:${capability}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
    capability,
    input: {},
    expectedInformationGain: gain,
    cost: capability.startsWith('run_') ? 'medium' : 'low',
    risk: 'low',
    distinguishesHypotheses: hypotheses.slice(0, 3).map((h) => h.id),
    verifiesClaims: claims.slice(0, 3).map((c) => c.id),
    reason,
    requiredPermissions: capability.startsWith('run_') ? ['run_command'] : ['read_repo_graph'],
  }
}

function scoreProbe(probe: ProbeRecommendation, input: ProbeCandidateInput): ScoredProbeBreakdown {
  // 1) Claim importance: weight by risk level.
  const verifiedClaims = probe.verifiesClaims
    .map((id) => input.claims.find((c) => c.id === id))
    .filter((c): c is Claim => Boolean(c))
  const riskLevelToMultiplier: Record<Claim['riskLevel'], number> = {
    critical: 1.5,
    high: 1.2,
    medium: 1,
    low: 0.7,
  }
  const claimImportance = verifiedClaims.reduce(
    (sum, c) => sum + riskLevelToMultiplier[c.riskLevel] * (0.5 + (1 - (c.confidence ?? 0))),
    0,
  )

  // 2) Confidence gap: 1 - current_confidence averaged across the claims.
  const confidenceGap = verifiedClaims.length
    ? verifiedClaims.reduce((sum, c) => sum + (1 - (c.confidence ?? 0)), 0) / verifiedClaims.length
    : 0

  // 3) Hypothesis discrimination: count of plausible hypotheses it touches.
  const hypothesisDiscrimination = Math.min(probe.distinguishesHypotheses.length / 3, 1)

  // 4) Probe-stated expected information gain (declared on the probe
  //    itself). High-gain probes beat medium-gain ones on equal claim
  //    importance.
  const expectedGain = WEIGHT[probe.expectedInformationGain]

  // 5) Evidence quality: how useful the produced evidence is expected to be.
  const evidenceQuality = WEIGHT[input.evidenceQuality?.(probe.capability) ?? 'medium']

  // 6) Risk reduction: amplify when the task is high-risk.
  const riskReduction =
    input.risk && (input.risk.level === 'high' || input.risk.level === 'critical') ? 1 : 0.4

  // 7) Runtime cost: probes that are expensive get penalised.
  const runtimeCost = COST[probe.cost] * 0.6

  // 8) Side-effect risk: write/rerun probes cost more.
  const sideEffectRisk = SIDE_EFFECT_PENALTY[input.sideEffectRisk?.(probe.capability) ?? 'low']

  // 9) Flakiness: flaky probes have reduced information value.
  const flakiness = FLAKINESS_PENALTY[input.flakiness?.(probe.capability) ?? 'low']

  const total =
    claimImportance +
    confidenceGap +
    hypothesisDiscrimination * 0.8 +
    expectedGain +
    evidenceQuality +
    riskReduction -
    runtimeCost -
    sideEffectRisk -
    flakiness

  return {
    claimImportance: round2(claimImportance),
    confidenceGap: round2(confidenceGap),
    hypothesisDiscrimination: round2(hypothesisDiscrimination),
    evidenceQuality: round2(evidenceQuality),
    riskReduction: round2(riskReduction),
    runtimeCost: round2(runtimeCost),
    sideEffectRisk: round2(sideEffectRisk),
    flakiness: round2(flakiness),
    total: round2(total),
    explanation:
      `claimImportance=${round2(claimImportance)} + confidenceGap=${round2(confidenceGap)}` +
      ` + hypothesisDiscrimination=${round2(hypothesisDiscrimination)}` +
      ` + expectedGain=${round2(expectedGain)} + evidenceQuality=${round2(evidenceQuality)}` +
      ` + riskReduction=${round2(riskReduction)}` +
      ` - runtimeCost=${round2(runtimeCost)} - sideEffectRisk=${round2(sideEffectRisk)}` +
      ` - flakiness=${round2(flakiness)} = ${round2(total)}`,
  }
}

function isBlockedByPriorInconclusive(probe: ProbeRecommendation, input: ProbeCandidateInput): boolean {
  if (!input.priorOutcomes) return false
  for (const claimId of probe.verifiesClaims) {
    const outcome = input.priorOutcomes(probe.capability, claimId)
    if (outcome && outcome.outcome === 'inconclusive') return true
  }
  return false
}

function round2(value: number): number {
  return Number(value.toFixed(2))
}
