export { Dashboard } from './dashboard.js'
export type { DashboardOptions } from './dashboard.js'

export { Repl } from './repl.js'

export { ConfigWizard } from './config-wizard.js'
export type { WizardResult } from './config-wizard.js'

// Belief-mode panel helpers re-exported for testing and for external
// callers that want to embed a single belief panel (e.g. a "next
// best probe" hint in the CLI). The `Dashboard` instance remains
// the canonical orchestrator; these helpers stay pure so unit
// tests can cover them without spinning up blessed.
export {
  bucketHypotheses,
  pickTopHypothesis,
  rowToClaim,
  rowToHypothesis,
} from './dashboard.js'
export type { HypothesisBuckets } from './dashboard.js'
