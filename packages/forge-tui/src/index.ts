export { Dashboard } from './dashboard.js'
export type { DashboardOptions } from './dashboard.js'

export { Repl } from './repl.js'

export { ConfigWizard } from './config-wizard.js'
export type { WizardResult } from './config-wizard.js'

// ── t50a: read-only TUI panels + 3x2 dashboard host ─────────────────────
export { TaskPanel } from './panels/TaskPanel.js'
export type { TaskPanelFixture } from './panels/TaskPanel.js'

export { BeliefPanel } from './panels/BeliefPanel.js'
export type { BeliefPanelFixture } from './panels/BeliefPanel.js'

export { VerificationPanel } from './panels/VerificationPanel.js'
export type { VerificationPanelFixture } from './panels/VerificationPanel.js'

export { EvidencePanel } from './panels/EvidencePanel.js'
export type { EvidencePanelFixture } from './panels/EvidencePanel.js'

export { TracePanel } from './panels/TracePanel.js'
export type { TracePanelFixture } from './panels/TracePanel.js'

export { FailurePanel } from './panels/FailurePanel.js'
export type { FailurePanelFixture } from './panels/FailurePanel.js'

export { PanelsDashboard } from './panels-dashboard.js'
export type { PanelsDashboardOptions, PanelsDashboardFixtures } from './panels-dashboard.js'

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
