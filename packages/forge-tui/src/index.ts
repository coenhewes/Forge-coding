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

// ── t51: 6 additional read-only TUI panels ───────────────────────────────
// Type names match the contract t53 left on disk (Probe / Contradiction /
// StaleClaim / Decision / PatchCandidate / PrChecklistItem / PrCheckStatus /
// CostStage) so the dashboard host's import paths stay stable.
export { ProbePanel } from './panels/ProbePanel.js'
export type { ProbePanelFixture, Probe } from './panels/ProbePanel.js'

export { ContradictionPanel } from './panels/ContradictionPanel.js'
export type { ContradictionPanelFixture, Contradiction, StaleClaim } from './panels/ContradictionPanel.js'

export { DecisionPanel } from './panels/DecisionPanel.js'
export type { DecisionPanelFixture, Decision } from './panels/DecisionPanel.js'

export { CheckpointPanel } from './panels/CheckpointPanel.js'
export type { CheckpointPanelFixture, PatchCandidate } from './panels/CheckpointPanel.js'

export { PrReadinessPanel } from './panels/PrReadinessPanel.js'
export type { PrReadinessPanelFixture, PrChecklistItem, PrCheckStatus } from './panels/PrReadinessPanel.js'

export { CostPanel } from './panels/CostPanel.js'
export type { CostPanelFixture, CostStage, CostTotals } from './panels/CostPanel.js'

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
