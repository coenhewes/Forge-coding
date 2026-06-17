import type {
  ActiveVerificationPlan,
  Claim,
  ClaimVerificationState,
  EvidenceRef,
  Hypothesis,
  RepoGraph,
  RepoMap,
  RiskArea,
  RiskSeverity,
  Uncertainty,
  VerificationAction,
  VerificationActionType,
} from '@forge/types'
import { EvidenceValueScorer } from './scorer.js'

export interface VerificationPlannerInput {
  taskId: string
  claims: Claim[]
  hypotheses?: Hypothesis[]
  uncertainties?: Uncertainty[]
  filesChanged?: string[]
  affectedTests?: string[]
  riskAreas?: RiskArea[]
  priorFailedActions?: VerificationAction[]
  repoMap?: RepoMap
  repoGraph?: RepoGraph
  commands?: {
    typecheck?: string
    lint?: string
    build?: string
    test?: string
  }
  /** Optional pre-collected evidence refs (e.g. from prior runs / fixture). */
  supportingEvidence?: EvidenceRef[]
  /** Max candidate count to return. Defaults to 25. */
  maxCandidates?: number
  /** Historical flakiness for a given action signature, 0-1. */
  flakinessHistory?: Record<string, number>
  /** Historical average runtime (ms) for a given action signature. */
  runtimeHistory?: Record<string, number>
  /** Historical setup cost, 0-1. */
  setupHistory?: Record<string, number>
}

const HIGH_RISK_DOMAINS = new Set([
  'auth',
  'permissions',
  'billing',
  'payments',
  'data_deletion',
  'migrations',
  'cryptography',
  'concurrency',
  'public_apis',
  'privacy',
  'security',
  'deployment_config',
  'role_mapping',
  'multi_tenant',
  'secrets',
  'compliance',
])

export class ActiveVerificationPlanner {
  private scorer = new EvidenceValueScorer()

