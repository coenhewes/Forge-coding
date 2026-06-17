export { runComparison, formatReport } from './runner.js'
export type { ComparisonOptions, ComparisonReport, ArmResult } from './runner.js'
export { DEMO_TASK } from './demo.js'

export {
  BaselineComparison,
  formatComparisonTable,
  appendBaselineAssurance,
  runRawComparison,
  isWithinTouched,
} from './baseline.js'
export type {
  ComparisonArmMetrics,
  ComparisonReport as BaselineReport,
  ComparisonDeltas,
  BaselineComparisonOptions,
  AcceptanceCheckResult,
} from './baseline.js'

export { EVAL_TASKS, findTask, EVAL_TASK_IDS, DEFAULT_METRIC_WEIGHTS } from './tasks.js'
export type {
  EvalTask,
  EvalTaskClass,
  EvalAcceptanceCheck,
  EvalSeed,
  EvalMetricWeights,
} from './tasks.js'