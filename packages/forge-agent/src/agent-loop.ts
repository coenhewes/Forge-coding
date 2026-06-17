import type {
  ModelProvider,
  Message,
  TaskState,
  DomainSelection,
  AcceptanceContract,
  TaskStatus,
  ToolCall,
  ToolDefinition,
  CompletionChunk,
  CompletionResult,
  DomainManifest,
  TaskBeliefState,
  Claim,
  Hypothesis,
  ProbeRecommendation,
  VerificationAction,
} from '@forge/types'

import { createProvider } from '@forge/provider'
import { scanRepository } from '@forge/harness'
import { buildGraph } from '@forge/harness'
import { getDomainManifests } from '@forge/harness'
import { routeTask } from '@forge/harness'
import { buildCapabilityRegistry, CapabilityExecutor, assessTaskRisk } from '@forge/harness'
import type { TaskRiskAssessment } from '@forge/types'
import type { CapabilityRegistry, CapabilityContext, CapabilityResult } from '@forge/harness'
import { ContextBuilder as HarnessContextBuilder } from '@forge/harness'
import type { BoundedContext } from '@forge/harness'

import { TraceRecorder } from '@forge/trace'
import type { TraceEventType } from '@forge/types'

import { TaskStateEngine, EvidenceMemory, EvidenceLedgerEngine } from '@forge/state'
import { AcceptanceContractEngine } from '@forge/state'
import { FailureLedgerEngine } from '@forge/state'
import { DecisionLedgerEngine } from '@forge/state'

import { VerificationMatrixEngine, AffectedTestSelector, CheckpointManager } from '@forge/verification'

import { ProbePlanner, DiagnosticEngine, InMemoryBeliefStore, BeliefStore } from '@forge/belief'
import { ActiveVerificationPlanner, evaluateCompletion } from '@forge/verification-planner'
import { findStaleClaimsForFiles } from '@forge/verification-planner'

import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import type { TraceEventInput } from '@forge/state-store'

import { PRGenerator, renderPRSummaryMarkdown, GitClient, ghAvailable, createGhPr } from '@forge/pr'
import type { GitConfig, ProviderConfig } from '@forge/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { AgentContextBuilder } from './context-builder.js'
import { ToolExecutor, createToolDefinitions } from './tools.js'
import type { ToolExecutionContext } from './tools.js'
import { PermissionEngine } from './permissions.js'
import type { PermissionDecision, PermissionRule } from './permissions.js'
import { compactToolResult } from './tool-output.js'
import { nextStage, topHypothesisFor, openClaimsFor } from './stages.js'
import type { StageContext, StageName } from './stages.js'

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'file_touched' | 'command_run' | 'status' | 'error' | 'model_response' | 'stage'
  iteration: number
  message: string
  detail?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  filePath?: string
  status?: string
  error?: string
  stage?: StageName
}

export interface AgentConfig {
  provider: ProviderConfig
  workDir: string
  stateDir: string
  mode: 'explore' | 'implement' | 'repair' | 'review' | 'maintain' | 'research'
  maxIterations?: number
  onEvent?: (event: AgentEvent) => void
  features?: {
    repoGraph?: boolean
    domainSystem?: boolean
    evidenceLedger?: boolean
    failureLedger?: boolean
    decisionLedger?: boolean
    checkpointSystem?: boolean
    trace?: boolean
  }
  git?: GitConfig
  /**
   * Optional pre-built ForgeStateStore. If omitted, the loop reads
   * `FORGE_DATABASE_URL` and constructs one in Postgres mode. If
   * `stateStoreMode === 'file'`, the file-based engines are used.
   */
  stateStore?: ForgeStateStore
  stateStoreMode?: 'postgres' | 'file'
  /**
   * Optional permission rules. When omitted, `PermissionEngine.defaultRules`
   * is built from the active domains + mode at runtime.
   */
  permissionRules?: PermissionRule[]
  /**
   * Tool-output character budget. Defaults to 4000. Set to 0 to disable
   * bounding (the full result goes into the model history).
   */
  toolOutputBudget?: number
  /** When true, the agent loop will not actually invoke the LLM. */
  dryRun?: boolean
}

export interface AgentResult {
  taskId: string
  status: string
  summary: string
  iterations: number
  filesTouched: string[]
  commandsRun: string[]
  evidenceCount: number
  failureCount: number
  decisionCount: number
  verificationPassed: boolean
  acceptancePassed: boolean
  promotedCheckpointId?: string
  branch?: string
  commitSha?: string
  prUrl?: string
  prPath?: string
  riskLevel?: string
  /** Stage machine trace: ordered list of stage transitions. */
  stageTrace?: Array<{ stage: StageName; iteration: number; reason: string }>
  /** True if the run was a resume of a previously-crashed session. */
  resumed?: boolean
}

interface InternalState {
  taskId: string
  task: string
  iteration: number
  messages: Message[]
  /** Last stage that ran (for trace). */
  stage: StageName
  /** Probes emitted during the current pass — reset on REPAIR. */
  probesThisPass: number
  /** Pass id — bumped on REPAIR→PROBE transition. */
  passId: number
  /** Set to true if the most recent VERIFY action failed. */
  verifyFailed: boolean
  /** Optional snapshot of top belief claims, used to drive the stage machine. */
  belief: TaskBeliefState | null
  /** Top probe and verify action computed for the current state. */
  topProbe: ProbeRecommendation | null
  topVerifyAction: VerificationAction | null
  canComplete: boolean
  /** Stage trace (one entry per transition). */
  stageTrace: Array<{ stage: StageName; iteration: number; reason: string }>
  /** Consecutive "no tool call" iterations (drives the stop heuristic). */
  consecutiveNoTool: number
}

export class AgentLoop {
  private config: AgentConfig
  private provider: ModelProvider | null

  private taskEngine: TaskStateEngine
  private acceptanceEngine: AcceptanceContractEngine
  private evidenceEngine: EvidenceLedgerEngine
  private failureEngine: FailureLedgerEngine
  private decisionEngine: DecisionLedgerEngine
  private verificationEngine: VerificationMatrixEngine
  private checkpointManager: CheckpointManager
  private toolExecutor: ToolExecutor
  private contextBuilder: AgentContextBuilder
  private traceRecorder: TraceRecorder
  private evidenceMemory: EvidenceMemory
  private testSelector?: AffectedTestSelector

