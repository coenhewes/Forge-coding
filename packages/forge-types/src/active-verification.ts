import type { RiskSeverity } from './risk.js'

export type VerificationActionType =
  | 'unit_test'
  | 'api_test'
  | 'integration_test'
  | 'e2e_test'
  | 'frontend_component_test'
  | 'visual_check'
  | 'screenshot_check'
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'migration_up_check'
  | 'migration_down_check'
  | 'seed_data_check'
  | 'security_check'
  | 'permission_boundary_check'
  | 'performance_check'
  | 'static_analysis_check'
  | 'direct_api_probe'
  | 'runtime_trace'
  | 'manual_human_review'
  | 'reviewer_confirmation'

export type VerificationActionStatus =
  | 'candidate'
  | 'selected'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'stale'
  | 'needs_human_review'

export interface VerificationAction {
  id: string
  taskId: string
  actionType: VerificationActionType
  command?: string
  capability?: string
  targetClaims: string[]
  targetAcceptanceCriteria: string[]
  targetHypotheses: string[]
  targetRisks: string[]
  estimatedRuntimeMs?: number
  estimatedCost?: 'low' | 'medium' | 'high'
  flakinessRisk?: 'low' | 'medium' | 'high'
  setupCost?: 'low' | 'medium' | 'high'
  evidenceQuality?: 'low' | 'medium' | 'high'
  reviewUsefulness?: 'low' | 'medium' | 'high'
  expectedEvidenceValue: number
  selectionReason: string
  status: VerificationActionStatus
  resultEvidenceId?: string
}

export interface EvidenceValueScore {
  actionId: string
  totalScore: number
  components: {
    claimImportance: number
    expectedConfidenceShift: number
    riskWeight: number
    hypothesisDiscrimination: number
    evidenceQuality: number
    reviewUsefulness: number
    runtimePenalty: number
    flakinessPenalty: number
    setupPenalty: number
    contextPenalty: number
  }
  explanation: string
}

export interface ClaimVerificationState {
  claimId: string
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
  supportingEvidence: string[]
  contradictingEvidence: string[]
  missingEvidence: string[]
  requiredActions: string[]
  candidateActions: string[]
  lastVerifiedAt?: string
  staleReason?: string
}

export interface ActiveVerificationPlan {
  taskId: string
  recommendedAction?: VerificationAction
  candidateActions: VerificationAction[]
  scores: EvidenceValueScore[]
  claimGaps: ClaimVerificationState[]
  warnings: string[]
  generatedAt: string
}