  plan(input: VerificationPlannerInput): ActiveVerificationPlan {
    const candidateActions = this.enumerateActions(input)
    const claims = input.claims
    const scores = candidateActions.map((action) => this.scorer.score(action, claims, { flakinessHistory: input.flakinessHistory, runtimeHistory: input.runtimeHistory, setupHistory: input.setupHistory }))
    const ranked = candidateActions
      .map((action) => {
        const score = scores.find((s) => s.actionId === action.id)
        return {
          action: {
            ...action,
            expectedEvidenceValue: score?.totalScore ?? action.expectedEvidenceValue,
          },
          score: score?.totalScore ?? 0,
        }
      })
      .sort((a, b) => b.score - a.score)

    // Cap the candidate list so a runaway plan doesn't bloat context.
    const limit = Math.max(1, input.maxCandidates ?? 25)
    const top = ranked.slice(0, limit)

    return {
      taskId: input.taskId,
      recommendedAction: top[0]?.action,
      candidateActions: top.map((r) => r.action),
      scores: scores.filter((s) => top.some((r) => r.action.id === s.actionId)),
      claimGaps: this.claimGaps(input.claims, top.map((r) => r.action)),
      warnings: this.warnings(input),
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * Find claims whose supporting evidence references any of the changed
   * files (directly or transitively through the repo graph) and mark
   * them stale. This is the pure-function form used in tests; the
   * `stale.ts` module wraps it with state-store persistence.
   */
  markStaleForChangedFiles(claims: Claim[], filesChanged: string[], reason = 'Source changed after verification'): Claim[] {
    if (filesChanged.length === 0) return claims
    const set = new Set(filesChanged)
    return claims.map((claim) => {
      if (claim.status !== 'verified' && claim.status !== 'partially_verified') return claim
      const referenced = claim.supportingEvidence.some((ref) => refMatchesFile(ref, set))
      if (!referenced) return claim
      return {
        ...claim,
        status: 'stale' as const,
        staleReason: reason,
        confidence: Math.min(claim.confidence, 0.49),
      }
    })
  }

  updateClaimAfterResult(claim: Claim, passed: boolean, evidenceId: string, strongEvidence = true): Claim {
    if (!passed) {
      return {
        ...claim,
        status: 'contradicted',
        confidence: Math.min(claim.confidence, 0.25),
        contradictingEvidence: [...claim.contradictingEvidence, { id: evidenceId }],
      }
    }
    const confidence = Math.max(claim.confidence, thresholdForRisk(claim.riskLevel))
    return {
      ...claim,
      status: confidence >= thresholdForRisk(claim.riskLevel) ? 'verified' : 'partially_verified',
      confidence,
      supportingEvidence: [...claim.supportingEvidence, { id: evidenceId }],
      missingEvidence: [],
    }
  }

  completionBlockers(claims: Claim[], actions: VerificationAction[]): string[] {
    const blockers: string[] = []
    for (const claim of claims) {
      if (claim.status === 'contradicted') blockers.push(`Contradicted claim: ${claim.text}`)
      if (claim.status === 'stale') blockers.push(`Stale claim: ${claim.text}`)
      if ((claim.riskLevel === 'high' || claim.riskLevel === 'critical') && claim.status !== 'verified' && claim.status !== 'needs_human_review' && claim.status !== 'not_applicable') {
        blockers.push(`High-risk claim lacks required evidence: ${claim.text}`)
      }
    }
    for (const action of actions) {
      if (action.status === 'skipped' && action.expectedEvidenceValue >= 3 && !action.selectionReason) {
        blockers.push(`Skipped high-value verification action without reason: ${action.id}`)
      }
    }
    return blockers
  }

  private enumerateActions(input: VerificationPlannerInput): VerificationAction[] {
    const actions: VerificationAction[] = []
    const highRiskClaims = input.claims.filter((c) => c.riskLevel === 'high' || c.riskLevel === 'critical')
    const isHighRiskTask = this.isHighRiskTask(input)

    // 1) For every non-verified claim, propose a targeted check.
    const weakClaims = input.claims.filter((claim) => claim.status !== 'verified' && claim.status !== 'not_applicable')
    for (const claim of weakClaims) {
      const actionType = inferActionType(claim)
      actions.push(
        this.action(input.taskId, actionType, claim, input, `Directly verifies claim: ${claim.text}`),
      )
      if (claim.riskLevel === 'critical' || claim.riskLevel === 'high') {
        // Always pair high/critical risk claims with a security/review
        // action — this is the spec's "at least one security/review
        // candidate for high-risk tasks" requirement.
        actions.push(
          this.action(
            input.taskId,
            isSecurityClaim(claim) ? 'security_check' : 'permission_boundary_check',
            claim,
            input,
            `Risk escalation for ${claim.riskLevel} claim: ${claim.text}`,
          ),
        )
      }
    }

    // 2) Global command actions (typecheck, lint, build, test).
    if (input.commands?.typecheck) actions.push(commandAction(input.taskId, 'typecheck', input.commands.typecheck, weakClaims))
    if (input.commands?.lint) actions.push(commandAction(input.taskId, 'lint', input.commands.lint, weakClaims))
    if (input.commands?.build) actions.push(commandAction(input.taskId, 'build', input.commands.build, weakClaims))
    if (input.commands?.test) actions.push(commandAction(input.taskId, 'unit_test', input.commands.test, weakClaims))

    // 3) For changed files, propose visual/screenshot checks for UI files.
    for (const file of input.filesChanged ?? []) {
      if (isFrontendFile(file)) {
        for (const claim of weakClaims) {
          actions.push(
            this.action(
              input.taskId,
              'visual_check',
              claim,
              input,
              `Frontend file ${file} changed — visual check covers ${claim.text}`,
              [file],
            ),
          )
        }
      }
      if (isMigrationFile(file)) {
        for (const claim of weakClaims) {
          actions.push(
            this.action(
              input.taskId,
              'migration_up_check',
              claim,
              input,
              `Migration file ${file} changed — verify up-migration for ${claim.text}`,
              [file],
            ),
          )
          actions.push(
            this.action(
              input.taskId,
              'migration_down_check',
              claim,
              input,
              `Migration file ${file} changed — verify down-migration for ${claim.text}`,
              [file],
            ),
          )
        }
      }
    }

    // 4) For every open uncertainty, propose a probe-style action so
    //    the planner has a candidate even when claims are still empty.
    for (const uncertainty of input.uncertainties ?? []) {
      actions.push(
        this.uncertaintyAction(input.taskId, uncertainty, input),
      )
    }

    // 5) If the task touches a high-risk area but no claim currently
    //    drives a security check, add a top-level review candidate.
    if (isHighRiskTask && highRiskClaims.length > 0) {
      const alreadyHasReview = actions.some(
        (a) => a.actionType === 'security_check' || a.actionType === 'manual_human_review' || a.actionType === 'reviewer_confirmation',
      )
      if (!alreadyHasReview) {
        for (const claim of highRiskClaims) {
          actions.push(
            this.action(
              input.taskId,
              'manual_human_review',
              claim,
              input,
              `High-risk task (${claim.riskLevel}) requires human review of: ${claim.text}`,
            ),
          )
        }
      }
    }

    return dedupeActions(actions)
  }

  private isHighRiskTask(input: VerificationPlannerInput): boolean {
    if ((input.riskAreas ?? []).some((a) => a.severity === 'high' || a.severity === 'critical')) return true
    if (input.claims.some((c) => c.riskLevel === 'high' || c.riskLevel === 'critical')) return true
    const text = (input.claims.map((c) => c.text).join(' ') + ' ' + (input.hypotheses ?? []).map((h) => h.claim).join(' ')).toLowerCase()
    if (/auth|permission|role|sso|invite/.test(text)) return true
    if (/billing|payment|invoice|charge/.test(text)) return true
    if (/migration|migrat|schema/.test(text)) return true
    if (/secret|crypt|token|password/.test(text)) return true
    if (/multi-tenant|tenant|isolation/.test(text)) return true
    if (/privacy|gdpr|pii|delete/.test(text)) return true
    if (input.filesChanged?.some((f) => /auth|permission|security|migration|secret|billing/.test(f))) return true
    return false
  }

  private action(
    taskId: string,
    actionType: VerificationActionType,
    claim: Claim,
    input: VerificationPlannerInput,
    reason: string,
    fileScope?: string[],
  ): VerificationAction {
    return {
      id: `verification:${taskId}:${actionType}:${claim.id}${fileScope ? ':' + fileScope.join(',') : ''}`,
      taskId,
      actionType,
      command: defaultCommand(actionType, input),
      capability: actionType === 'manual_human_review' ? undefined : capabilityFor(actionType),
      targetClaims: [claim.id],
      targetAcceptanceCriteria: claim.acceptanceCriterionRefs,
      targetHypotheses: input.hypotheses?.slice(0, 3).map((h) => h.id) ?? [],
      targetRisks: [claim.riskLevel],
      estimatedCost: actionType === 'e2e_test' || actionType === 'build' ? 'high' : 'medium',
      flakinessRisk: actionType === 'e2e_test' || actionType === 'visual_check' ? 'medium' : 'low',
      setupCost: actionType === 'manual_human_review' ? 'high' : 'low',
      evidenceQuality: claim.riskLevel === 'critical' ? 'high' : 'medium',
      reviewUsefulness: claim.riskLevel === 'critical' || claim.riskLevel === 'high' ? 'high' : 'medium',
      expectedEvidenceValue: 0,
      selectionReason: reason,
      status: 'candidate',
    }
  }

  private uncertaintyAction(taskId: string, uncertainty: Uncertainty, input: VerificationPlannerInput): VerificationAction {
    const type: VerificationActionType = uncertainty.riskLevel === 'critical' || uncertainty.riskLevel === 'high'
      ? 'security_check'
      : 'runtime_trace'
    return {
      id: `verification:${taskId}:${type}:${uncertainty.id}`,
      taskId,
      actionType: type,
      capability: type === 'security_check' ? 'auth.find_policy_sources' : 'repo.find_definitions',
      targetClaims: [],
      targetAcceptanceCriteria: [],
      targetHypotheses: input.hypotheses?.slice(0, 3).map((h) => h.id) ?? [],
      targetRisks: [uncertainty.riskLevel],
      estimatedCost: 'low',
      flakinessRisk: 'low',
      setupCost: 'low',
      evidenceQuality: 'medium',
      reviewUsefulness: 'medium',
      expectedEvidenceValue: 0,
      selectionReason: `Open uncertainty: ${uncertainty.text}`,
      status: 'candidate',
    }
  }

  private claimGaps(claims: Claim[], actions: VerificationAction[]): ClaimVerificationState[] {
    return claims.map((claim) => ({
      claimId: claim.id,
      text: claim.text,
      status: claim.status,
      confidence: claim.confidence,
      riskLevel: claim.riskLevel,
      supportingEvidence: claim.supportingEvidence.map((e) => e.id),
      contradictingEvidence: claim.contradictingEvidence.map((e) => e.id),
      missingEvidence: claim.missingEvidence,
      requiredActions: actions.filter((a) => a.targetClaims.includes(claim.id) && (claim.riskLevel === 'high' || claim.riskLevel === 'critical')).map((a) => a.id),
      candidateActions: actions.filter((a) => a.targetClaims.includes(claim.id)).map((a) => a.id),
      staleReason: claim.staleReason,
    }))
  }

  private warnings(input: VerificationPlannerInput): string[] {
    const warnings: string[] = []
    for (const claim of input.claims) {
      if (claim.status === 'contradicted') warnings.push(`Contradicted claim blocks completion: ${claim.text}`)
      if (claim.status === 'stale') warnings.push(`Stale verification must be refreshed: ${claim.text}`)
      if (claim.riskLevel === 'critical' && claim.status !== 'verified' && claim.status !== 'needs_human_review' && claim.status !== 'not_applicable') {
        warnings.push(`Critical claim requires high-quality evidence or human review: ${claim.text}`)
      }
    }
    if (this.isHighRiskTask(input) && !input.claims.some((c) => c.riskLevel === 'high' || c.riskLevel === 'critical')) {
      warnings.push('High-risk task detected but no high/critical-risk claims are tracked; consider escalating risk model.')
    }
    return warnings
  }
}

function inferActionType(claim: Claim): VerificationActionType {
  const text = claim.text.toLowerCase()
  if (/permission|auth|role|non-admin|admin|sso/.test(text)) return 'permission_boundary_check'
  if (/api|endpoint|request|response/.test(text)) return 'api_test'
  if (/migration|database|schema/.test(text)) return 'migration_up_check'
  if (/ui|frontend|component|visual|screen/.test(text)) return 'frontend_component_test'
  if (/security|privacy|secret/.test(text)) return 'security_check'
  return 'unit_test'
}

function isSecurityClaim(claim: Claim): boolean {
  const text = claim.text.toLowerCase()
  return /security|privacy|secret|encryption|secrets|password|token/.test(text)
}

function isFrontendFile(file: string): boolean {
  return /frontend|\.tsx?$|\.jsx?$|components?\//.test(file)
}

function isMigrationFile(file: string): boolean {
  return /migrat|schema|db\/|\.sql$/.test(file)
}

function defaultCommand(actionType: VerificationActionType, input: VerificationPlannerInput): string | undefined {
  if (actionType === 'typecheck') return input.commands?.typecheck
  if (actionType === 'lint') return input.commands?.lint
  if (actionType === 'build') return input.commands?.build
  if (actionType.endsWith('test') || actionType === 'permission_boundary_check') return input.commands?.test
  return undefined
}

function capabilityFor(actionType: VerificationActionType): string | undefined {
  if (actionType === 'migration_up_check' || actionType === 'migration_down_check') return 'db.find_migrations_touching_table'
  if (actionType === 'permission_boundary_check') return 'tests.find_related_tests'
  if (actionType === 'direct_api_probe') return 'repo.search_code'
  if (actionType === 'security_check') return 'auth.find_policy_sources'
  if (actionType === 'frontend_component_test' || actionType === 'visual_check') return 'frontend.find_route_component'
  if (actionType === 'runtime_trace') return 'repo.find_definitions'
  return undefined
}

function commandAction(taskId: string, actionType: VerificationActionType, command: string, claims: Claim[]): VerificationAction {
  return {
    id: `verification:${taskId}:${actionType}:${command}`,
    taskId,
    actionType,
    command,
    targetClaims: claims.map((claim) => claim.id),
    targetAcceptanceCriteria: claims.flatMap((claim) => claim.acceptanceCriterionRefs),
    targetHypotheses: [],
    targetRisks: [...new Set(claims.map((claim) => claim.riskLevel))],
    estimatedCost: actionType === 'build' ? 'high' : 'medium',
    flakinessRisk: 'low',
    setupCost: 'low',
    evidenceQuality: actionType === 'typecheck' || actionType === 'build' ? 'medium' : 'high',
    reviewUsefulness: 'medium',
    expectedEvidenceValue: 0,
    selectionReason: `Repository ${actionType} command contributes broad consistency evidence.`,
    status: 'candidate',
  }
}

function dedupeActions(actions: VerificationAction[]): VerificationAction[] {
  const seen = new Set<string>()
  return actions.filter((action) => {
    const key = `${action.actionType}:${action.command ?? action.capability ?? ''}:${action.targetClaims.join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function thresholdForRisk(risk: RiskSeverity): number {
  if (risk === 'critical') return 0.9
  if (risk === 'high') return 0.8
  if (risk === 'medium') return 0.65
  return 0.5
}

/** Check whether an evidence ref refers to any of the given files. */
function refMatchesFile(ref: EvidenceRef, fileSet: Set<string>): boolean {
  if (!ref.artifactRef) return false
  for (const file of fileSet) {
    if (ref.artifactRef === file) return true
    if (ref.artifactRef.includes(file)) return true
  }
  return false
}

export { HIGH_RISK_DOMAINS }