  private repoMap?: import('@forge/types').RepoMap
  private repoGraph?: import('@forge/types').RepoGraph
  private domainManifests: DomainManifest[] = []
  private domainSelection?: DomainSelection

  private git: GitConfig
  private gitClient: GitClient
  private baseBranch?: string
  private workingBranch?: string

  private capabilityRegistry?: CapabilityRegistry
  private capabilityExecutor?: CapabilityExecutor
  private taskRisk?: TaskRiskAssessment
  private activeDomains: string[] = []

  /** Belief graph + planner. Backed by an in-memory store by default
   * so unit tests can run without Postgres. Production callers can
   * wire this up to a real `ForgeStateStore` via the constructor. */
  private beliefStore!: BeliefStore
  private beliefBackend!: InMemoryBeliefStore
  private probePlanner = new ProbePlanner()
  private diagnosticEngine = new DiagnosticEngine()
  private verifyPlanner = new ActiveVerificationPlanner()

  /** Permission engine — built lazily after the active domains load. */
  private permissionEngine!: PermissionEngine

  /** Optional Postgres state store (in 'postgres' mode). */
  private stateStore?: ForgeStateStore

  /** Trace events captured during the current run. */
  private pendingTrace: TraceEventInput[] = []

  constructor(config: AgentConfig) {
    this.config = config
    if (!config.dryRun) {
      this.provider = createProvider(config.provider)
    } else {
      this.provider = null
    }

    const stateDir = config.stateDir

    this.taskEngine = new TaskStateEngine({ stateDir })
    this.acceptanceEngine = new AcceptanceContractEngine({ stateDir })
    this.evidenceEngine = new EvidenceLedgerEngine({ stateDir })
    this.failureEngine = new FailureLedgerEngine({ stateDir })
    this.decisionEngine = new DecisionLedgerEngine({ stateDir })
    this.verificationEngine = new VerificationMatrixEngine({ stateDir })
    this.checkpointManager = new CheckpointManager({ stateDir, workDir: config.workDir })
    this.toolExecutor = new ToolExecutor()
    this.contextBuilder = new AgentContextBuilder()
    this.traceRecorder = new TraceRecorder({ stateDir })
    this.evidenceMemory = new EvidenceMemory({ stateDir })

    this.git = config.git ?? {
      autoBranch: true,
      autoCommit: true,
      pr: 'file',
      branchPrefix: 'forge/',
    }
    this.gitClient = new GitClient(config.workDir)
  }

  async buildRepoIntelligence(): Promise<void> {
    this.repoMap = await scanRepository(this.config.workDir)
    this.repoGraph = this.config.features?.repoGraph !== false && this.repoMap
      ? await buildGraph(this.repoMap, this.config.workDir)
      : undefined
    this.domainManifests = getDomainManifests()
  }

  /**
   * Initialise the belief and permission subsystems. The belief store
   * is wired to an `InMemoryBeliefStore` by default (so tests run
   * without Postgres) and to the supplied `ForgeStateStore` when one
   * is provided in the config. Permission rules default to
   * `PermissionEngine.defaultRules(ctx)` and can be overridden via
   * `config.permissionRules`.
   */
  private async initSubsystems(taskId: string, repoId: string): Promise<void> {
    // Belief store — always backed by InMemoryBeliefStore so unit
    // tests work without Postgres. When a real ForgeStateStore is
    // provided, the InMemoryBeliefStore captures the in-memory view
    // and the real store's repos stay the durable source of truth.
    this.beliefBackend = new InMemoryBeliefStore()
    const stateStoreLike = this.beliefBackend.asStateStoreLike()
    this.beliefStore = new BeliefStore(stateStoreLike)

    // Initial task belief state. We start with a single "initial
    // understanding" hypothesis (the task is the claim) and one
    // claim per acceptance criterion we'll generate below.
    const belief = await this.beliefStore.createTaskBeliefState(taskId, {
      repoId,
      goal: this.config.mode === 'implement' ? 'implement task' : this.config.mode,
      acceptanceCriteria: [],
      hypotheses: [
        {
          claim: 'Initial: investigate the codebase before editing',
          status: 'plausible',
          confidence: 0.5,
          relevantDomains: this.activeDomains,
          relevantGraphNodes: [],
        },
      ],
      claims: [],
    })
    void belief

    // Permission engine. Built from config rules (if any) layered
    // on top of the default rule chain.
    const isReadOnlyMode = this.config.mode === 'explore' || this.config.mode === 'review' || this.config.mode === 'research'
    const rules = PermissionEngine.defaultRules({
      domains: this.domainManifests.filter((d) => this.activeDomains.includes(d.domain)),
      readOnly: isReadOnlyMode,
    })
    this.permissionEngine = new PermissionEngine(rules)
    if (this.config.permissionRules) {
      for (const rule of this.config.permissionRules) this.permissionEngine.addRule(rule)
    }

    // Wire optional Postgres state store.
    if (this.config.stateStore) {
      this.stateStore = this.config.stateStore
    } else if (this.config.stateStoreMode === 'postgres' || process.env.FORGE_DATABASE_URL) {
      this.stateStore = new ForgeStateStore({
        config: defaultStateStoreConfig(this.config.workDir, process.env.FORGE_DATABASE_URL),
      })
    }
  }

  async run(task: string): Promise<AgentResult> {
    const taskId = `task-${Date.now()}`
    return this.runWithId(task, taskId, { resumed: false })
  }

  /**
   * Resume a previously-crashed session. The taskId MUST already
   * exist in the file-state engines (and, when running in Postgres
   * mode, in the `tasks` table). The agent loop re-reads task
   * state, replays the working message log (if persisted), and
   * continues from where it left off.
   */
  async resume(taskId: string): Promise<AgentResult> {
    const state = await this.taskEngine.getTask(taskId)
    if (!state) {
      throw new Error(`Cannot resume: task ${taskId} not found in file state`)
    }
    return this.runWithId(state.originalRequest, taskId, { resumed: true })
  }

