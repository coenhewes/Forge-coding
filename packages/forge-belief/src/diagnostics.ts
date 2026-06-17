import type { CapabilityObservation, Claim, EvidenceRef, Hypothesis, ProbeRecommendation } from '@forge/types'

/**
 * Diagnostic input.
 *
 * The original `DiagnosticInput` only had `taskId`, `output`, and
 * `source`. The extended version adds:
 *   - `failedFilePaths` — paths extracted from the failed check (test
 *     file, source file, etc.). Used to localise the failing region.
 *   - `graphRegionResolver` — a `(paths) → GraphRegion | undefined`
 *     function. Callers can wire this to `harness.getRelatedGraphRegion`
 *     (Track 5) or fall back to the default heuristic below.
 *   - `taskBelief` — the current `TaskBeliefState`. Used to pick the
 *     most discriminating hypothesis and to seed `distinguishesHypotheses`
 *     for the suggested probe.
 */
export interface DiagnosticInput {
  taskId: string
  output: string
  source: 'test' | 'typecheck' | 'lint' | 'runtime' | 'ci' | 'review'
  failedFilePaths?: string[]
  graphRegionResolver?: (filePaths: string[]) => GraphRegionResolution | undefined
  taskBelief?: {
    claims: Claim[]
    hypotheses: Hypothesis[]
  }
}

export interface GraphRegionResolution {
  regionId: string
  label: string
  /** Capability names available in this region (e.g. 'auth.trace_permission_check'). */
  capabilities: string[]
  /** Belief node ids inside this region (used as `relevantGraphNodes`). */
  nodeIds: string[]
}

/**
 * Each root-cause hypothesis returned by the diagnostic engine is
 * a complete `Hypothesis` (so the caller can persist it through
 * `BeliefStore.addHypothesis`) plus a few diagnostic fields that
 * explain why it was proposed.
 */
export interface DiagnosticHypothesis {
  hypothesis: Hypothesis
  /** Evidence refs pointing at the failed check / stack trace. */
  contradictingEvidence: EvidenceRef[]
  /** At least one alternative-cause candidate (supporting evidence). */
  supportingAlternatives: EvidenceRef[]
  /** A discriminating probe that separates this hypothesis from siblings. */
  suggestedProbe: ProbeRecommendation
  /** Free-text explanation for the TUI. */
  rationale: string
  /** Numeric confidence (0..1). */
  confidence: number
}

/**
 * The diagnostic engine. Given a failed check, it proposes 1-3
 * candidate root-cause hypotheses and a discriminating probe.
 *
 * The engine is intentionally narrow — it doesn't try to be a full
 * fault-localiser. It produces a small, evidence-backed set of
 * candidates that the harness can then turn into proper task belief
 * state rows.
 */
export class DiagnosticEngine {
  diagnose(input: DiagnosticInput): CapabilityObservation {
    const lower = input.output.toLowerCase()
    const likelyDomains: string[] = []
    if (/permission|forbidden|401|403|auth|role|guard|require|admin/.test(lower)) {
      likelyDomains.push('auth', 'permissions', 'backend')
    }
    if (/migration|database|sql|schema|column|table/.test(lower)) {
      likelyDomains.push('database', 'backend')
    }
    if (/tsx|jsx|component|render|viewport|css/.test(lower)) likelyDomains.push('frontend')
    if (/type error|typescript|tsc|cannot find/.test(lower)) likelyDomains.push('shared')

    const domainSummary = likelyDomains.length > 0 ? likelyDomains.join(', ') : 'unknown'

    // File-path-driven hypotheses. For each failed file path we
    // extract a "route guard vs role mapping vs session expiry" style
    // hypothesis set when the file looks like an auth/middleware file.
    const fileHypotheses = input.failedFilePaths?.flatMap((p) => perFileHypotheses(p, lower)) ?? []
    const relatedRegion = input.graphRegionResolver
      ? input.graphRegionResolver(input.failedFilePaths ?? [])
      : undefined

    const beliefUpdates: CapabilityObservation['beliefUpdates'] = []
    for (const domain of likelyDomains) {
      beliefUpdates.push({
        action: 'support',
        targetId: `domain:${domain}`,
        reason: `Failure output contains ${domain}-related signal.`,
        confidenceDelta: 0.15,
      })
    }
    // Demote hypotheses that look like frontend-only guards when
    // backend signals are present.
    if (likelyDomains.includes('auth') && likelyDomains.includes('backend')) {
      beliefUpdates.push({
        action: 'demote',
        targetId: 'hypothesis:frontend_button_guard',
        reason: 'Backend signal in failure output rules out frontend-only cause.',
        confidenceDelta: -0.3,
      })
    }

    return {
      observation: {
        type: `${input.source}_failure`,
        summary: `Diagnostic signal points to: ${domainSummary}`,
        payload: {
          source: input.source,
          likelyDomains,
          excerpt: input.output.slice(0, 1000),
          failedFilePaths: input.failedFilePaths ?? [],
          region: relatedRegion,
          fileHypotheses,
        },
      },
      beliefUpdates,
      newUncertainties: likelyDomains.length === 0 ? ['Failure output did not map cleanly to a known domain.'] : [],
      verificationImplications: likelyDomains.map((domain) => `${domain} regression checks required`),
      suggestedNextProbes: pickSuggestedProbe(input, fileHypotheses, relatedRegion),
    }
  }

