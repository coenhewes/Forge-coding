export type CriterionStatus = 'verified' | 'failed' | 'skipped' | 'needs_review' | 'blocked'

export interface AcceptanceContract {
  taskId: string
  description: string
  criteria: AcceptanceCriterion[]
  createdAt: string
  updatedAt: string
}

export interface AcceptanceCriterion {
  id: string
  description: string
  status: CriterionStatus
  evidenceRefs: string[]
  notes?: string
  riskArea?: string
}