  private async runWithId(
    task: string,
    taskId: string,
    options: { resumed: boolean },
  ): Promise<AgentResult> {
    const maxIterations = this.config.maxIterations ?? 50

    // Phase 1: Initialize task state (idempotent for resume).
    const existing = await this.taskEngine.getTask(taskId)
    if (!existing) {
      await this.taskEngine.createTask(taskId, task)
    }
    await this.traceRecorder.initTask(taskId)

    // Phase 2: Build repo intelligence
    if (!this.repoMap) await this.buildRepoIntelligence()

    // Phase 2b: Create a working branch for implementation work.
    this.startGitBranch(taskId)

    // Phase 3: Route task to domains
    this.domainSelection = routeTask(task, this.repoMap, this.repoGraph)
    const selectedDomains = this.domainSelection.selectedDomains

    // Phase 3b: Assess task risk
    this.taskRisk = assessTaskRisk({
      task,
      selectedDomains,
      manifests: this.domainManifests,
      repoMap: this.repoMap,
    })

    // Phase 4: Build the semantic capability fabric
    this.activeDomains = [...selectedDomains]
    let capabilityTools: ToolDefinition[] = this.buildFabric()

    // Phase 5: Create acceptance contract
    const contract = await this.acceptanceEngine.generateContract(taskId, task, selectedDomains)

    // Phase 6: Build bounded context
    const harnessContextBuilder = new HarnessContextBuilder()
    const boundedContext = harnessContextBuilder.build(task, this.domainSelection, {
      repoMap: this.repoMap,
      repoGraph: this.repoGraph,
      taskState: await this.taskEngine.getTask(taskId),
      acceptanceContract: contract,
    })

    // Phase 7: Initialize affected-test selector
    if (this.domainManifests.length > 0 && this.repoMap) {
      this.testSelector = new AffectedTestSelector({
        repoMap: this.repoMap,
        repoGraph: this.repoGraph ?? { nodes: [], edges: [], regions: [], symbolDefinitions: [], symbolReferences: [], callSites: [] },
        domainManifests: this.domainManifests,
      })
      this.testSelector.select(taskId, [])
    }

    // Phase 7b: Initialise belief + permission subsystems
    const repoId = (this.repoMap as { repoId?: string } | undefined)?.repoId ?? '00000000-0000-0000-0000-000000000000'
    await this.initSubsystems(taskId, repoId)

    // Seed claims from the acceptance contract.
    for (const criterion of contract.criteria) {
      await this.beliefStore.addClaim(taskId, {
        text: criterion.description,
        status: 'unverified',
        confidence: 0,
        riskLevel: criterion.riskArea === 'high' || criterion.riskArea === 'critical' || criterion.riskArea === 'medium' || criterion.riskArea === 'low' ? criterion.riskArea : 'low',
        acceptanceCriterionRefs: [criterion.id],
      })
    }

    // Phase 8: Reconcile interrupted commands (crash recovery).
    await this.reconcileInterruptedCommands(taskId)

    // Phase 9: Enter stage machine.
    await this.taskEngine.updateStatus(taskId, 'exploring')

    const tools = [...capabilityTools, ...createToolDefinitions()]
    const internal: InternalState = {
      taskId,
      task,
      iteration: 0,
      messages: options.resumed ? this.resumeMessages(task, taskId) : [],
      stage: 'LOCALIZE',
      probesThisPass: 0,
      passId: 0,
      verifyFailed: false,
      belief: await this.beliefStore.loadTaskBeliefState(taskId),
      topProbe: null,
      topVerifyAction: null,
      canComplete: false,
      stageTrace: [],
      consecutiveNoTool: 0,
    }

    const fire = (event: Omit<AgentEvent, 'iteration'>) => {
      this.config.onEvent?.({ ...event, iteration: internal.iteration } as AgentEvent)
    }

    let finalStatus: TaskStatus | 'completed' = 'exploring'
    let finalSummary = ''
    let lastDecisionReason = 'initial'

    while (internal.iteration < maxIterations) {
      internal.iteration++

      // Compact when the working log grows large; reference belief-store
      // ids of dropped facts so retrieval is exact.
      if (internal.iteration > 10 && internal.messages.length > 30) {
        internal.messages = await this.compactMessages(internal.messages, taskId)
      }

      // Refresh the belief snapshot and recompute the verification plan.
      await this.refreshBeliefSnapshot(internal)

      // Run the stage machine. The first iteration always LOCALIZEs.
      if (internal.iteration === 1) {
        this.recordStage(internal, 'LOCALIZE', 'initial entry', fire)
      } else {
        const stageCtx: StageContext = {
          belief: internal.belief,
          topHypothesis: topHypothesisFor(internal.belief),
          openClaims: openClaimsFor(internal.belief),
          topProbe: internal.topProbe,
          topVerifyAction: internal.topVerifyAction,
          canComplete: internal.canComplete,
          verifyFailed: internal.verifyFailed,
          probesThisPass: internal.probesThisPass,
          passId: internal.passId,
          notes: {},
        }
        const decision = nextStage(stageCtx)
        lastDecisionReason = decision.reason
        this.recordStage(internal, decision.next, decision.reason, fire)
      }

      // Run the stage.
      const stageResult = await this.runStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      if (stageResult.terminal) {
        finalStatus = stageResult.terminalStatus ?? 'completed'
        finalSummary = stageResult.summary ?? ''
        break
      }
      if (stageResult.repairNeeded) {
        // Continue from PROBE with a fresh pass.
        internal.verifyFailed = false
        internal.probesThisPass = 0
        internal.passId += 1
        continue
      }
    }

    await this.traceRecorder.completeTask(taskId)
    await this.flushTrace(taskId)

    const state = await this.taskEngine.getTask(taskId)
    const evidenceSummary = await this.evidenceEngine.getSummary(taskId)
    const failures = await this.failureEngine.getEntries(taskId)
    const decisions = await this.decisionEngine.getEntries(taskId)
    const verification = await this.verificationEngine.getSummary(taskId)
    const acceptanceStatus = await this.acceptanceEngine.getCompletionStatus(taskId)
    const promotedCheckpoints = await this.checkpointManager.getPromotedCheckpoints(taskId)

    const pr = await this.finalizeGit(taskId, finalStatus, fire)

    return {
      taskId,
      status: finalStatus,
      summary:
        finalSummary ||
        state?.nextAction ||
        (finalStatus === 'exploring'
          ? `Reached iteration limit (${maxIterations}) before finishing. Last stage: ${internal.stage}.`
          : `Task ${finalStatus}.`),
      iterations: internal.iteration,
      filesTouched: state?.filesTouched ?? [],
      commandsRun: state?.commandsRun ?? [],
      evidenceCount: (evidenceSummary as { total?: number }).total ?? 0,
      failureCount: failures.length,
      decisionCount: decisions.length,
      verificationPassed: (verification as { passed?: number; failed?: number }).passed != null
        && (verification as { passed: number; failed: number }).passed > 0
        && (verification as { passed: number; failed: number }).failed === 0,
      acceptancePassed: acceptanceStatus.allVerified,
      promotedCheckpointId: promotedCheckpoints[0]?.id,
      branch: this.workingBranch,
      commitSha: pr.commitSha,
      prUrl: pr.prUrl,
      prPath: pr.prPath,
      riskLevel: this.taskRisk?.level,
      stageTrace: internal.stageTrace,
      resumed: options.resumed,
    }
    void lastDecisionReason
  }

