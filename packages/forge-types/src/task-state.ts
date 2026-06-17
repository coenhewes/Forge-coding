export type TaskStatus = 'pending' | 'exploring' | 'implementing' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'needs_review'

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked'

export interface TaskState {
  taskId: string
  originalRequest: string
  currentInterpretation: string
  status: TaskStatus
  acceptanceCriteria: string[]
  assumptions: string[]
  openQuestions: OpenQuestion[]
  subtasks: Subtask[]
  dependencies: string[]
  completedWork: string[]
  remainingWork: string[]
  filesTouched: string[]
  commandsRun: string[]
  testsRun: string[]
  failuresEncountered: string[]
  decisionsMade: string[]
  risks: string[]
  verificationStatus: Record<string, string>
  evidenceLinks: string[]
  failedHypotheses: string[]
  patchCandidates: string[]
  reviewBlockers: string[]
  nextAction: string
  updatedAt: string
  createdAt: string
}

export interface Subtask {
  id: string
  label: string
  status: SubtaskStatus
  description: string
  dependsOn: string[]
  result?: string
}

export interface OpenQuestion {
  question: string
  options?: { label: string; description: string }[]
  resolved: boolean
  answer?: string
  timestamp: string
}
