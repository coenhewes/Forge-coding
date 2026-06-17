import type {
  BeliefEdge,
  BeliefEdgeType,
  BeliefNode,
  BeliefNodeType,
  BeliefStatus,
  CapabilityObservation,
  Claim,
  Contradiction,
  DomainBelief,
  EvidenceRef,
  Hypothesis,
  ProbeRecommendation,
  TaskBeliefState,
} from '@forge/types'

export interface CreateBeliefStateInput {
  taskId: string
  repoId: string
  goal: string
  acceptanceCriteria?: string[]
  selectedDomains?: DomainBelief[]
}

export class ActiveRepoBeliefGraph {
  createTaskState(input: CreateBeliefStateInput): TaskBeliefState {
    const now = new Date().toISOString()
    const hypotheses = this.initialHypotheses(input.goal, input.selectedDomains ?? [], now)
    const claims = this.initialClaims(input.taskId, input.acceptanceCriteria ?? [], now)
    const nodes: BeliefNode[] = [
      this.node(`task:${input.taskId}`, 'Task', input.goal, 'likely', 1),
      ...hypotheses.map((h) => this.node(h.id, 'Hypothesis', h.claim, h.status, h.confidence)),
      ...claims.map((c) => this.node(c.id, 'Claim', c.text, c.status === 'verified' ? 'verified' : 'unknown', c.confidence)),
    ]
    const edges: BeliefEdge[] = [
      ...hypotheses.map((h) => this.edge(`edge:${input.taskId}:${h.id}`, `task:${input.taskId}`, h.id, 'localizes_to', h.confidence)),
      ...claims.map((c) => this.edge(`edge:${input.taskId}:${c.id}`, `task:${input.taskId}`, c.id, 'requires_verification', c.confidence)),
    ]
    return {
      taskId: input.taskId,
      repoId: input.repoId,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      selectedDomains: input.selectedDomains ?? [],
      selectedGraphRegions: [],
      hypotheses,
      claims,
      assumptions: [],
      uncertainties: [],
      evidenceRefs: [],
      contradictions: [],
      nodes,
      edges,
      nextBestProbe: this.recommendProbe(input.taskId, hypotheses, claims),
      verificationObligations: claims.map((claim) => ({
        id: `obligation:${claim.id}`,
        claimId: claim.id,
        acceptanceCriterionId: claim.acceptanceCriterionRefs[0],
        check: `Verify claim: ${claim.text}`,
        riskLevel: claim.riskLevel,
        required: claim.riskLevel === 'high' || claim.riskLevel === 'critical',
      })),
      humanReviewRequirements: [],
      updatedAt: now,
    }
  }

  applyObservation(state: TaskBeliefState, observation: CapabilityObservation, evidence?: EvidenceRef): TaskBeliefState {
    const evidenceRef: EvidenceRef = evidence ?? {
      id: `evidence:${Date.now()}`,
      summary: observation.observation.summary,
    }
    let next = {
      ...state,
      evidenceRefs: [...state.evidenceRefs, evidenceRef],
      updatedAt: new Date().toISOString(),
    }

    for (const update of observation.beliefUpdates ?? []) {
      next = this.applyBeliefUpdate(next, update, evidenceRef)
    }

    if (observation.newUncertainties) {
      next = {
        ...next,
        uncertainties: [
          ...next.uncertainties,
          ...observation.newUncertainties.map((text, idx) => ({
            id: `uncertainty:${Date.now()}:${idx}`,
            text,
            relatedHypotheses: next.hypotheses.map((h) => h.id),
            recommendedProbeIds: observation.suggestedNextProbes?.map((p) => p.id) ?? [],
            riskLevel: 'medium' as const,
          })),
        ],
      }
    }

    const suggested = observation.suggestedNextProbes?.[0]
    return {
      ...next,
      nextBestProbe: suggested ?? this.recommendProbe(next.taskId, next.hypotheses, next.claims),
    }
  }

