export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not_applicable' | 'blocked' | 'needs_human_review'

export interface VerificationMatrix {
  entries: VerificationEntry[]
  taskId: string
  updatedAt: string
}

export interface VerificationEntry {
  check: string
  status: VerificationStatus
  evidenceRef?: string
  notes?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
}

export interface TestSelection {
  taskId: string
  filesChanged: string[]
  symbolsChanged: string[]
  callersAffected: string[]
  routesAffected: string[]
  tablesAffected: string[]
  migrationsAffected: string[]
  domainsTouched: string[]
  riskProfile: string[]
  historicalFlakyTests: string[]
  acceptanceCriteria: string[]
  crossDomainEdges: string[]
  reviewSensitivity: string[]
  selectedTests: string[]
  rationale: string
}
