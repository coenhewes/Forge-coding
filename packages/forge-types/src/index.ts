export type {
  RepoMap,
  PackageInfo,
  AppInfo,
  EntrypointInfo,
  RouteInfo,
  ServiceInfo,
  ComponentInfo,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  MigrationInfo,
  TestSuiteInfo,
  CommandInfo,
  OwnershipBoundary,
  ArchitecturalConvention,
  DomainBoundary,
  RiskArea,
  GitHistory,
  GitCommit,
} from './repo-map.js'

export type {
  RepoGraph,
  GraphNode,
  GraphEdge,
  GraphRegion,
  SymbolDefinition,
  SymbolReference,
  CallSite,
  DomainEdge,
} from './repo-graph.js'

export type {
  DomainManifest,
  DomainAccess,
  DomainSelection,
  DomainExpansionRecord,
} from './domain.js'

export type {
  TaskState,
  TaskStatus,
  Subtask,
  SubtaskStatus,
  OpenQuestion,
} from './task-state.js'

export type {
  AcceptanceContract,
  AcceptanceCriterion,
  CriterionStatus,
  VerificationCheckKind,
} from './acceptance.js'

export type {
  EvidenceLedger,
  EvidenceEntry,
  EvidenceStatus,
  EvidenceKind,
  EvidenceReference,
} from './evidence.js'

export type {
  FailureLedger,
  FailureEntry,
  FailureReflection,
} from './failure.js'

export type {
  DecisionLedger,
  DecisionEntry,
} from './decision.js'

export type {
  VerificationMatrix,
  VerificationEntry,
  VerificationStatus,
  TestSelection,
} from './verification.js'

export type {
  RiskModel,
  RiskArea as RiskAssessmentArea,
  TaskRiskAssessment,
  RiskSeverity,
} from './risk.js'

export type {
  Checkpoint,
  CheckpointStatus,
  PatchCandidate,
  PatchFile,
  PatchTestResult,
} from './checkpoint.js'

export type {
  ProviderName,
  ProviderConfig,
  CompletionRequest,
  Message,
  ToolDefinition,
  ToolCall,
  CompletionChunk,
  CompletionResult,
  ModelProvider,
  SubagentConfig,
} from './provider.js'

export type {
  TraceEvent,
  TraceEventType,
  TraceLog,
} from './trace.js'

export type {
  BeliefStatus,
  BeliefNodeType,
  BeliefEdgeType,
  EvidenceRef,
  AssumptionRef,
  ProbeRecommendation,
  Hypothesis,
  PatchStrategy,
  Claim,
  Assumption,
  Uncertainty,
  Contradiction,
  DomainBelief,
  GraphRegionBelief,
  VerificationObligation,
  HumanReviewRequirement,
  BeliefNode,
  BeliefEdge,
  TaskBeliefState,
  CapabilityObservation,
} from './belief.js'

export type {
  VerificationActionType,
  VerificationActionStatus,
  VerificationAction,
  EvidenceValueScore,
  ClaimVerificationState,
  ActiveVerificationPlan,
} from './active-verification.js'

export type {
  ReviewComment,
  PullRequestState,
  IssueTrackerAdapter,
  PullRequestAdapter,
  ChatAdapter,
  CiAdapter,
} from './integrations.js'

export type {
  StateStoreActor,
  StateStoreConfig,
  StateStoreHealth,
  ArtifactRecord,
  DurableWriteReceipt,
  ContextSlice,
  HumanApproval,
} from './state-store.js'

export type {
  ForgeConfig,
  ForgeConfigFile,
  GitConfig,
} from './config.js'

export type { ArtifactRef } from './artifact.js'
export { isLocalArtifact, isRemoteArtifact } from './artifact.js'

export type {
  LocalTaskKind,
  LocalModelEnablement,
  LocalModelConfig,
  LocalModelUsage,
  LocalModelProvenance,
  LocalModelResultBase,
  SummarizeRequest,
  SummarizeResult,
  ClassifyRequest,
  ClassifyResult,
  ExtractRequest,
  ExtractedField,
  ExtractResult,
  RerankRequest,
  RerankResult,
  EmbedRequest,
  EmbedResult,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingProvider,
  LocalModelRun,
  EmbeddingTargetType,
  EmbeddingRecord,
} from './local-model.js'