  /**
   * Refresh the belief snapshot, top probe, top verify action, and
   * completion-gate result. Mutates the InternalState in place.
   */
  private async refreshBeliefSnapshot(internal: InternalState): Promise<void> {
    internal.belief = await this.beliefStore.loadTaskBeliefState(internal.taskId)
    const openClaims = openClaimsFor(internal.belief)
    const probe = this.probePlanner.next({
      taskId: internal.taskId,
      claims: internal.belief?.claims ?? [],
      hypotheses: internal.belief?.hypotheses ?? [],
      capabilities: Array.from(this.capabilityRegistry?.getAll().keys() ?? []),
    })
    internal.topProbe = probe?.probe ?? null

    const verifyPlan = this.verifyPlanner.plan({
      taskId: internal.taskId,
      claims: internal.belief?.claims ?? [],
      hypotheses: internal.belief?.hypotheses ?? [],
      uncertainties: internal.belief?.uncertainties ?? [],
      filesChanged: [],
    })
    internal.topVerifyAction = verifyPlan.recommendedAction ?? null

    const completion = evaluateCompletion({
      claims: (internal.belief?.claims ?? []) as Claim[],
      actions: verifyPlan.candidateActions,
    })
    internal.canComplete = completion.ready
  }

  /**
   * Run one stage. The stage machine chooses; this method does.
   * Returns `{ terminal?: true; repairNeeded?: true }` to drive
   * the outer loop.
   */
  private async runStage(
    internal: InternalState,
    tools: ToolDefinition[],
    contract: AcceptanceContract,
    boundedContext: BoundedContext,
    capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string; repairNeeded?: boolean }> {
    switch (internal.stage) {
      case 'LOCALIZE':
        return this.runLocalizeStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      case 'PROBE':
        return this.runProbeStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      case 'EDIT':
        return this.runEditStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      case 'VERIFY':
        return this.runVerifyStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      case 'REPAIR':
        return this.runRepairStage(internal, tools, contract, boundedContext, capabilityTools, fire)
      case 'FINALIZE':
        return this.runFinalizeStage(internal, tools, contract, boundedContext, capabilityTools, fire)
    }
  }

  /**
   * LOCALIZE — read task state, run a single model completion to
   * produce an interpretation, then advance to the next stage.
   * No tool calls in this stage by default; the model just frames
   * the task.
   */
  private async runLocalizeStage(
    internal: InternalState,
    tools: ToolDefinition[],
    contract: AcceptanceContract,
    boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string }> {
    fire({ type: 'status', message: 'LOCALIZE: framing the task', status: 'localize' })
    const agentContext = this.contextBuilder.build({
      taskId: internal.taskId,
      task: internal.task,
      taskState: await this.taskEngine.getTask(internal.taskId),
      domainSelection: this.domainSelection,
      boundedContext,
      acceptanceContract: contract,
      tools,
      mode: this.config.mode,
      warnings: await this.failureEngine.getWarnings(internal.taskId),
      capabilityNames: _capabilityTools.map((t) => t.name),
      riskAssessment: this.taskRisk,
    })
    const completion = await this.runCompletion(agentContext.systemPrompt, agentContext.messages, internal.messages, tools)
    if (completion.content) fire({ type: 'thinking', message: completion.content.slice(0, 500) })
    // If the model chose to call a tool (e.g. read_file) we still respect
    // that and let the result flow into the working log.
    return this.handleCompletion(internal, tools, contract, boundedContext, _capabilityTools, fire, completion)
  }

  private async runProbeStage(
    internal: InternalState,
    tools: ToolDefinition[],
    contract: AcceptanceContract,
    boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string }> {
    if (!internal.topProbe) {
      // Nothing to probe — fall through to next stage by returning a
      // no-op completion.
      return {}
    }
    fire({ type: 'status', message: `PROBE: ${internal.topProbe.capability}`, status: 'probe' })
    // Emit the probe as an in-band tool call. We model it as a read
    // through the capability registry when available; otherwise it
    // goes through the primitive executor.
    const probeToolCall: ToolCall = {
      id: `probe-${Date.now()}`,
      name: internal.topProbe.capability,
      input: internal.topProbe.input ?? {},
    }
    internal.probesThisPass += 1

    const result = await this.executeToolCall(internal, probeToolCall, tools, contract, fire, { isProbe: true })
    internal.messages.push({
      role: 'assistant',
      content: `Probe: ${internal.topProbe.capability} (${internal.topProbe.reason})`,
      toolCalls: [probeToolCall],
    })
    const compacted = await this.compactSingleResult(result, internal.taskId, probeToolCall.name)
    internal.messages.push({
      role: 'tool',
      content: compacted.content,
      toolCallId: probeToolCall.id,
    })

    // Persist probe outcome to belief store.
    await this.beliefStore.addProbe(internal.taskId, internal.topProbe)
    await this.beliefStore.recordProbeResult(
      internal.taskId,
      internal.topProbe.id,
      'inconclusive',
      `Probe result (${compacted.totalBytes} bytes) captured.`,
    )

    return {}
  }

  private async runEditStage(
    internal: InternalState,
    tools: ToolDefinition[],
    contract: AcceptanceContract,
    boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string }> {
    fire({ type: 'status', message: 'EDIT: invoking model to propose changes', status: 'edit' })
    const agentContext = this.contextBuilder.build({
      taskId: internal.taskId,
      task: internal.task,
      taskState: await this.taskEngine.getTask(internal.taskId),
      domainSelection: this.domainSelection,
      boundedContext,
      acceptanceContract: contract,
      tools,
      mode: this.config.mode,
      warnings: await this.failureEngine.getWarnings(internal.taskId),
      capabilityNames: _capabilityTools.map((t) => t.name),
      riskAssessment: this.taskRisk,
    })
    const completion = await this.runCompletion(agentContext.systemPrompt, agentContext.messages, internal.messages, tools)
    return this.handleCompletion(internal, tools, contract, boundedContext, _capabilityTools, fire, completion)
  }

