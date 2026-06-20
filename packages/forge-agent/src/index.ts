export { AgentLoop, isReadOnlyShellInspection, isBuildOrTestCommand, isFileMutatingCommand, readTargetKey } from './agent-loop.js'
export { commandCheckKind, commandOutputLooksPassed } from './tools.js'
export type { AgentConfig, AgentResult, AgentEvent } from './agent-loop.js'

export { AgentContextBuilder } from './context-builder.js'
export type { AgentContext, ContextBuilderOptions } from './context-builder.js'

export { ToolExecutor, createToolDefinitions } from './tools.js'
export type { ToolHandler, ToolExecutionContext } from './tools.js'

export { PermissionEngine, matchPattern, isDestructiveCommand } from './permissions.js'
export type { PermissionAction, PermissionRule, PermissionDecision, PermissionContext } from './permissions.js'

export { compactToolResult, DEFAULT_TOOL_RESULT_BUDGET } from './tool-output.js'
export type { CompactedToolResult, CompactOptions, ToolCompressionStrategy, ToolCompressionSavings } from './tool-output.js'

export { nextStage, topHypothesisFor, openClaimsFor, DEFAULT_EDIT_CONFIDENCE, DEFAULT_MAX_PROBES_PER_PASS } from './stages.js'
export type { StageName, StageContext, StageDecision } from './stages.js'

export { detectChecks, runVerification } from './verification-bar.js'
export type { RunnableCheck, CheckResult } from './verification-bar.js'
