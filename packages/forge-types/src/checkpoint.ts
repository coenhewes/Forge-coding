export type CheckpointStatus = 'active' | 'promoted' | 'rejected'

export interface Checkpoint {
  id: string
  hypothesis: string
  filesChanged: string[]
  reason: string
  testResult?: string
  verificationStatus: string
  failureReason?: string
  riskAssessment: string
  promotionDecision?: 'promoted' | 'rejected' | 'pending'
  parentCheckpointId?: string
  childCheckpointIds: string[]
  createdAt: string
  promotedAt?: string
}

export interface PatchCandidate {
  id: string
  checkpointId: string
  hypothesis: string
  diff: string
  filesChanged: PatchFile[]
  testResults: PatchTestResult[]
  verificationOutcome: 'passed' | 'failed' | 'partial'
  riskScore: number
  promoted: boolean
  timestamp: string
}

export interface PatchFile {
  path: string
  changeType: 'create' | 'modify' | 'delete'
  hunks: number
}

export interface PatchTestResult {
  suite: string
  passed: number
  failed: number
  skipped: number
  outputRef?: string
}