  /**
   * Propose 1-3 root-cause `Hypothesis` records from a failed check.
   * Each links to the failed check as contradicting evidence plus at
   * least one supporting alternative-cause candidate so the truth
   * layer can immediately discriminate it.
   */
  proposeRootCauseHypotheses(input: DiagnosticInput): DiagnosticHypothesis[] {
    const lower = input.output.toLowerCase()
    const out: DiagnosticHypothesis[] = []
    const failedEvidence: EvidenceRef[] = (input.failedFilePaths ?? []).map((p) => ({
      id: `failed-evidence:${p}`,
      summary: `failure in ${p}`,
    }))
    if (failedEvidence.length === 0) {
      failedEvidence.push({ id: `failed-evidence:${input.taskId}`, summary: 'failed check output' })
    }

    // Determine the hypothesis set from the file paths / output text.
    if (isAuthMiddlewareFailure(input, lower)) {
      out.push(
        {
          hypothesis: makeHyp(
            'hypothesis:route_guard',
            'The route guard is misconfigured for the current actor (e.g. checks stale role names).',
            'auth,backend',
            0.55,
            input,
          ),
          contradictingEvidence: failedEvidence,
          supportingAlternatives: [
            { id: 'alt:role-mapping', summary: 'Role alias mapping may be the actual cause' },
            { id: 'alt:session-expiry', summary: 'Session may have expired and the guard correctly redirected' },
          ],
          suggestedProbe: makeProbe('auth.trace_permission_check', input),
          rationale: 'Auth/middleware path detected in failure; route guard is the most direct cause.',
          confidence: 0.55,
        },
        {
          hypothesis: makeHyp(
            'hypothesis:role_mapping',
            'The role alias mapping is wrong (e.g. SSO admin is not normalised to admin).',
            'auth,backend',
            0.4,
            input,
          ),
          contradictingEvidence: failedEvidence,
          supportingAlternatives: [
            { id: 'alt:route-guard', summary: 'Route guard may have stale role names too' },
            { id: 'alt:database-migration', summary: 'Role values may not have been backfilled' },
          ],
          suggestedProbe: makeProbe('auth.find_policy_sources', input),
          rationale: 'Auth/middleware path detected; role alias drift is a common sibling cause.',
          confidence: 0.4,
        },
        {
          hypothesis: makeHyp(
            'hypothesis:session_expiry',
            'The session expired between login and the failing call.',
            'auth,backend',
            0.25,
            input,
          ),
          contradictingEvidence: failedEvidence,
          supportingAlternatives: [
            { id: 'alt:route-guard', summary: 'Route guard may be rejecting a valid session too aggressively' },
          ],
          suggestedProbe: makeProbe('auth.trace_permission_check', input),
          rationale: 'Auth/middleware path detected; session expiry is a third plausible cause.',
          confidence: 0.25,
        },
      )
    } else if (/migration|database|sql|schema/.test(lower)) {
      out.push({
        hypothesis: makeHyp(
          'hypothesis:migration_drift',
          'A recent migration changed column/table shape and the call site is stale.',
          'database,backend',
          0.6,
          input,
        ),
        contradictingEvidence: failedEvidence,
        supportingAlternatives: [
          { id: 'alt:query-typo', summary: 'Plain query bug is also possible' },
        ],
        suggestedProbe: makeProbe('db.find_migrations_touching_table', input),
        rationale: 'Failure output mentions SQL/schema/migration.',
        confidence: 0.6,
      })
    } else if (/type error|typescript|tsc|cannot find/.test(lower)) {
      out.push({
        hypothesis: makeHyp(
          'hypothesis:type_drift',
          'Type drift across packages — the export no longer matches the consumer.',
          'shared,backend',
          0.55,
          input,
        ),
        contradictingEvidence: failedEvidence,
        supportingAlternatives: [
          { id: 'alt:misnamed-export', summary: 'A simple rename or typo is also possible' },
        ],
        suggestedProbe: makeProbe('repo.find_definitions', input),
        rationale: 'Failure output is a TypeScript error.',
        confidence: 0.55,
      })
    } else {
      out.push({
        hypothesis: makeHyp(
          'hypothesis:unknown_cause',
          'Failure did not map cleanly to a known domain; further probe required.',
          'unknown',
          0.3,
          input,
        ),
        contradictingEvidence: failedEvidence,
        supportingAlternatives: [],
        suggestedProbe: makeProbe('repo.find_definitions', input),
        rationale: 'Generic fallback hypothesis.',
        confidence: 0.3,
      })
    }

    return out
  }
}

