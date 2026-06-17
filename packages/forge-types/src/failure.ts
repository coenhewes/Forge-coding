export interface FailureLedger {
  entries: FailureEntry[]
  taskId: string
}

export interface FailureEntry {
  id: string
  hypothesis: string
  action: string
  result: string
  lesson: string
  nextHypothesis?: string
  evidenceRefs: string[]
  timestamp: string
  context?: Record<string, unknown>
}

export interface FailureReflection {
  entryId: string
  whatWasTried: string
  whyItFailed: string
  whatDisprovedIt: string
  shouldNotRepeat: string[]
  newlyPlausible: string[]
  nextBestHypothesis: string
}