  private async runVerifyStage(
    internal: InternalState,
    _tools: ToolDefinition[],
    contract: AcceptanceContract,
    _boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string; repairNeeded?: boolean }> {
    if (!internal.topVerifyAction) {
      // No action — fall through.
      return {}
    }
    const action = internal.topVerifyAction
    fire({ type: 'status', message: `VERIFY: ${action.actionType} (${action.command ?? action.capability ?? 'inline'})`, status: 'verify' })

    // Mark stale claims based on any files changed in this loop pass.
    // The belief is updated so the next stage transition sees fresh state.
    if (internal.belief) {
      const filesChanged = (await this.taskEngine.getTask(internal.taskId))?.filesTouched ?? []
      if (filesChanged.length > 0) {
        const markedClaims = findStaleClaimsForFiles(
          internal.belief.claims as Claim[],
          filesChanged,
          { reason: 'Source changed after verification' },
        )
        for (const after of markedClaims) {
          const before = (internal.belief.claims as Claim[]).find((c) => c.id === after.id)
          if (!before) continue
          if (after.status === 'stale' && before.status !== 'stale') {
            await this.beliefStore.updateClaimConfidence(internal.taskId, before.id, after.confidence, 'stale')
          }
        }
      }
    }

    // The verify action runs as a tool call (e.g. run_command) when
    // there's a command, or a capability call when there's a capability.
    let passed = false
    if (action.command) {
      const runTool: ToolCall = {
        id: `verify-${Date.now()}`,
        name: 'run_command',
        input: { command: action.command, description: action.actionType },
      }
      const result = await this.executeToolCall(internal, runTool, _tools, contract, fire, { isVerify: true })
      passed = !/^Error:|\bfail|FAILED|exit code [1-9]/.test(result.content)
      await this.verificationEngine.addEntry(internal.taskId, action.id, {
        status: passed ? 'passed' : 'failed',
        notes: result.content.slice(0, 500),
      })
    } else {
      // No command — treat as a no-op (e.g. a human-review action).
      passed = true
      await this.verificationEngine.addEntry(internal.taskId, action.id, {
        status: 'needs_human_review',
        notes: action.selectionReason ?? 'No automated check available',
      })
    }

    internal.verifyFailed = !passed
    if (passed) {
      // Confidence boost for the top claim(s).
      const topClaim = (internal.belief?.claims as Claim[] | undefined)?.[0]
      if (topClaim) {
        await this.beliefStore.updateClaimConfidence(internal.taskId, topClaim.id, 0.85, 'verified')
      }
    } else {
      // Record a failure in the failure engine so the next stage can reflect.
      await this.failureEngine.addEntry(
        internal.taskId,
        `Verify action ${action.id} failed`,
        action.command ?? action.capability ?? action.actionType,
        'verify failed',
        'Mark the related claim contradicted and try a different verification approach.',
        { nextHypothesis: 'Re-derive hypothesis from failed-check output via diagnostic engine.' },
      )
      return { repairNeeded: true }
    }
    return {}
  }

  private async runRepairStage(
    internal: InternalState,
    _tools: ToolDefinition[],
    _contract: AcceptanceContract,
    _boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string; repairNeeded?: boolean }> {
    fire({ type: 'status', message: 'REPAIR: running diagnostic engine', status: 'repair' })

    // Pull the most recent failure from the failure engine, or fall
    // back to "no output" so the engine still returns a generic
    // hypothesis.
    const failures = await this.failureEngine.getEntries(internal.taskId)
    const last = failures[failures.length - 1]
    const output = last?.lesson ?? 'no failure output'

    const diagnostics = this.diagnosticEngine.proposeRootCauseHypotheses({
      taskId: internal.taskId,
      output,
      source: 'test',
      taskBelief: internal.belief
        ? { claims: internal.belief.claims as Claim[], hypotheses: internal.belief.hypotheses as Hypothesis[] }
        : undefined,
    })

    // Invalidate the top hypothesis (it failed) and add the new ones.
    const top = topHypothesisFor(internal.belief)
    if (top) {
      await this.beliefStore.invalidateHypothesis(internal.taskId, top.id, 'Failed verify', [])
    }
    for (const d of diagnostics) {
      await this.beliefStore.addHypothesis(internal.taskId, d.hypothesis)
    }
    return { repairNeeded: true }
  }

  private async runFinalizeStage(
    internal: InternalState,
    _tools: ToolDefinition[],
    _contract: AcceptanceContract,
    _boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ terminal: boolean; terminalStatus: TaskStatus | 'completed'; summary: string }> {
    fire({ type: 'status', message: 'FINALIZE: task can complete', status: 'finalize' })
    await this.taskEngine.updateStatus(internal.taskId, 'completed')
    return {
      terminal: true,
      terminalStatus: 'completed',
      summary: internal.task,
    }
  }

