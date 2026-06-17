export { EvidenceValueScorer } from './scorer.js'
export type { ScorerContext } from './scorer.js'

export { ActiveVerificationPlanner, HIGH_RISK_DOMAINS } from './planner.js'
export type { VerificationPlannerInput } from './planner.js'

export {
  applyConfidenceDelta,
  applyResultToBelief,
  applyResultsToClaims,
  recordActionResult,
  updateBeliefGraph,
} from './confidence.js'
export type {
  ActionResult,
  RecordActionResultInput,
  RecordActionResultOutput,
} from './confidence.js'

export {
  findStaleClaimsForFiles,
  markStale,
  markStaleForChangedFiles,
  staleHelpers,
  transitiveFiles,
} from './stale.js'
export type {
  MarkStaleForChangedFilesInput,
  MarkStaleForChangedFilesOutput,
  StaleInvalidationOptions,
} from './stale.js'

export {
  canCompleteAfterHumanReview,
  evaluateCompletion,
  generateReviewId,
  markHumanReview,
} from './gating.js'
export type { CompletionInput, CompletionResult } from './gating.js'
