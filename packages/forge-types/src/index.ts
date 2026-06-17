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
  ForgeConfig,
  ForgeConfigFile,
} from './config.js'
