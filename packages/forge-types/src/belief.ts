import type { RiskSeverity } from './risk.js'

export type BeliefStatus =
  | 'unknown'
  | 'plausible'
  | 'likely'
  | 'verified'
  | 'contradicted'
  | 'disproven'
  | 'stale'
  | 'superseded'
  | 'needs_human_review'

export type BeliefNodeType =
  | 'Repo'
  | 'Package'
  | 'App'
  | 'File'
  | 'Directory'
  | 'Symbol'
  | 'Function'
  | 'Class'
  | 'Component'
  | 'Route'
  | 'Endpoint'
  | 'Test'
  | 'TestSuite'
  | 'BuildTarget'
  | 'Command'
  | 'DatabaseTable'
  | 'Migration'
  | 'Domain'
  | 'Capability'
  | 'Task'
  | 'AcceptanceCriterion'
  | 'Hypothesis'
  | 'Claim'
  | 'Assumption'
  | 'Evidence'
  | 'Observation'
  | 'Probe'
  | 'PatchCandidate'
  | 'Failure'
  | 'Decision'
  | 'Risk'
  | 'VerificationCheck'
  | 'HumanReviewRequirement'

export type BeliefEdgeType =
  | 'contains'
  | 'defines'
  | 'imports'
  | 'exports'
  | 'references'
  | 'calls'
  | 'depends_on'
  | 'owns'
  | 'belongs_to_domain'
  | 'touches_database_table'
  | 'handled_by'
  | 'guarded_by'
  | 'tested_by'
  | 'built_by'
  | 'supports'
  | 'contradicts'
  | 'assumes'
  | 'invalidates'
  | 'derived_from'
  | 'observed_by'
  | 'inferred_from'
  | 'requires_verification'
  | 'needs_human_review'
  | 'localizes_to'
  | 'suggests_probe'
  | 'suggests_patch'
  | 'verifies_acceptance_criterion'
  | 'blocks_completion'
  | 'expands_domain'
  | 'selected_for_context'
  | 'selected_for_verification'

export interface EvidenceRef {
  id: string
  summary?: string
  artifactRef?: string
}

export interface AssumptionRef {
  id: string
  text: string
}

export interface ProbeRecommendation {
  id: string
  capability: string
  input: Record<string, unknown>
  expectedInformationGain: 'low' | 'medium' | 'high'
  cost: 'low' | 'medium' | 'high'
  risk: 'low' | 'medium' | 'high'
  distinguishesHypotheses: string[]
  verifiesClaims: string[]
  reason: string
  requiredPermissions: string[]
}

export interface Hypothesis {
  id: string
  claim: string
  status: BeliefStatus
  confidence: number
  relevantDomains: string[]
  relevantGraphNodes: string[]
  supportingEvidence: EvidenceRef[]
  contradictingEvidence: EvidenceRef[]
  assumptions: AssumptionRef[]
  suggestedProbes: ProbeRecommendation[]
  suggestedPatchStrategies: PatchStrategy[]
  createdAt: string
  updatedAt: string
}

export interface PatchStrategy {
  id: string
  summary: string
  targetFiles: string[]
  riskLevel: RiskSeverity
  verificationRequired: string[]
}

export interface Claim {
  id: string
  text: string
  status:
    | 'unverified'
    | 'partially_verified'
    | 'verified'
    | 'contradicted'
    | 'conflicted'
    | 'stale'
    | 'needs_human_review'
    | 'not_applicable'
  confidence: number
  riskLevel: RiskSeverity
  acceptanceCriterionRefs: string[]
  supportingEvidence: EvidenceRef[]
  contradictingEvidence: EvidenceRef[]
  missingEvidence: string[]
  verificationChecks: string[]
  reviewerGuidance?: string
  staleReason?: string
}

export interface Assumption {
  id: string
  text: string
  status: 'unverified' | 'verified' | 'contradicted' | 'stale'
  evidenceRefs: EvidenceRef[]
  consequence?: string
}

export interface Uncertainty {
  id: string
  text: string
  relatedHypotheses: string[]
  recommendedProbeIds: string[]
  riskLevel: RiskSeverity
}

export interface Contradiction {
  id: string
  targetId: string
  evidenceRef: EvidenceRef
  reason: string
  createdAt: string
}

export interface DomainBelief {
  domain: string
  confidence: number
  reason: string
}

export interface GraphRegionBelief {
  regionId: string
  confidence: number
  reason: string
}

export interface VerificationObligation {
  id: string
  claimId?: string
  acceptanceCriterionId?: string
  check: string
  riskLevel: RiskSeverity
  required: boolean
}

export interface HumanReviewRequirement {
  id: string
  reason: string
  relatedClaims: string[]
  riskLevel: RiskSeverity
  status: 'open' | 'approved' | 'rejected' | 'resolved'
}

export interface BeliefNode {
  id: string
  type: BeliefNodeType
  label: string
  status?: BeliefStatus
  confidence?: number
  payload?: Record<string, unknown>
}

export interface BeliefEdge {
  id: string
  sourceId: string
  targetId: string
  type: BeliefEdgeType
  confidence?: number
  payload?: Record<string, unknown>
}

export interface TaskBeliefState {
  taskId: string
  repoId: string
  goal: string
  acceptanceCriteria: string[]
  selectedDomains: DomainBelief[]
  selectedGraphRegions: GraphRegionBelief[]
  hypotheses: Hypothesis[]
  claims: Claim[]
  assumptions: Assumption[]
  uncertainties: Uncertainty[]
  evidenceRefs: EvidenceRef[]
  contradictions: Contradiction[]
  nodes: BeliefNode[]
  edges: BeliefEdge[]
  nextBestProbe?: ProbeRecommendation
  verificationObligations: VerificationObligation[]
  humanReviewRequirements: HumanReviewRequirement[]
  updatedAt: string
}

export interface CapabilityObservation {
  observation: {
    type: string
    summary: string
    payload?: Record<string, unknown>
  }
  beliefUpdates?: Array<{
    action: 'promote' | 'demote' | 'contradict' | 'support' | 'mark_stale'
    targetId: string
    reason: string
    confidenceDelta?: number
  }>
  newUncertainties?: string[]
  suggestedNextProbes?: ProbeRecommendation[]
  verificationImplications?: string[]
}