  /**
   * Run a single model completion and dispatch tool calls (or lack
   * thereof). Mirrors the original loop's tool-call handling, but
   * every tool result is permission-checked, persisted via
   * compactToolResult, and recorded in the belief/evidence stores.
   */
  private async handleCompletion(
    internal: InternalState,
    tools: ToolDefinition[],
    _contract: AcceptanceContract,
    _boundedContext: BoundedContext,
    _capabilityTools: ToolDefinition[],
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
    completion: CompletionResult,
  ): Promise<{ terminal?: boolean; terminalStatus?: TaskStatus | 'completed'; summary?: string }> {
    if (completion.content) {
      fire({ type: 'thinking', message: completion.content.slice(0, 2000) })
    }

    if (!completion.toolCalls || completion.toolCalls.length === 0) {
      internal.messages.push({ role: 'assistant', content: completion.content || '' })
      internal.consecutiveNoTool += 1
      if (internal.consecutiveNoTool >= 2) {
        return { terminal: true, terminalStatus: 'completed', summary: completion.content || 'Task completed.' }
      }
      internal.messages.push({
        role: 'user',
        content:
          'You did not call any tool. If the task is complete and verified, call finish_task. ' +
          'Otherwise continue working: use the available tools to explore, edit, and verify.',
      })
      return {}
    }

    internal.consecutiveNoTool = 0
    const toolMessages: Message[] = [
      { role: 'assistant', content: completion.content || '', toolCalls: completion.toolCalls },
    ]

    const changedFiles: string[] = []
    let terminalSignal: { status: TaskStatus; summary: string } | undefined
    let expandedThisTurn: string[] | undefined

    for (const toolCall of completion.toolCalls) {
      // Permission check before execution.
      const decision = this.permissionEngine.evaluate(toolCall.name, toolCall.input)
      if (decision.action === 'deny') {
        fire({
          type: 'error',
          message: `Permission denied for ${toolCall.name}: ${decision.reason}`,
          error: decision.reason,
          toolName: toolCall.name,
        })
        const deniedContent = `Permission denied: ${decision.reason}`
        const compacted = await this.compactSingleResult({ content: deniedContent }, internal.taskId, toolCall.name)
        toolMessages.push({ role: 'tool', content: compacted.content, toolCallId: toolCall.id })
        continue
      }
      if (decision.action === 'ask') {
        // Emit a "needs human approval" terminal signal so the loop
        // pauses cleanly. The TUI shows the question.
        fire({
          type: 'status',
          message: `Permission ask for ${toolCall.name}: ${decision.reason}`,
          status: 'permission-ask',
          toolName: toolCall.name,
        })
        await this.taskEngine.addQuestion(internal.taskId, {
          question: `Approve ${toolCall.name}? ${decision.reason}`,
          options: [
            { label: 'Approve once', description: 'Allow this single call' },
            { label: 'Deny', description: 'Block this call' },
          ],
          resolved: false,
          timestamp: new Date().toISOString(),
        })
        await this.taskEngine.setNextAction(internal.taskId, `Waiting for human approval: ${toolCall.name}`)
        terminalSignal = { status: 'blocked', summary: `Needs human approval: ${decision.reason}` }
        break
      }

      // Permission granted. Execute.
      fire({
        type: 'tool_call',
        message: `Tool: ${toolCall.name}`,
        toolName: toolCall.name,
        toolInput: toolCall.input as Record<string, unknown> | undefined,
        detail: JSON.stringify(toolCall.input).slice(0, 500),
      })
      await this.traceRecorder.record(internal.taskId, 'tool_called' as TraceEventType, toolCall.name, {
        payload: { input: toolCall.input },
      })

      const result = await this.executeToolCall(internal, toolCall, tools, _contract, fire)

      // Track changed files
      const toolInput = toolCall.input as Record<string, unknown> | undefined
      if ((toolCall.name === 'write_file' || toolCall.name === 'edit_file') && toolInput?.path) {
        changedFiles.push(toolInput.path as string)
      }
      if (expandedThisTurn && toolResultMetadata(result)?.type === 'expansion') {
        expandedThisTurn = [
          ...(expandedThisTurn ?? []),
          ...(((toolResultMetadata(result)?.domains as string[] | undefined) ?? [])),
        ]
      }

      // Compact and persist the tool result.
      const compacted = await this.compactSingleResult(result, internal.taskId, toolCall.name)
      fire({
        type: 'tool_result',
        message: `Result (${compacted.totalBytes} bytes${compacted.truncated ? ' truncated' : ''})`,
        detail: compacted.content.slice(0, 200),
      })

      // Persist as evidence.
      if (this.config.features?.evidenceLedger !== false) {
        await this.evidenceMemory.storeCommandOutput(
          internal.taskId,
          toolCall.name,
          compacted.content.slice(0, 5000),
          !compacted.content.startsWith('Error:'),
        )
      }

      toolMessages.push({ role: 'tool', content: compacted.content, toolCallId: toolCall.id })

      if (result.metadata?.type === 'finish') {
        terminalSignal = {
          status: (result.metadata.status as TaskStatus) || 'completed',
          summary: (result.metadata.summary as string) || result.content,
        }
        break
      }
      if (result.metadata?.type === 'question') {
        const question = String(result.metadata?.question ?? 'Needs human input')
        await this.taskEngine.addQuestion(internal.taskId, {
          question,
          options: result.metadata?.options as { label: string; description: string }[] | undefined,
          resolved: false,
          timestamp: new Date().toISOString(),
        })
        await this.taskEngine.setNextAction(internal.taskId, `Waiting for human input: ${question}`)
        terminalSignal = { status: 'blocked', summary: result.content }
        break
      }
    }

    internal.messages.push(...toolMessages)

    if (expandedThisTurn && expandedThisTurn.length > 0) {
      this.activeDomains = [...new Set([...this.activeDomains, ...expandedThisTurn])]
      const capTools = this.buildFabric()
      fire({
        type: 'status',
        message: `Expanded scope to: ${this.activeDomains.join(', ')}`,
        status: 'expansion',
      })
      void capTools
    }

    if (changedFiles.length > 0 && this.testSelector) {
      const selection = this.testSelector.select(internal.taskId, changedFiles)
      await this.traceRecorder.record(internal.taskId, 'decision' as TraceEventType, `Selected ${selection.selectedTests.length} affected tests`, {
        payload: { filesChanged: changedFiles, testCount: selection.selectedTests.length },
      })
    }

    if (terminalSignal) {
      await this.taskEngine.updateStatus(internal.taskId, terminalSignal.status)
      return { terminal: true, terminalStatus: terminalSignal.status, summary: terminalSignal.summary }
    }
    return {}
  }

