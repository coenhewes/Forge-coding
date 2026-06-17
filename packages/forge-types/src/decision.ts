export interface DecisionLedger {
  entries: DecisionEntry[]
  taskId: string
}

export interface DecisionEntry {
  id: string
  decision: string
  rationale: string
  alternativesRejected: string[]
  verificationRequired: string[]
  domain?: string
  author: 'agent' | 'human'
  timestamp: string
}