  demoteDisprovenHypothesis(state: TaskBeliefState, hypothesisId: string, reason: string, evidenceRef: EvidenceRef): TaskBeliefState {
    return this.applyBeliefUpdate(state, {
      action: 'contradict',
      targetId: hypothesisId,
      reason,
      confidenceDelta: -0.8,
    }, evidenceRef)
  }

  markClaimsStaleForFiles(state: TaskBeliefState, changedFiles: string[], reason = 'Related files changed after verification'): TaskBeliefState {
    if (changedFiles.length === 0) return state
    return {
      ...state,
      claims: state.claims.map((claim) => {
        if (claim.status !== 'verified' && claim.status !== 'partially_verified') return claim
        return { ...claim, status: 'stale', staleReason: reason, confidence: Math.min(claim.confidence, 0.49) }
      }),
      updatedAt: new Date().toISOString(),
    }
  }

  assuranceCase(state: TaskBeliefState): {
    topClaim: string
    verified: Claim[]
    needsHumanReview: Claim[]
    unverified: Claim[]
    contradicted: Claim[]
    failedHypotheses: Hypothesis[]
  } {
    return {
      topClaim: state.goal,
      verified: state.claims.filter((c) => c.status === 'verified'),
      needsHumanReview: state.claims.filter((c) => c.status === 'needs_human_review'),
      unverified: state.claims.filter((c) => c.status === 'unverified' || c.status === 'partially_verified' || c.status === 'stale'),
      contradicted: state.claims.filter((c) => c.status === 'contradicted'),
      failedHypotheses: state.hypotheses.filter((h) => h.status === 'disproven' || h.status === 'contradicted'),
    }
  }

  private applyBeliefUpdate(
    state: TaskBeliefState,
    update: NonNullable<CapabilityObservation['beliefUpdates']>[number],
    evidenceRef: EvidenceRef,
  ): TaskBeliefState {
    const hypotheses = state.hypotheses.map((h) => {
      if (h.id !== update.targetId) return h
      const confidence = clamp(h.confidence + (update.confidenceDelta ?? defaultDelta(update.action)))
      const status = statusForUpdate(h.status, update.action, confidence)
      const supportingEvidence = update.action === 'support' || update.action === 'promote'
        ? [...h.supportingEvidence, evidenceRef]
        : h.supportingEvidence
      const contradictingEvidence = update.action === 'contradict' || update.action === 'demote'
        ? [...h.contradictingEvidence, evidenceRef]
        : h.contradictingEvidence
      return { ...h, confidence, status, supportingEvidence, contradictingEvidence, updatedAt: new Date().toISOString() }
    })

    const contradictions: Contradiction[] = update.action === 'contradict'
      ? [...state.contradictions, {
        id: `contradiction:${Date.now()}:${state.contradictions.length}`,
        targetId: update.targetId,
        evidenceRef,
        reason: update.reason,
        createdAt: new Date().toISOString(),
      }]
      : state.contradictions

    return { ...state, hypotheses, contradictions, updatedAt: new Date().toISOString() }
  }

  private initialHypotheses(goal: string, domains: DomainBelief[], now: string): Hypothesis[] {
    const baseDomains = domains.length > 0 ? domains.map((d) => d.domain) : inferDomains(goal)
    const templates = [
      'The task is localized to the selected domain path and can be solved with a focused patch.',
      'A neighboring domain may own behavior that the initial task text does not mention.',
      'Existing tests or CI output can distinguish the correct implementation path before editing.',
    ]
    return templates.map((claim, idx) => ({
      id: `hypothesis:${idx + 1}`,
      claim,
      status: idx === 0 ? 'plausible' : 'unknown',
      confidence: idx === 0 ? 0.55 : 0.35,
      relevantDomains: baseDomains,
      relevantGraphNodes: [],
      supportingEvidence: [],
      contradictingEvidence: [],
      assumptions: [],
      suggestedProbes: [],
      suggestedPatchStrategies: [],
      createdAt: now,
      updatedAt: now,
    }))
  }