function isAuthMiddlewareFailure(input: DiagnosticInput, lower: string): boolean {
  if (/auth|permission|forbidden|401|403|role|guard/.test(lower)) return true
  return (input.failedFilePaths ?? []).some((p) => /(auth|middleware|guard|policy|require)/i.test(p))
}

function perFileHypotheses(filePath: string, lower: string): Array<{ kind: string; filePath: string }> {
  if (!/(auth|middleware|guard|policy|require)/i.test(filePath)) return []
  const result: Array<{ kind: string; filePath: string }> = []
  if (/middleware|guard|require/.test(filePath)) {
    result.push({ kind: 'route_guard', filePath })
  }
  if (/auth|policy|role/.test(lower) || /auth|policy|role/.test(filePath)) {
    result.push({ kind: 'role_mapping', filePath })
  }
  result.push({ kind: 'session_expiry', filePath })
  return result
}

function pickSuggestedProbe(
  input: DiagnosticInput,
  fileHypotheses: Array<{ kind: string }>,
  region?: GraphRegionResolution,
): ProbeRecommendation[] | undefined {
  if (region?.capabilities.includes('auth.trace_permission_check')) {
    return [makeProbe('auth.trace_permission_check', input)]
  }
  if (fileHypotheses.length === 0) return undefined
  if (fileHypotheses.some((h) => h.kind === 'route_guard' || h.kind === 'session_expiry')) {
    return [makeProbe('auth.trace_permission_check', input)]
  }
  return [makeProbe('auth.find_policy_sources', input)]
}

function makeHyp(
  id: string,
  claim: string,
  domainsCsv: string,
  confidence: number,
  input: DiagnosticInput,
): Hypothesis {
  const nowIso = new Date().toISOString()
  return {
    id: `${id}:${input.taskId}`,
    claim,
    status: 'plausible',
    confidence,
    relevantDomains: domainsCsv.split(','),
    relevantGraphNodes: input.failedFilePaths ?? [],
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  }
}

function makeProbe(capability: string, input: DiagnosticInput): ProbeRecommendation {
  return {
    id: `probe:${input.taskId}:${capability}:diagnostic`,
    capability,
    input: { failedFilePaths: input.failedFilePaths ?? [] },
    expectedInformationGain: 'high',
    cost: 'low',
    risk: 'low',
    distinguishesHypotheses: [],
    verifiesClaims: (input.taskBelief?.claims ?? []).slice(0, 3).map((c) => c.id),
    reason: `Discriminate among diagnostic candidates (${capability})`,
    requiredPermissions: ['read_repo_graph'],
  }
}