  /**
   * Execute a single tool call through the capability fabric or
   * primitive tool executor. Persists the `commands` row for crash
   * recovery (started/running → completed) and writes stdout/stderr
   * to the artifact store.
   */
  private async executeToolCall(
    internal: InternalState,
    toolCall: ToolCall,
    _tools: ToolDefinition[],
    _contract: AcceptanceContract,
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
    flags: { isProbe?: boolean; isVerify?: boolean } = {},
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const toolContext: ToolExecutionContext = {
      workDir: this.config.workDir,
      repoMap: this.repoMap,
      repoGraph: this.repoGraph,
      domainManifests: this.domainManifests,
      taskId: internal.taskId,
      taskEngine: this.taskEngine,
      acceptanceEngine: this.acceptanceEngine,
      evidenceEngine: this.evidenceEngine,
      failureEngine: this.failureEngine,
      decisionEngine: this.decisionEngine,
      verificationEngine: this.verificationEngine,
      checkpointManager: this.checkpointManager,
    }

    // Persist a `commands` row before invoking the tool when one is
    // configured. Crash recovery uses this row to detect interrupted
    // invocations on next start.
    let commandRowId: string | undefined
    if (this.stateStore && toolCall.name === 'run_command' && typeof toolCall.input.command === 'string') {
      try {
        const row = await this.stateStore.repos.commands.insert({
          id: `cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          taskId: internal.taskId,
          command: toolCall.input.command as string,
          cwd: this.config.workDir,
          status: 'running',
          exitCode: null,
          startedAt: new Date().toISOString(),
          stdoutArtifactId: null,
          stderrArtifactId: null,
          summary: flags.isVerify ? 'verify' : flags.isProbe ? 'probe' : 'agent',
          payload: { toolCallId: toolCall.id, stage: internal.stage },
        })
        commandRowId = row.id
      } catch (err) {
        // Don't fail the agent loop on persistence hiccups.
        void err
      }
    }

    let result: { content: string; metadata?: Record<string, unknown> }
    try {
      if (this.capabilityExecutor && this.capabilityRegistry?.get(toolCall.name)) {
        const capResult = await this.capabilityExecutor.execute(
          toolCall.name,
          toolCall.input,
          { bypassPermissions: true },
        )
        result = { content: this.formatCapabilityResult(toolCall.name, capResult) }
      } else {
        result = await this.toolExecutor.execute(toolCall, toolContext)
      }
    } finally {
      if (commandRowId && this.stateStore) {
        try {
          await this.stateStore.repos.commands.update(commandRowId, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          })
        } catch {
          // Persistence is best-effort; the agent loop continues.
        }
      }
    }

    return result
    void fire
  }

  private async runCompletion(
    system: string,
    baseMessages: Message[],
    history: Message[],
    tools: ToolDefinition[],
  ): Promise<CompletionResult> {
    if (!this.provider) {
      // dryRun — synthesize a no-tool completion so the loop can advance.
      return { content: 'dry-run: no provider configured', finishReason: 'stop' }
    }
    const streamChunks: CompletionChunk[] = []
    for await (const chunk of this.provider.complete({
      model: this.config.provider.model,
      system,
      messages: [...baseMessages, ...history],
      tools,
      toolChoice: 'auto',
      maxTokens: this.config.provider.maxTokens ?? 4096,
      temperature: this.config.provider.temperature ?? 0.2,
    })) {
      streamChunks.push(chunk)
    }
    return this.mergeStreamResult(streamChunks)
  }

  /**
   * Start a `commands` row and immediately mark it 'interrupted' if
   * it was already 'running' on a previous start. The crash-recovery
   * path: on every loop start we look for stale `running` rows and
   * annotate them so the verifier can show partial output.
   */
  private async reconcileInterruptedCommands(taskId: string): Promise<void> {
    if (!this.stateStore) return
    const staleThresholdMs = 5 * 60 * 1000
    const cutoff = new Date(Date.now() - staleThresholdMs).toISOString()
    try {
      const running = await this.stateStore.repos.commands.listByStatus(taskId, 'running')
      for (const row of running) {
        if (row.startedAt < cutoff) {
          await this.stateStore.repos.commands.update(row.id, {
            status: 'interrupted',
            completedAt: new Date().toISOString(),
            summary: `${row.summary ?? 'agent'} (interrupted; partial output may be lost)`,
          })
        }
      }
    } catch (err) {
      void err
    }
  }

  /** Compact a single tool result. Persists full bytes to .forge/artifacts. */
  private async compactSingleResult(
    result: { content: string; metadata?: Record<string, unknown> },
    taskId: string,
    toolName: string,
  ): Promise<{ content: string; totalBytes: number; truncated: boolean; artifactRef?: string }> {
    const budget = this.config.toolOutputBudget ?? 0
    if (budget <= 0) {
      return { content: result.content, totalBytes: Buffer.byteLength(result.content, 'utf-8'), truncated: false }
    }
    const artifactsDir = join(this.config.stateDir, '.forge', 'artifacts')
    const compacted = await compactToolResult(result.content, {
      budget,
      taskId,
      artifactsDir,
      toolName,
    })
    return compacted
  }

  /**
   * Append a stage transition to the trace. The trace is the durable
   * record of what the agent did (in addition to the underlying
   * `traceRecorder` file-based log).
   */
  private recordStage(
    internal: InternalState,
    stage: StageName,
    reason: string,
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): void {
    internal.stage = stage
    internal.stageTrace.push({ stage, iteration: internal.iteration, reason })
    fire({ type: 'stage', message: `Stage: ${stage} — ${reason}`, stage, status: stage.toLowerCase() })
    this.pendingTrace.push({
      type: 'state_transition',
      taskId: internal.taskId,
      actor: 'agent',
      summary: `Stage → ${stage}: ${reason}`,
      payload: { stage, reason, iteration: internal.iteration },
    })
  }

  /** Flush the in-memory trace events to the state store. */
  private async flushTrace(taskId: string): Promise<void> {
    if (!this.stateStore || this.pendingTrace.length === 0) return
    const events = this.pendingTrace.splice(0)
    try {
      await this.stateStore.tx(async (ctx) => {
        for (const ev of events) {
          await ctx.trace(ev)
        }
      })
    } catch {
      // Persistence is best-effort; the local TraceRecorder file log
      // is the primary record.
    }
    void taskId
  }

  /** Resumption: re-admit the prior prompt with a 'resumed' marker. */
  private resumeMessages(task: string, taskId: string): Message[] {
    return [
      {
        role: 'user',
        content: `[Resumed session ${taskId}]\n\nThe previous run was interrupted. Continuing task: ${task}`,
      },
    ]
  }

  private async compactMessages(messages: Message[], taskId: string): Promise<Message[]> {
    if (messages.length <= 30) return messages
    const keepStart = 2
    const keepEnd = 10
    const start = messages.slice(0, keepStart)
    const end = messages.slice(-keepEnd)
    const middle = messages.slice(keepStart, -keepEnd)

    // Collect belief-store ids referenced by tool messages in the
    // dropped section. The summary references these ids so the agent
    // can re-query the belief store for exact facts.
    const referenced = new Set<string>()
    for (const m of middle) {
      if (m.role === 'tool' && typeof m.content === 'string') {
        const matches = m.content.match(/(?:artifact|claim|hypothesis|probe):[a-z0-9-]+/g)
        if (matches) for (const ref of matches) referenced.add(ref)
      }
    }

    const summaryLines: string[] = [
      `[Compacted ${middle.length} messages from previous iterations]`,
      `Belief-store references preserved (exact retrieval available): ${[...referenced].slice(0, 20).join(', ') || 'none'}`,
    ]
    void taskId
    return [
      ...start,
      { role: 'system', content: summaryLines.join('\n') },
      ...end,
    ]
  }

  /**
   * Create an isolated working branch at task start.
   */
  private startGitBranch(taskId: string): void {
    if (!this.git.autoBranch) return
    if (this.config.mode !== 'implement' && this.config.mode !== 'repair') return
    if (!this.gitClient.isRepo()) return

    this.baseBranch = this.git.base ?? this.gitClient.currentBranch()
    const name = `${this.git.branchPrefix}${taskId}`
    if (this.gitClient.createBranch(name)) {
      this.workingBranch = name
    }
  }

  /**
   * On success, commit the agent's changes and render a PR.
   */
  private async finalizeGit(
    taskId: string,
    finalStatus: string,
    fire: (event: Omit<AgentEvent, 'iteration'>) => void,
  ): Promise<{ commitSha?: string; prUrl?: string; prPath?: string }> {
    if (finalStatus !== 'completed') return {}
    if (!this.gitClient.isRepo()) return {}

    const state = await this.taskEngine.getTask(taskId)
    if (!state) return {}

    let commitSha: string | undefined
    if (this.git.autoCommit && this.gitClient.hasChanges()) {
      this.gitClient.stage(state.filesTouched.length > 0 ? state.filesTouched : undefined)
      const subject =
        state.currentInterpretation.slice(0, 72).replace(/\s+\S*$/, '') || `Forge task ${taskId}`
      commitSha =
        this.gitClient.commit(`${subject}\n\nForge task ${taskId}`) ?? undefined
      if (commitSha) fire({ type: 'status', message: `Committed ${commitSha}`, status: 'committed' })
    }

    if (this.git.pr === 'off') return { commitSha }

    const contract = await this.acceptanceEngine.getContract(taskId)
    const verification = await this.verificationEngine.getEntries(taskId)
    const ledger = await this.evidenceEngine.getLedger(taskId)
    const evidence = ledger?.entries ?? []
    const failures = await this.failureEngine.getEntries(taskId)
    const decisions = await this.decisionEngine.getEntries(taskId)
    const checkpoints = await this.checkpointManager.getCheckpoints(taskId)
    const patches = await this.checkpointManager.getPatches(taskId)

    const generator = new PRGenerator({ repoMap: this.repoMap, domainManifests: this.domainManifests })
    const summary = await generator.generate(
      state,
      contract,
      verification,
      evidence,
      failures,
      decisions,
      checkpoints,
      patches,
    )
    if (this.workingBranch) summary.branchName = this.workingBranch
    if (this.taskRisk) {
      summary.riskAreas.unshift(`Overall task risk: ${this.taskRisk.level}`)
      if (this.taskRisk.requiresExplicitHumanApproval) {
        summary.humanReviewItems.unshift('Critical risk: requires explicit human approval before merge')
      }
    }
    const markdown = renderPRSummaryMarkdown(summary)

    const prPath = join(this.config.stateDir, 'tasks', taskId, 'PR.md')
    await mkdir(dirname(prPath), { recursive: true })
    await writeFile(prPath, markdown, 'utf-8')
    fire({ type: 'status', message: `PR body written to ${prPath}`, status: 'pr' })

    let prUrl: string | undefined
    if (
      this.git.pr === 'gh' &&
      this.workingBranch &&
      this.gitClient.hasRemote() &&
      ghAvailable(this.config.workDir)
    ) {
      if (this.gitClient.push(this.workingBranch)) {
        prUrl = createGhPr(this.config.workDir, {
          title: summary.title,
          body: markdown,
          base: this.baseBranch,
        })
        if (prUrl) fire({ type: 'status', message: `Opened PR: ${prUrl}`, status: 'pr' })
      }
    }

    return { commitSha, prPath, prUrl }
  }

  private buildFabric(): ToolDefinition[] {
    if (this.config.features?.domainSystem === false) return []
    this.capabilityRegistry = buildCapabilityRegistry(this.activeDomains, this.domainManifests, {
      hasDatabase: !!this.repoMap?.database,
    })
    const capContext: CapabilityContext = {
      repoRoot: this.config.workDir,
      repoMap: this.repoMap,
      repoGraph: this.repoGraph,
      taskState: undefined,
      evidence: undefined,
      failureLedger: undefined,
      decisionLedger: undefined,
    }
    this.capabilityExecutor = new CapabilityExecutor(
      this.capabilityRegistry,
      this.domainManifests,
      capContext,
    )
    return this.capabilityRegistry.toToolDefinitions()
  }

  private formatCapabilityResult(name: string, result: CapabilityResult): string {
    if (!result.success) return `${name} error: ${result.error ?? 'unknown error'}`
    return `${name} →\n${JSON.stringify(result.data, null, 2)}`
  }

  private mergeStreamResult(chunks: CompletionChunk[]): CompletionResult {
    let content = ''
    const collectedToolCalls: ToolCall[] = []
    let finishReason: CompletionResult['finishReason'] = 'stop'

    for (const chunk of chunks) {
      if (chunk.content) content += chunk.content
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          collectedToolCalls.push(tc)
        }
      }
    }

    const seenIds = new Set<string>()
    const uniqueToolCalls: ToolCall[] = []
    for (const tc of collectedToolCalls) {
      if (tc.id && seenIds.has(tc.id)) continue
      if (tc.id) seenIds.add(tc.id)
      uniqueToolCalls.push(tc)
    }

    return {
      content,
      toolCalls: uniqueToolCalls.length > 0 ? uniqueToolCalls : undefined,
      finishReason,
    }
  }
}

function toolResultMetadata(result: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  return result.metadata ?? {}
}

// Silence the unused-symbol warning while keeping the export shape stable.
void ({} as PermissionDecision)
