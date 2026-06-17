export { ActiveRepoBeliefGraph } from './graph.js'
export type { CreateBeliefStateInput } from './graph.js'

export { ProbePlanner } from './probes.js'
export type {
  ProbeCandidateInput,
  ProbeOutcomeSummary,
  ScoredProbe,
  ScoredProbeBreakdown,
} from './probes.js'

export { DiagnosticEngine } from './diagnostics.js'
export type {
  DiagnosticInput,
  DiagnosticHypothesis,
  GraphRegionResolution,
} from './diagnostics.js'

export {
  BeliefStore,
  InMemoryBeliefStore,
  createBeliefStore,
} from './store.js'
export type {
  BeliefStoreOptions,
  ClaimInput,
  HypothesisInput,
  StateStoreLike,
  TaskBeliefStateBuilder,
  InMemoryBeliefStoreOptions,
} from './store.js'

export {
  runTruthMaintenance,
  recomputeConfidence,
  evidenceRefsFromDescriptors,
} from './truth.js'
export type {
  EvidenceDescriptor,
  TruthMaintenanceOptions,
  TruthMaintenanceReport,
} from './truth.js'

export { generateAssuranceCase } from './assurance.js'
export type {
  AssuranceGeneratorOptions,
  ClaimEntry,
  ClaimEvidenceGraph,
  EvidenceEntry,
  HypothesisEntry,
} from './assurance.js'
