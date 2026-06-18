export type CriterionStatus = 'verified' | 'failed' | 'skipped' | 'needs_review' | 'blocked'

export interface AcceptanceContract {
  taskId: string
  description: string
  criteria: AcceptanceCriterion[]
  createdAt: string
  updatedAt: string
}

/**
 * The kinds of verification check that can back an acceptance criterion.
 * A criterion may only be marked `verified` once every check it requires has
 * recorded passing evidence (the agent's done-gate) — not on the model's
 * say-so. This is what makes "done" mean "verifiably done".
 */
export type VerificationCheckKind = 'test' | 'typecheck' | 'build' | 'boot' | 'e2e'

export interface AcceptanceCriterion {
  id: string
  description: string
  status: CriterionStatus
  evidenceRefs: string[]
  notes?: string
  riskArea?: string
  /**
   * Checks that must pass before this criterion can be `verified`. When omitted
   * the gate falls back to requiring at least one passing verification.
   */
  requiredChecks?: VerificationCheckKind[]
}
