export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface RiskModel {
  highRiskAreas: RiskArea[]
  taskRisk: TaskRiskAssessment
}

export interface RiskArea {
  area: string
  severity: RiskSeverity
  description: string
  paths: string[]
  indicators: string[]
}

export interface TaskRiskAssessment {
  level: RiskSeverity
  requiresMoreEvidence: boolean
  requiresMoreVerification: boolean
  requiresConservativeEdits: boolean
  requiresMoreCheckpoints: boolean
  requiresExplicitHumanApproval: boolean
  requiresClearerWarnings: boolean
  requiresStrongerReviewGuidance: boolean
  notes: string[]
}
