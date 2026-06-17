export type EvidenceStatus = 'verified' | 'unverified' | 'needs_review'

export type EvidenceKind =
  | 'observed_fact'
  | 'inferred_fact'
  | 'test_result'
  | 'code_change'
  | 'runtime_output'
  | 'screenshot'
  | 'reviewer_feedback'
  | 'human_decision'
  | 'unverified_assumption'

export interface EvidenceLedger {
  entries: EvidenceEntry[]
  taskId: string
}

export interface EvidenceEntry {
  id: string
  claim: string
  evidence: string[]
  unverified: string[]
  status: EvidenceStatus
  kind: EvidenceKind
  source?: string
  timestamp: string
  referencableId: string
}

export interface EvidenceReference {
  entryId: string
  claim: string
  snippet?: string
}