  private initialClaims(taskId: string, criteria: string[], _now: string): Claim[] {
    const source = criteria.length > 0 ? criteria : ['The implementation satisfies the requested behavior']
    return source.map((text, idx) => ({
      id: `claim:${taskId}:${idx + 1}`,
      text,
      status: 'unverified',
      confidence: 0,
      riskLevel: riskFromText(text),
      acceptanceCriterionRefs: [`criterion:${idx + 1}`],
      supportingEvidence: [],
      contradictingEvidence: [],
      missingEvidence: ['No verification evidence recorded yet'],
      verificationChecks: [],
    }))
  }

  private recommendProbe(taskId: string, hypotheses: Hypothesis[], claims: Claim[]): ProbeRecommendation | undefined {
    const top = [...hypotheses].sort((a, b) => b.confidence - a.confidence)[0]
    const weakestClaim = claims.find((c) => c.status === 'unverified' || c.status === 'stale')
    if (!top && !weakestClaim) return undefined
    return {
      id: `probe:${taskId}:${Date.now()}`,
      capability: weakestClaim?.riskLevel === 'critical' ? 'tests.find_related_tests' : 'repo.find_definitions',
      input: {},
      expectedInformationGain: weakestClaim?.riskLevel === 'critical' ? 'high' : 'medium',
      cost: 'low',
      risk: 'low',
      distinguishesHypotheses: top ? [top.id] : [],
      verifiesClaims: weakestClaim ? [weakestClaim.id] : [],
      reason: weakestClaim
        ? `Collect evidence for weakest claim: ${weakestClaim.text}`
        : `Reduce uncertainty around hypothesis: ${top?.claim}`,
      requiredPermissions: ['read_repo_graph'],
    }
  }

  private node(id: string, type: BeliefNodeType, label: string, status?: BeliefStatus, confidence?: number): BeliefNode {
    return { id, type, label, status, confidence }
  }

  private edge(id: string, sourceId: string, targetId: string, type: BeliefEdgeType, confidence?: number): BeliefEdge {
    return { id, sourceId, targetId, type, confidence }
  }
}

function inferDomains(goal: string): string[] {
  const lower = goal.toLowerCase()
  const domains: string[] = []
  if (/auth|permission|role|sso|login|invite/.test(lower)) domains.push('auth', 'permissions')
  if (/api|endpoint|server|backend/.test(lower)) domains.push('backend', 'api')
  if (/db|database|migration|schema/.test(lower)) domains.push('database')
  if (/ui|frontend|component|page/.test(lower)) domains.push('frontend')
  if (/test|ci|failure/.test(lower)) domains.push('tests', 'ci')
  return [...new Set(domains.length > 0 ? domains : ['repo'])]
}

function riskFromText(text: string): 'low' | 'medium' | 'high' | 'critical' {
  if (/auth|permission|security|role|multi-tenant|secret|payment|billing/i.test(text)) return 'critical'
  if (/migration|database|api|privacy|data/i.test(text)) return 'high'
  if (/frontend|ui|test|docs/i.test(text)) return 'medium'
  return 'low'
}

function defaultDelta(action: string): number {
  if (action === 'promote' || action === 'support') return 0.2
  if (action === 'demote') return -0.25
  if (action === 'contradict') return -0.6
  return 0
}

function statusForUpdate(current: BeliefStatus, action: string, confidence: number): BeliefStatus {
  if (action === 'contradict') return confidence <= 0.15 ? 'disproven' : 'contradicted'
  if (action === 'mark_stale') return 'stale'
  if (action === 'promote' || action === 'support') return confidence >= 0.85 ? 'verified' : confidence >= 0.65 ? 'likely' : 'plausible'
  if (action === 'demote') return confidence <= 0.15 ? 'disproven' : 'plausible'
  return current
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))))
}
