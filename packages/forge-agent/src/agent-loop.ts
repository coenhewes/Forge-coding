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
  ActiveVerificationPlan,
  EvidenceValueScore,
} from '@forge/types'

import { createProvider } from '@forge/provider'
import { scanRepository, RepoIntel } from '@forge/repo-intel'
import { buildGraph, GraphStore, GraphQuery } from '@forge/repo-graph'
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
import { createContextServer, type ForgeContextServer } from '@forge/context-server'

import { LocalModelService, CompactionPolicy } from '@forge/local-model'
import type { LocalModelConfig } from '@forge/types'

import { PRGenerator, renderPRSummaryMarkdown, GitClient, ghAvailable, createGhPr } from '@forge/pr'
import type { GitConfig, ProviderConfig } from '@forge/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { basename, join, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import { AgentContextBuilder } from './context-builder.js'
import { ToolExecutor, createToolDefinitions } from './tools.js'
import type { ToolExecutionContext } from './tools.js'
import { PermissionEngine } from './permissions.js'
import type { PermissionDecision, PermissionRule } from './permissions.js'
import { compactToolResult, DEFAULT_TOOL_RESULT_BUDGET } from './tool-output.js'
import type { ToolCompressionSavings } from './tool-output.js'
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
  /**
   * Long-horizon run budget. The loop runs until done, blocked, or the budget
   * is exhausted (then it returns a resumable `paused` status). Lets a run go
   * for hours instead of a hard iteration cap.
   */
  budget?: {
    maxWallClockMs?: number
    maxIterations?: number
  }
  /**
   * Optional local-model layer config. When present (and not dryRun), the loop
   * delegates context compaction of large tool outputs to a cheap local model,
   * cutting frontier context pressure. The layer is non-authoritative and
   * falls back to deterministic truncation when unavailable.
   */
  localModel?: LocalModelConfig
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
  /**
   * Cumulative MAIN-MODEL token usage for the run (local-model work excluded).
   * The headline efficiency metric: verified tasks per main-model token.
   */
  mainModelUsage?: { inputTokens: number; outputTokens: number; calls: number }
}

/**
 * Read-only discovery primitives. Withheld from the EDIT tool set once the
 * model is stuck reading without writing, so the only path forward is to apply
 * an edit (or finish). run_command/run_tests are intentionally NOT here — the
 * model still needs them to build and verify after writing.
 */
const READ_ONLY_TOOL_NAMES = new Set<string>([
  'read_file',
  'search_code',
  'glob_files',
  'retrieve_artifact',
])

/**
 * Maximum consecutive EDIT passes with no file write before the loop pauses.
 * Past the read-tool withhold (≥3) and shell-inspection block, if the model
 * still hasn't written, it is not going to — pause instead of spinning.
 */
const EDIT_NO_WRITE_HARD_CAP = 8

/** Shell utilities that only read/inspect files and produce no edits. */
const READ_ONLY_SHELL_TOOLS = new Set<string>([
  'cat', 'sed', 'awk', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'head', 'tail', 'less', 'more', 'wc', 'nl', 'cut', 'sort', 'uniq',
  'ls', 'tree', 'find', 'stat', 'file', 'cmp', 'diff', 'fold', 'column',
])

/**
 * True if a shell command string is pure read-only file inspection (every
 * pipeline segment is a read-only utility). Build/test/edit commands
 * (npm, node, tsc, pnpm, git, tee, >, >>, etc.) are NOT matched, so the model
 * can still verify after writing even while read tools are withheld. Used to
 * stop a read-happy model from dodging the EDIT write-forcing guard via the
 * shell. Conservative: anything with a redirection or an unrecognised command
 * is treated as NOT read-only (i.e. allowed through).
 */
/**
 * True if a shell command builds, type-checks, lints, or runs tests — i.e.
 * forward-progress verification, not idle inspection. Used so a repair loop
 * (run test → read output → fix) doesn't trip the EDIT no-write spin cap.
 */
export function isBuildOrTestCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  return /\b(npm|pnpm|yarn|bun)\b.*\b(run\s+)?(build|test|typecheck|lint|check)\b|\b(tsc|vitest|jest|mocha|node\s+--test|pytest|go\s+test|cargo\s+(test|build|check))\b/.test(
    command,
  )
}

/**
 * True if a shell command mutates files in the working tree (renames, in-place
 * edits, applies patches, moves/copies). Such a command is real forward
 * progress even though it isn't a tracked edit_file — so it must reset the EDIT
 * no-write spin cap. (Observed: MiniMax-M3 completed a 29-file rename via
 * `git mv … && sed …`; without this, the spin cap fired and Forge PAUSED on an
 * already-finished task.)
 */
export function isFileMutatingCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  return (
    /\bgit\s+(mv|apply|checkout|restore|rm)\b/.test(command)
    || /\bsed\s+-i\b/.test(command)
    || /\bperl\s+-i\b/.test(command)
    || /\b(mv|cp)\s+[^|]*\S/.test(command)
    || /\bpatch\b/.test(command)
    || /\btee\b/.test(command)
    || /\b(echo|printf|cat)\b[^|;&]*\s>>?\s*[\w./-]+/.test(command)
  )
}

/**
 * Stable key identifying what a read/search/inspection tool call targeted, so
 * repeated reads of the same location can be told apart from exploring new ones.
 * Returns null for non-read tools (they aren't "reads" for localization). For
 * read-only shell inspection, keys on the command text itself.
 */
export function readTargetKey(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const i = input ?? {}
  switch (toolName) {
    case 'read_file':
      return `read:${String(i.path ?? '')}@${i.offset ?? 0}:${i.limit ?? ''}`
    case 'retrieve_artifact':
      return `artifact:${String(i.artifact_ref ?? i.artifactRef ?? '')}`
    case 'search_code':
      return `search:${String(i.pattern ?? '')}|${String(i.include ?? '')}`
    case 'glob_files':
      return `glob:${String(i.pattern ?? '')}`
    case 'run_command':
      return isReadOnlyShellInspection(i.command) ? `sh:${String(i.command ?? '').trim()}` : null
    default:
      return null
  }
}

export function isReadOnlyShellInspection(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const cmd = command.trim()
  if (!cmd) return false
  // Output redirection or append means it writes — not read-only.
  if (/>>?|\btee\b/.test(cmd)) return false
  const segments = cmd.split('|').map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return false
  for (const seg of segments) {
    // First bare token of the segment (skip env-var assignments like FOO=bar).
    const tokens = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
    const head = tokens[0]
    if (!head) return false
    const base = head.replace(/^.*\//, '') // strip any path prefix
    if (!READ_ONLY_SHELL_TOOLS.has(base)) return false
  }
  return true
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
  /** Consecutive failed/truncated completions (drives error tolerance). */
  consecutiveErrors: number
  /**
   * Consecutive EDIT passes that made NO progress of any kind — no write, no
   * verification run, and no NEW file/search read. Reading a not-yet-seen
   * location is legitimate localization progress (root cause far from symptom),
   * so it must NOT count here; only pure-redundant re-reading does. Drives the
   * write-forcing nudge / read-withhold / hard cap.
   */
  editPassesWithoutWrite: number
  /**
   * Read targets already seen this run (file path + offset, or search pattern).
   * Used to distinguish productive new-location reads from redundant re-reads.
   */
  readTargets: Set<string>
}

export class AgentLoop {
  private config: AgentConfig
  private provider: ModelProvider | null
  /** Last provider error message (for corrective nudges after a failed call). */
  private lastProviderError?: string

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
  /** Non-authoritative local-model accelerator + compaction policy. */
  private localModel?: LocalModelService
  private compactionPolicy?: CompactionPolicy

  private repoMap?: import('@forge/types').RepoMap
  private repoGraph?: import('@forge/types').RepoGraph
  private domainManifests: DomainManifest[] = []
  private domainSelection?: DomainSelection

  /** Dedicated repo-graph store. The agent loop calls
   *  `graphStore.set(repoGraph)` once `buildGraph` returns, then
   *  `graphStore.query()` returns a `GraphQuery` the loop can use
   *  to answer structural questions ("who calls X?", "what tests
   *  touch this file?"). Initialized in the constructor after
   *  `this.config` is set so the instance can carry per-task
   *  listeners. */
  private graphStore!: GraphStore
  /** Dedicated repo-intel accessor. Initialized in the constructor. */
  private repoIntel!: RepoIntel

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
  private contextServer?: ForgeContextServer

  /** Trace events captured during the current run. */
  private pendingTrace: TraceEventInput[] = []

  /**
   * Cumulative MAIN-MODEL (frontier provider) token usage for the run. This is
   * the metric Forge optimizes — verified tasks per main-model token — since
   * local-model work (summarize/compact/embed) is unmetered. Local-model calls
   * are NOT counted here.
   */
  private mainModelUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }

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

    // Local-model layer (opt-in). Exact inputs/outputs are persisted through
    // EvidenceMemory (stable refs) and every call is traced. Non-authoritative
    // by construction: results never touch belief/verification directly.
    if (config.localModel && !config.dryRun) {
      this.localModel = new LocalModelService(config.localModel, undefined, {
        artifacts: this.evidenceMemory,
        trace: {
          record: (taskId, description, payload) =>
            this.traceRecorder.record(taskId, 'local_model_invoked', description, { payload }).then(() => undefined),
        },
      })
      this.compactionPolicy = new CompactionPolicy(this.localModel, {
        thresholdChars: config.localModel.compactionThresholdChars,
        targetTokens: config.localModel.summaryTargetTokens,
      })
    }

    this.git = config.git ?? {
      autoBranch: true,
      autoCommit: true,
      pr: 'file',
      branchPrefix: 'forge/',
    }
    this.gitClient = new GitClient(config.workDir)

    // Dedicated repo-intelligence packages. We construct them with
    // the work directory so the agent loop can query ownership,
    // domain boundaries, and risk areas without re-scanning.
    this.graphStore = new GraphStore()
    this.repoIntel = new RepoIntel(config.workDir)
  }

  async buildRepoIntelligence(): Promise<void> {
    // Repo intel (packages, apps, routes, ownership, risk, …)
    // comes from the dedicated `@forge/repo-intel` package.
    this.repoMap = await scanRepository(this.config.workDir)
    // Prime the cached `RepoIntel` accessor so capability handlers
    // can fetch domain boundaries / risk areas on demand.
    await this.repoIntel.build()

    // The structural software graph (imports, exports, symbols,
    // call sites, references) is produced by `@forge/repo-graph`
    // and stored in the in-memory `GraphStore` the loop can query.
    this.repoGraph = this.config.features?.repoGraph !== false && this.repoMap
      ? await buildGraph(this.repoMap, this.config.workDir)
      : undefined
    if (this.repoGraph) this.graphStore.set(this.repoGraph)

    this.domainManifests = getDomainManifests()
  }

  /**
   * Convenience accessor for callers (and tests) that need a
   * read-only `GraphQuery` over the current repo graph. Returns
   * `null` until `buildRepoIntelligence()` has been awaited.
   */
  graphQuery(): GraphQuery | null {
    return this.graphStore.query()
  }

  /** Expose the underlying `RepoIntel` so capability handlers can
   *  answer ownership / domain / risk questions without
   *  re-scanning. */
  get intel(): RepoIntel {
    return this.repoIntel
  }

  /**
   * Initialise the belief and permission subsystems. The belief store
   * is wired to an `InMemoryBeliefStore` by default (so tests run
   * without Postgres) and to the supplied `ForgeStateStore` when one
   * is provided in the config. Permission rules default to
   * `PermissionEngine.defaultRules(ctx)` and can be overridden via
   * `config.permissionRules`.
   */
  private async initSubsystems(taskId: string, repoId: string, goal: string): Promise<void> {
    // Belief store — backed by Postgres when the durable state store is
    // available, otherwise by the in-memory test shim.
    this.beliefBackend = new InMemoryBeliefStore()
    this.beliefStore = this.stateStore
      ? new BeliefStore(this.stateStore)
      : new BeliefStore(this.beliefBackend.asStateStoreLike())

    // Initial task belief state. We start with a single "initial
    // understanding" hypothesis (the task is the claim) and one
    // claim per acceptance criterion we'll generate below.
    const existingBelief = await this.beliefStore.loadTaskBeliefState(taskId)
    if (!existingBelief) {
      const belief = await this.beliefStore.createTaskBeliefState(taskId, {
        repoId,
        goal,
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
    }

    // Permission engine. Built from config rules (if any) layered
    // on top of the default rule chain.
    const isReadOnlyMode = this.config.mode === 'explore' || this.config.mode === 'review' || this.config.mode === 'research'
    const rules = PermissionEngine.defaultRules({
      domains: this.domainManifests.filter((d) => this.activeDomains.includes(d.domain)),
      readOnly: isReadOnlyMode,
      capabilityTools: Array.from(this.capabilityRegistry?.getAll().keys() ?? []),
    })
    this.permissionEngine = new PermissionEngine(rules)
    if (this.config.permissionRules) {
      for (const rule of this.config.permissionRules) this.permissionEngine.addRule(rule)
    }

  }

  private async initDurableState(taskId: string, task: string): Promise<string> {
    if (this.config.stateStore) {
      this.stateStore = this.config.stateStore
    } else if (this.config.stateStoreMode === 'file') {
      return randomUUID()
    } else if (this.config.stateStoreMode === 'postgres' || process.env.FORGE_DATABASE_URL) {
      this.stateStore = new ForgeStateStore({
        config: defaultStateStoreConfig(this.config.workDir, process.env.FORGE_DATABASE_URL),
      })
    }
    if (!this.stateStore) return randomUUID()

    await this.stateStore.init()
    this.contextServer = createContextServer(this.stateStore)

    const existingRepo = await this.stateStore.repos.repos.getByRootPath(this.config.workDir)
    const repo = existingRepo ?? await this.stateStore.repos.repos.insert({
      id: randomUUID(),
      rootPath: this.config.workDir,
      name: basename(this.config.workDir),
      currentBranch: this.workingBranch ?? this.baseBranch ?? null,
      payload: {
        packageCount: this.repoMap?.packages.length ?? 0,
        appCount: this.repoMap?.apps.length ?? 0,
      },
    })

    const existingTask = await this.stateStore.repos.tasks.get(taskId)
    if (!existingTask) {
      await this.stateStore.tx(async (ctx) => {
        await ctx.repos.tasks.insert({
          id: taskId,
          repoId: repo.id,
          title: task.slice(0, 120) || 'Forge task',
          originalRequest: task,
          interpretedGoal: task,
          status: 'pending',
          mode: this.config.mode,
          activeBranch: this.workingBranch ?? null,
          activePatchCandidateId: null,
          currentSummary: null,
          nextAction: 'Initialize repo intelligence and belief state',
          payload: {},
        })
        await ctx.trace({
          type: 'task_created',
          taskId,
          repoId: repo.id,
          actor: 'system',
          summary: `Task created: ${task.slice(0, 160)}`,
          payload: { mode: this.config.mode },
        })
      })
    }

    return repo.id
  }

  private async persistAcceptanceContract(taskId: string, repoId: string, contract: AcceptanceContract): Promise<Map<string, string>> {
    const ids = new Map<string, string>()
    if (!this.stateStore) {
      for (const criterion of contract.criteria) ids.set(criterion.id, criterion.id)
      return ids
    }

    const existing = await this.stateStore.repos.acceptance.listByTask(taskId)
    for (const criterion of contract.criteria) {
      const match = existing.find((row) => row.text === criterion.description)
      if (match) {
        ids.set(criterion.id, match.id)
        continue
      }
      const row = await this.stateStore.tx(async (ctx) => {
        const inserted = await ctx.repos.acceptance.insert({
          id: randomUUID(),
          taskId,
          text: criterion.description,
          status: criterion.status === 'needs_review' ? 'needs_review' : criterion.status,
          riskLevel: criterion.riskArea ?? null,
          requiresHumanReview: criterion.status === 'needs_review',
          payload: { sourceCriterionId: criterion.id, evidenceRefs: criterion.evidenceRefs, notes: criterion.notes },
        })
        await ctx.trace({
          type: 'acceptance_criterion_added',
          taskId,
          repoId,
          actor: 'system',
          summary: `Acceptance criterion added: ${criterion.description}`,
          payload: { criterionId: inserted.id, sourceCriterionId: criterion.id },
        })
        return inserted
      })
      ids.set(criterion.id, row.id)
    }
    return ids
  }

  async run(task: string): Promise<AgentResult> {
    const taskId = randomUUID()
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
    let state = await this.taskEngine.getTask(taskId)
    if (!state) {
      const store = this.config.stateStore ?? (
        this.config.stateStoreMode === 'postgres' || (this.config.stateStoreMode !== 'file' && process.env.FORGE_DATABASE_URL)
          ? new ForgeStateStore({ config: defaultStateStoreConfig(this.config.workDir, process.env.FORGE_DATABASE_URL) })
          : undefined
      )
      if (store) {
        await store.init()
        this.stateStore = store
        const durableTask = await store.repos.tasks.get(taskId)
        if (durableTask) {
          state = await this.taskEngine.createTask(taskId, durableTask.originalRequest, {
            status: 'pending',
            currentInterpretation: durableTask.interpretedGoal ?? durableTask.originalRequest,
            nextAction: durableTask.nextAction ?? 'Resume from durable Postgres state',
          })
        }
      }
    }
    if (!state) {
      throw new Error(`Cannot resume: task ${taskId} not found in durable state`)
    }
    return this.runWithId(state.originalRequest, taskId, { resumed: true })
  }

  private async runWithId(
    task: string,
    taskId: string,
    options: { resumed: boolean },
  ): Promise<AgentResult> {
    const maxIterations = this.config.budget?.maxIterations ?? this.config.maxIterations ?? 50
    const maxWallClockMs = this.config.budget?.maxWallClockMs
    const runStartedAt = Date.now()
    let budgetExhausted = false

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

    // Phase 2c: Initialize durable Postgres state when configured.
    const repoId = await this.initDurableState(taskId, task)

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
    await this.initSubsystems(taskId, repoId, task)

    const acceptanceIdByCriterion = await this.persistAcceptanceContract(taskId, repoId, contract)

    // Seed claims from the acceptance contract.
    const existingClaims = new Set((await this.beliefStore.loadTaskBeliefState(taskId))?.claims.map((c) => c.text) ?? [])
    for (const criterion of contract.criteria) {
      if (existingClaims.has(criterion.description)) continue
      await this.beliefStore.addClaim(taskId, {
        text: criterion.description,
        status: 'unverified',
        confidence: 0,
        riskLevel: criterion.riskArea === 'high' || criterion.riskArea === 'critical' || criterion.riskArea === 'medium' || criterion.riskArea === 'low' ? criterion.riskArea : 'low',
        acceptanceCriterionRefs: [acceptanceIdByCriterion.get(criterion.id) ?? criterion.id],
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
      messages: options.resumed ? await this.resumeMessages(task, taskId) : [],
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
      consecutiveErrors: 0,
      editPassesWithoutWrite: 0,
      readTargets: new Set<string>(),
    }

    const fire = (event: Omit<AgentEvent, 'iteration'>) => {
      this.config.onEvent?.({ ...event, iteration: internal.iteration } as AgentEvent)
    }

    let finalStatus: TaskStatus | 'completed' = 'exploring'
    let finalSummary = ''
    let lastDecisionReason = 'initial'

    while (internal.iteration < maxIterations) {
      if (maxWallClockMs && Date.now() - runStartedAt >= maxWallClockMs) {
        budgetExhausted = true
        break
      }
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

    // If the loop ended without a terminal stage (iteration cap or wall-clock
    // budget), the task is not done — mark it resumable rather than a vague
    // 'exploring'. `forge resume` reconstructs from durable state and continues.
    if (finalStatus === 'exploring') {
      finalStatus = 'paused' as TaskStatus
      finalSummary =
        finalSummary ||
        (budgetExhausted
          ? `Paused at time budget after ${internal.iteration} iterations. Resume to continue.`
          : `Paused at iteration budget (${maxIterations}). Resume to continue.`)
      await this.taskEngine.updateStatus(taskId, 'paused' as TaskStatus).catch(() => undefined)
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
      mainModelUsage: { ...this.mainModelUsage },
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
    await this.persistActiveVerificationPlan(verifyPlan)
    internal.topVerifyAction = verifyPlan.recommendedAction ?? null

    // The completion gate also requires acceptance criteria to be verified,
    // so an empty belief set can never read as "done" (see gating.ts).
    const acc = await this.acceptanceEngine.getCompletionStatus(internal.taskId)
    const completion = evaluateCompletion({
      claims: (internal.belief?.claims ?? []) as Claim[],
      actions: verifyPlan.candidateActions,
      acceptance: { total: acc.total, verified: acc.verified },
    })
    internal.canComplete = completion.ready
  }

  private async persistActiveVerificationPlan(plan: ActiveVerificationPlan): Promise<void> {
    if (!this.contextServer) return
    try {
      const existing = await this.stateStore?.repos.verificationActions.listByTask(plan.taskId)
      const existingPlannerIds = new Set((existing ?? []).map((row) => String(row.payload?.plannerActionId ?? row.id)))
      for (const action of plan.candidateActions) {
        if (existingPlannerIds.has(action.id)) continue
        const durableActionId = stableUuid(action.id)
        await this.contextServer.write('verification.record_action', {
          verificationAction: {
            id: durableActionId,
            taskId: action.taskId,
            actionType: action.actionType,
            command: action.command ?? null,
            capability: action.capability ?? null,
            status: action.status,
            expectedEvidenceValue: action.expectedEvidenceValue,
            selectionReason: action.selectionReason,
            estimatedRuntimeMs: action.estimatedRuntimeMs ?? null,
            estimatedCost: action.estimatedCost ?? null,
            flakinessRisk: action.flakinessRisk ?? null,
            setupCost: action.setupCost ?? null,
            evidenceQuality: action.evidenceQuality ?? null,
            reviewUsefulness: action.reviewUsefulness ?? null,
            resultEvidenceId: action.resultEvidenceId ?? null,
            payload: {
              plannerActionId: action.id,
              targetClaims: action.targetClaims,
              targetAcceptanceCriteria: action.targetAcceptanceCriteria,
              targetHypotheses: action.targetHypotheses,
              targetRisks: action.targetRisks,
            },
          },
        }, { actor: 'verifier' })
        for (const claimId of action.targetClaims) {
          await this.contextServer.write('verification.link_action_claim', {
            verificationActionClaimLink: {
              id: stableUuid(`${action.id}:claim:${claimId}`),
              verificationActionId: durableActionId,
              claimId,
              linkType: 'targets',
              expectedConfidenceDelta: scoreForAction(plan.scores, action.id)?.components.expectedConfidenceShift ?? null,
              actualConfidenceDelta: null,
            },
          }, { actor: 'verifier' })
        }
        const score = scoreForAction(plan.scores, action.id)
        if (score) {
          await this.contextServer.write('verification.record_action_score', {
            verificationActionScore: {
              id: stableUuid(`${action.id}:score:${score.totalScore}`),
              verificationActionId: durableActionId,
              totalScore: score.totalScore,
              claimImportance: score.components.claimImportance,
              expectedConfidenceShift: score.components.expectedConfidenceShift,
              riskWeight: score.components.riskWeight,
              hypothesisDiscrimination: score.components.hypothesisDiscrimination,
              evidenceQuality: score.components.evidenceQuality,
              reviewUsefulness: score.components.reviewUsefulness,
              runtimePenalty: score.components.runtimePenalty,
              flakinessPenalty: score.components.flakinessPenalty,
              setupPenalty: score.components.setupPenalty,
              contextPenalty: score.components.contextPenalty,
              explanation: score.explanation,
            },
          }, { actor: 'verifier' })
        }
      }
    } catch (err) {
      void err
    }
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
    const completion = await this.runCompletion(agentContext.systemPrompt, agentContext.messages, internal.messages, tools, internal.taskId)
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

    // Persist probe outcome to belief store. Planner ids are semantic strings
    // (`probe:<task>:<capability>:...`), while Postgres probe ids are UUIDs.
    // Keep the semantic id in payload/input and use a stable UUID as the row id.
    const durableProbeId = stableUuid(internal.topProbe.id)
    try {
      await this.beliefStore.addProbe(internal.taskId, {
        ...internal.topProbe,
        id: durableProbeId,
        input: {
          ...(internal.topProbe.input ?? {}),
          plannerProbeId: internal.topProbe.id,
        },
      })
      await this.beliefStore.recordProbeResult(
        internal.taskId,
        durableProbeId,
        result.content.startsWith('Error:') ? 'contradicts' : 'inconclusive',
        `Probe result (${compacted.totalBytes} bytes) captured.`,
      )
    } catch (err) {
      await this.failureEngine.addEntry(
        internal.taskId,
        `Persist probe result ${internal.topProbe.id}`,
        internal.topProbe.capability,
        err instanceof Error ? err.message : String(err),
        'Probe persistence failed; continue with file-backed trace and avoid crashing the run.',
        { nextHypothesis: 'Use primitive tools or a corrected probe input instead of relying on this probe row.' },
      )
    }

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
    // Forcing function: once the model has spent several EDIT turns reading
    // without writing, remove the read-only tools so the only way forward is to
    // write (or finish). The prose nudge in handleCompletion escalates first;
    // this is the hard backstop for models that ignore it.
    const stuckReading = internal.editPassesWithoutWrite >= 3
    const editTools = stuckReading
      ? tools.filter((t) => !READ_ONLY_TOOL_NAMES.has(t.name))
      : tools
    if (stuckReading) {
      fire({
        type: 'status',
        message: `EDIT: read tools withheld (no write in ${internal.editPassesWithoutWrite} passes) — write or finish`,
        status: 'edit',
      })
    }
    const agentContext = this.contextBuilder.build({
      taskId: internal.taskId,
      task: internal.task,
      taskState: await this.taskEngine.getTask(internal.taskId),
      domainSelection: this.domainSelection,
      boundedContext,
      acceptanceContract: contract,
      tools: editTools,
      mode: this.config.mode,
      warnings: await this.failureEngine.getWarnings(internal.taskId),
      capabilityNames: _capabilityTools.map((t) => t.name),
      riskAssessment: this.taskRisk,
    })
    const completion = await this.runCompletion(agentContext.systemPrompt, agentContext.messages, internal.messages, editTools, internal.taskId)
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

    // Provider error (after retries): never crash — nudge and retry, with a
    // bounded tolerance so a persistently-broken provider eventually blocks.
    if (completion.finishReason === 'error') {
      internal.consecutiveErrors += 1
      const detail = this.lastProviderError ? ` (${this.lastProviderError})` : ''
      fire({ type: 'error', message: `Model call failed${detail}; retrying` })
      if (internal.consecutiveErrors >= 5) {
        return { terminal: true, terminalStatus: 'blocked', summary: `Repeated model-call failures${detail}. Resume to retry.` }
      }
      // A repeated failure is often a too-large request (context overflow →
      // some providers return an opaque 400). Compact the working history to
      // shrink the next request before retrying.
      if (internal.consecutiveErrors >= 2) {
        internal.messages = await this.compactMessages(internal.messages, internal.taskId, true)
      }
      internal.messages.push({
        role: 'user',
        content:
          `The previous model call failed${detail}. This often means the response was too large and was cut off. ` +
          `Continue, and when writing files keep each tool call small (one file at a time, split very large files).`,
      })
      return {}
    }
    internal.consecutiveErrors = 0

    // A truncated response with no usable tool call (hit the token cap mid
    // tool-argument): ask the model to produce smaller output rather than spin.
    if (completion.finishReason === 'length' && (!completion.toolCalls || completion.toolCalls.length === 0)) {
      internal.messages.push({ role: 'assistant', content: completion.content || '' })
      internal.messages.push({
        role: 'user',
        content:
          'Your last response was cut off at the token limit before completing a tool call. ' +
          'Write smaller outputs: create files one at a time and split large file contents into multiple edits.',
      })
      return {}
    }

    if (!completion.toolCalls || completion.toolCalls.length === 0) {
      internal.messages.push({ role: 'assistant', content: completion.content || '' })
      internal.consecutiveNoTool += 1

      // Only treat "model went quiet" as completion if the gate actually
      // passes (acceptance criteria verified). Otherwise the model stopped
      // before finishing the work — keep nudging, then fail honestly rather
      // than reporting a false "completed".
      if (internal.canComplete) {
        return { terminal: true, terminalStatus: 'completed', summary: completion.content || 'Task completed.' }
      }
      if (internal.consecutiveNoTool >= 4) {
        return {
          terminal: true,
          terminalStatus: 'blocked',
          summary:
            'Model stopped calling tools before acceptance criteria were verified. ' +
            'The task is not complete; resume to continue.',
        }
      }
      internal.messages.push({
        role: 'user',
        content:
          'You did not call any tool, and the acceptance criteria are NOT yet verified, so the task is not done. ' +
          'Do not stop. Use the tools to make progress: read the relevant files, edit_file to implement the change, ' +
          'run_tests to check it, update_acceptance to mark each criterion verified once its evidence passes, ' +
          'and only then call finish_task.',
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
    // A pass that runs build/test/verification is making forward progress even
    // without a file write (the model is in a run-test → read-output → fix
    // repair loop). Such passes must NOT count toward the no-write spin cap, or
    // a legitimate repair loop gets paused. (iter3 regression: the hard cap
    // mis-fired mid-repair while npm test was timing out.)
    let ranVerificationThisPass = false
    // A pass that reads a NEW file/range or runs a NEW search is making
    // localization progress (legitimately exploring to find a root cause far
    // from its symptom). It must NOT count toward the no-write spin cap — only
    // re-reading already-seen locations does.
    let readNewThisPass = false

    for (const toolCall of completion.toolCalls) {
      // EDIT read-leak guard. When read tools are withheld (the model has been
      // stuck reading without writing), a read-happy model will route file
      // inspection through run_command (cat/sed/grep/head/tail/…) to dodge the
      // withhold. Observed with MiniMax-M3: 45 such shell reads across 44
      // withhold passes, never converging. Deny pure read-only shell
      // inspection while stuck so the only path forward is to write or finish.
      // npm/node/tsc build & test commands are NOT read-only inspection and
      // pass through — the model still needs them to verify after writing.
      if (
        internal.stage === 'EDIT'
        && internal.editPassesWithoutWrite >= 3
        && toolCall.name === 'run_command'
        && isReadOnlyShellInspection((toolCall.input as Record<string, unknown> | undefined)?.command)
      ) {
        fire({
          type: 'status',
          message: 'EDIT: read-only shell inspection blocked while stuck — write or finish',
          status: 'edit',
          toolName: toolCall.name,
        })
        toolMessages.push({
          role: 'tool',
          content:
            'Blocked: read-only shell inspection (cat/sed/grep/head/tail/…) is disabled because you have read ' +
            'repeatedly without writing. You already have enough context. Apply the change now with edit_file or ' +
            'write_file, run npm run build / npm test to verify, or call finish_task. Do not read more.',
          toolCallId: toolCall.id,
        })
        continue
      }

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
        // A destructive-looking run_command must NOT hard-halt an unattended
        // long-horizon run. (Observed: MiniMax-M3 chose an efficient
        // `grep … | xargs sh -c 'sed … > tmp && mv'` bulk rename; the classifier
        // flagged `sh -c` and blocked the whole run for human approval, wasting
        // the run.) Instead: do NOT execute the risky command (safety preserved),
        // but DENY-and-continue with a redirect to tracked edits, and record the
        // decision — mirroring the low/medium-risk ask_question autonomy policy.
        // Non-shell asks still escalate to a human.
        if (toolCall.name === 'run_command') {
          fire({
            type: 'status',
            message: `Blocked risky shell command, continuing autonomously: ${decision.reason}`,
            status: 'permission-ask',
            toolName: toolCall.name,
          })
          await this.decisionEngine.addEntry(
            internal.taskId,
            'Declined a risky shell command and continued autonomously',
            `Permission classifier flagged: ${decision.reason}. An unattended run does not halt for this.`,
            [],
            { domain: 'autonomy:shell' },
          )
          toolMessages.push({
            role: 'tool',
            content:
              `Blocked (not executed): ${decision.reason}. ` +
              'This is an autonomous run — it will not pause for approval. Do NOT retry this command. ' +
              'Make the change through tracked tools instead: use edit_file / write_file for each file ' +
              '(these are checkpointed and recorded as evidence), or use a non-destructive command. ' +
              'For a repo-wide rename, apply edit_file to each affected file in turn.',
            toolCallId: toolCall.id,
          })
          continue
        }
        // Non-shell ask: emit a "needs human approval" terminal signal so the
        // loop pauses cleanly. The TUI shows the question.
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
      // Track whether this pass ran a build/test/verification — productive work
      // that should not count toward the EDIT no-write spin cap.
      if (
        toolCall.name === 'run_tests'
        || toolCall.name === 'run_verification'
        || toolCall.name === 'verify_check'
        || (toolCall.name === 'run_command'
          && (isBuildOrTestCommand((toolInput)?.command)
            || (isFileMutatingCommand((toolInput)?.command)
              && !result.content.startsWith('Error:'))))
      ) {
        ranVerificationThisPass = true
      }
      // Track NEW-location reads as localization progress. A read of a file
      // range or a search pattern not seen before this run means the model is
      // actively localizing, not spinning — so it must not advance the cap.
      {
        const readKey = readTargetKey(toolCall.name, toolInput)
        if (readKey && !internal.readTargets.has(readKey)) {
          internal.readTargets.add(readKey)
          readNewThisPass = true
        }
      }
      // A file-mutating shell command (git mv / sed -i / patch / redirect) is a
      // real change to the tree even though it isn't a tracked edit_file. Record
      // the working-tree delta as touched files so completion detection and the
      // evidence ledger know work happened (otherwise Forge can finish a task
      // via shell and not realize it).
      if (
        toolCall.name === 'run_command'
        && isFileMutatingCommand((toolInput)?.command)
        && !result.content.startsWith('Error:')
      ) {
        const mutated = await this.detectWorkingTreeChanges(internal.taskId)
        for (const f of mutated) if (!changedFiles.includes(f)) changedFiles.push(f)
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
      if (
        result.metadata?.type === 'verification'
        && result.metadata.passed === true
        && result.metadata.check === 'test'
      ) {
        const taskState = await this.taskEngine.getTask(internal.taskId)
        const filesTouched = taskState?.filesTouched ?? []
        const vsummary = await this.verificationEngine.getSummary(internal.taskId).catch(() => null)
        const passed = vsummary?.passed ?? 0
        const failed = vsummary?.failed ?? 0
        if (filesTouched.length > 0 && passed > 0 && failed === 0) {
          const contract = await this.acceptanceEngine.getContract(internal.taskId)
          for (const c of contract?.criteria ?? []) {
            if (c.status !== 'verified' && c.status !== 'failed' && c.status !== 'blocked') {
              await this.acceptanceEngine.updateCriterionStatus(
                internal.taskId,
                c.id,
                'verified',
                `auto-verified: ${String(result.metadata.command ?? 'test command')} passed`,
              )
            }
          }
          terminalSignal = {
            status: 'completed',
            summary:
              `Completed after passing test verification (${String(result.metadata.command ?? 'test command')}).`,
          }
          break
        }
      }
      if (result.metadata?.type === 'question') {
        const question = String(result.metadata?.question ?? 'Needs human input')
        const options = result.metadata?.options as { label: string; description: string }[] | undefined
        const recommendation = String(result.metadata?.recommendation ?? options?.[0]?.label ?? 'Use Forge recommended default')
        const riskLevel = String(result.metadata?.riskLevel ?? result.metadata?.risk_level ?? 'low')
        const requiresHuman = Boolean(result.metadata?.requiresHuman ?? result.metadata?.requires_human) || riskLevel === 'high' || riskLevel === 'critical'
        if (requiresHuman) {
          await this.taskEngine.addQuestion(internal.taskId, {
            question,
            options,
            resolved: false,
            timestamp: new Date().toISOString(),
          })
          await this.taskEngine.setNextAction(internal.taskId, `Waiting for human input: ${question}`)
          terminalSignal = { status: 'blocked', summary: result.content }
          break
        }

        const rejected = (options ?? [])
          .map((option) => option.label)
          .filter((label) => label !== recommendation)
        const decision = `Auto-selected default: ${recommendation}`
        await this.decisionEngine.addEntry(
          internal.taskId,
          decision,
          `Forge continued autonomously because ask_question was marked low/medium risk. Question: ${question}`,
          rejected,
          { domain: `autonomy:${riskLevel}` },
        )
        await this.taskEngine.addDecision(internal.taskId, decision)
        await this.taskEngine.setNextAction(internal.taskId, `Continuing with default decision: ${recommendation}`)
        toolMessages.push({
          role: 'user',
          content:
            `Autonomy policy: this question is ${riskLevel} risk and does not require human approval. ` +
            `Proceed with the recommended default: ${recommendation}. Record assumptions and keep working.`,
        })
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

    // EDIT write-forcing guard. In EDIT the model is supposed to implement the
    // change, but a read-happy model can spin indefinitely calling read_file /
    // search_code without ever producing a write — burning the whole budget
    // with zero code changes (observed with MiniMax-M3 on the pipelined-stdio
    // task: 14 EDIT passes, 0 writes). We count consecutive EDIT passes that
    // touched no file and inject an escalating nudge so context-gathering
    // converges to an actual edit. Reset as soon as a write lands.
    if (internal.stage === 'EDIT' && !terminalSignal) {
      const wroteThisPass = changedFiles.length > 0
      if (wroteThisPass || ranVerificationThisPass || readNewThisPass) {
        // Forward progress = a write, a build/test/verification run, OR reading
        // a NEW location (active localization). Reset the spin counter. Only a
        // pass that did NONE of these — pure redundant re-reading of things
        // already seen — advances toward the cap.
        internal.editPassesWithoutWrite = 0
      } else {
        internal.editPassesWithoutWrite += 1
        const n = internal.editPassesWithoutWrite
        if (n === 2) {
          internal.messages.push({
            role: 'user',
            content:
              'You are in the EDIT stage and have spent the last ' + n + ' turns only reading/searching, not editing. ' +
              'You now have enough context. Stop gathering context and implement the change now: call edit_file or write_file ' +
              'to apply the fix in this turn. Do not call read_file or search_code again unless an edit fails.',
          })
        } else if (n >= EDIT_NO_WRITE_HARD_CAP) {
          // Hard cap: the model has spun far too long reading without writing
          // (even with read tools withheld and shell inspection blocked). Stop
          // burning budget — pause with durable state so a human or a resume
          // can intervene, rather than churning to the iteration ceiling.
          await this.taskEngine.setNextAction(
            internal.taskId,
            'EDIT stalled: model read ' + n + ' passes without writing. Resume to retry or narrow the task.',
          )
          await this.failureEngine.addEntry(
            internal.taskId,
            'EDIT stage stalled without a write',
            'edit-stage',
            n + ' consecutive EDIT passes produced no file write despite read tools being withheld',
            'The model could not converge from context-gathering to an edit. Consider a smaller task or more targeted localization.',
            {},
          )
          return {
            terminal: true,
            terminalStatus: 'paused',
            summary:
              'Paused: the EDIT stage read ' + n + ' passes without producing a write. ' +
              'Resume to retry, or narrow the task scope.',
          }
        } else if (n >= 3) {
          // Strip-read backstop already withholds read tools in runEditStage; here
          // we escalate the prose so the model commits to a write or finishes.
          internal.messages.push({
            role: 'user',
            content:
              'STOP READING. This is your ' + n + 'th consecutive EDIT turn with no file write. ' +
              'Reading more will not help and is wasting the run budget. In your NEXT response you MUST call edit_file ' +
              'or write_file to apply the implementation. If you believe no edit is needed, call finish_task with an ' +
              'explanation instead. Any further read attempt (including shell cat/sed/grep) is a mistake.',
          })
        }
      }
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
      stateDir: this.config.stateDir,
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
      evidenceMemory: this.evidenceMemory,
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
    } catch (err) {
      // A tool that throws (e.g. read_file on a path the model guessed wrong,
      // ENOENT) must NOT crash a long-horizon run. Return the error as the tool
      // result so the model sees it and self-corrects (fix the path, try
      // another file), exactly as it would for any other tool failure.
      const msg = err instanceof Error ? err.message : String(err)
      fire({ type: 'error', message: `Tool ${toolCall.name} failed: ${msg}`, error: msg, toolName: toolCall.name })
      result = { content: `Error: ${toolCall.name} failed: ${msg}` }
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

  /** How many of the most recent raw turns to replay alongside the situation report. */
  private static readonly RECENT_WINDOW = 14

  /**
   * State-backed context (AGENTS.md: "never rely purely on a long chat
   * transcript"). Each turn the model sees: the original task, a SITUATION
   * REPORT regenerated from durable state (criteria + check status, open
   * subtasks, recent evidence refs, failures-not-to-repeat, files touched),
   * and only the last N raw turns. This bounds context regardless of run
   * length and makes runs resumable — the durable state is the memory.
   */
  private async buildSituationReport(taskId: string): Promise<Message | null> {
    try {
      const task = await this.taskEngine.getTask(taskId)
      if (!task) return null
      const lines: string[] = ['[SITUATION REPORT — regenerated from durable state each turn]']
      lines.push(`Goal: ${task.currentInterpretation || task.originalRequest}`)
      lines.push(`Status: ${task.status} | Next: ${task.nextAction || '(decide)'}`)

      const contract = await this.acceptanceEngine.getContract(taskId).catch(() => undefined)
      if (contract && contract.criteria.length > 0) {
        const verified = contract.criteria.filter((c) => c.status === 'verified').length
        lines.push('', `Acceptance criteria (${verified}/${contract.criteria.length} verified):`)
        for (const c of contract.criteria) {
          const icon = c.status === 'verified' ? '✓' : c.status === 'failed' ? '✗' : '○'
          const checks = c.requiredChecks?.length ? ` [checks: ${c.requiredChecks.join(',')}]` : ''
          lines.push(`  ${icon} [${c.id}] ${c.description}${checks}`)
        }
      }

      const checks = await this.verificationEngine.getEntries(taskId).catch(() => [])
      if (checks.length > 0) {
        lines.push('', `Verification checks: ${checks.map((e) => `${e.check}=${e.status}`).join(' ')}`)
      }

      const openSubtasks = (task.subtasks ?? []).filter((s) => s.status !== 'completed')
      if (openSubtasks.length > 0) {
        lines.push('', 'Open subtasks:')
        for (const s of openSubtasks.slice(0, 12)) lines.push(`  ☐ ${s.description ?? s.id}`)
      }

      const recentEvidence = await this.evidenceMemory.queryByTask(taskId, 6).catch(() => [])
      if (recentEvidence.length > 0) {
        lines.push('', 'Recent evidence (recoverable by id):')
        for (const a of recentEvidence) lines.push(`  ${a.id} (${a.kind}) ${a.description.slice(0, 80)}`)
      }

      const failures = await this.failureEngine.getEntries(taskId).catch(() => [])
      if (failures.length > 0) {
        lines.push('', 'Failures so far (do NOT repeat these approaches):')
        for (const f of failures.slice(-3)) {
          const desc = (f as { summary?: string; description?: string }).summary
            ?? (f as { description?: string }).description ?? JSON.stringify(f).slice(0, 100)
          lines.push(`  ⚠ ${String(desc).slice(0, 120)}`)
        }
      }

      if (task.filesTouched.length > 0) {
        lines.push('', `Files touched: ${task.filesTouched.slice(0, 20).join(', ')}`)
      }
      lines.push('', 'Continue from here: take the next concrete action toward verifying all criteria.')
      return { role: 'user', content: lines.join('\n') }
    } catch {
      return null
    }
  }

  private async runCompletion(
    system: string,
    baseMessages: Message[],
    history: Message[],
    tools: ToolDefinition[],
    taskId: string,
  ): Promise<CompletionResult> {
    if (!this.provider) {
      // dryRun — synthesize a no-tool completion so the loop can advance.
      return { content: 'dry-run: no provider configured', finishReason: 'stop' }
    }
    // State-backed context: original task + fresh situation report + a bounded
    // window of recent turns (not the whole transcript). Orphan tool blocks
    // from the window cut are scrubbed by the provider message mapper.
    const situation = await this.buildSituationReport(taskId)
    let recentWindow = history.slice(-AgentLoop.RECENT_WINDOW)
    if (this.compactionPolicy) {
      const compacted = await this.compactionPolicy.compactToolOutputs(taskId, recentWindow)
      recentWindow = compacted.messages
      if (compacted.compacted > 0) {
        this.pendingTrace.push({
          type: 'local_model_invoked',
          taskId,
          actor: 'agent',
          summary: `Compacted ${compacted.compacted} historical tool output(s) before frontier call`,
          payload: { refs: compacted.refs, localModel: true, authoritative: false },
        })
      }
    }
    const assembled: Message[] = situation
      ? [...baseMessages, situation, ...recentWindow]
      : [...baseMessages, ...recentWindow]
    // A single failed completion (network blip, provider 4xx/5xx, truncated
    // tool JSON) must never crash a long-horizon run. Retry once, then degrade
    // to a 'error' finishReason that the loop turns into a corrective nudge.
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const streamChunks: CompletionChunk[] = []
        for await (const chunk of this.provider.complete({
          model: this.config.provider.model,
          system,
          messages: assembled,
          tools,
          toolChoice: 'auto',
          maxTokens: this.config.provider.maxTokens ?? 8192,
          temperature: this.config.provider.temperature ?? 0.2,
        })) {
          streamChunks.push(chunk)
        }
        const merged = this.mergeStreamResult(streamChunks)
        if (merged.usage) {
          this.mainModelUsage.inputTokens += merged.usage.inputTokens
          this.mainModelUsage.outputTokens += merged.usage.outputTokens
          this.mainModelUsage.calls += 1
          this.pendingTrace.push({
            type: 'model_call' as TraceEventType,
            taskId,
            actor: 'agent',
            summary:
              `Main-model call: ${merged.usage.inputTokens} in / ${merged.usage.outputTokens} out tokens ` +
              `(run total ${this.mainModelUsage.inputTokens}/${this.mainModelUsage.outputTokens} over ${this.mainModelUsage.calls} calls)`,
            payload: {
              inputTokens: merged.usage.inputTokens,
              outputTokens: merged.usage.outputTokens,
              runTotalInput: this.mainModelUsage.inputTokens,
              runTotalOutput: this.mainModelUsage.outputTokens,
              calls: this.mainModelUsage.calls,
              localModel: false,
              authoritative: true,
            },
          })
        }
        return merged
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.lastProviderError = msg
        if (attempt >= maxAttempts) {
          return { content: '', finishReason: 'error' }
        }
      }
    }
    return { content: '', finishReason: 'error' }
  }

  /**
   * Inspect the git working tree for changed source files and record them as
   * touched. Used after a file-mutating shell command (git mv / sed -i / patch)
   * so Forge's state knows work happened even when the change bypassed the
   * tracked edit_file tool. Returns the changed paths (best-effort; returns []
   * if the workDir isn't a git repo or git is unavailable).
   */
  private async detectWorkingTreeChanges(taskId: string): Promise<string[]> {
    try {
      const { stdout: rootStdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: this.config.workDir,
        maxBuffer: 1024 * 1024,
      })
      if (resolve(rootStdout.trim()) !== resolve(this.config.workDir)) return []
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: this.config.workDir,
        maxBuffer: 8 * 1024 * 1024,
      })
      const files: string[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        // Format: "XY path" or rename "XY old -> new". Take the final path.
        const rest = line.slice(3)
        const path = rest.includes(' -> ') ? rest.split(' -> ')[1] ?? rest : rest
        const clean = path.trim().replace(/^"|"$/g, '')
        if (clean) files.push(clean)
      }
      for (const f of files) {
        try { await this.taskEngine.addFileTouched(taskId, f) } catch { /* non-fatal */ }
      }
      return files
    } catch {
      return []
    }
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
  ): Promise<{ content: string; totalBytes: number; truncated: boolean; artifactRef?: string; strategy?: string; savings?: ToolCompressionSavings }> {
    const budget = this.config.toolOutputBudget ?? DEFAULT_TOOL_RESULT_BUDGET
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
    if (compacted.truncated) {
      this.pendingTrace.push({
        type: 'local_model_invoked',
        taskId,
        actor: 'agent',
        summary: `Compressed tool output from ${toolName}`,
        payload: {
          toolName,
          strategy: compacted.strategy,
          artifactRef: compacted.artifactRef,
          savings: compacted.savings,
          localModel: false,
          deterministic: true,
          authoritative: false,
        },
      })
    }
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
      const task = await this.stateStore.repos.tasks.get(taskId)
      const repoId = task?.repoId ?? null
      await this.stateStore.tx(async (ctx) => {
        for (const ev of events) {
          await ctx.trace({ ...ev, repoId: ev.repoId ?? repoId })
        }
      })
    } catch {
      // Persistence is best-effort; the local TraceRecorder file log
      // is the primary record.
    }
    void taskId
  }

  /** Resumption: re-admit the prior prompt with a 'resumed' marker. */
  private async resumeMessages(task: string, taskId: string): Promise<Message[]> {
    let durable = ''
    if (this.contextServer) {
      const slice = await this.contextServer.read('task.resume', { taskId, limit: 8 }).catch(() => undefined)
      if (slice?.data) {
        durable =
          '\n\nDurable resume state from Forge Context Server (authoritative):\n' +
          JSON.stringify(slice.data, null, 2).slice(0, 12_000)
      }
    }
    return [
      {
        role: 'user',
        content: `[Resumed session ${taskId}]\n\nThe previous run was interrupted. Continuing task: ${task}${durable}`,
      },
    ]
  }

  private async compactMessages(messages: Message[], taskId: string, force = false): Promise<Message[]> {
    if (!force && messages.length <= 30) return messages
    if (messages.length <= 12) return messages
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

    // When the local-model layer is available, replace the deterministic
    // placeholder with a real semantic summary of the dropped tool outputs.
    // The exact originals remain recoverable via the stored artifact id, so
    // this only reduces working-context size — it never loses evidence.
    if (this.localModel && (await this.localModel.available())) {
      const droppedToolText = middle
        .filter((m) => m.role === 'tool' && typeof m.content === 'string')
        .map((m) => m.content)
        .join('\n---\n')
      if (droppedToolText.length > 0) {
        const result = await this.localModel.summarize({
          taskId,
          content: droppedToolText,
          label: `${middle.length} compacted iteration messages`,
        })
        summaryLines.push('', 'Summary of dropped tool output (non-authoritative):', result.summary)
        if (result.sourceArtifactId) {
          summaryLines.push(`Exact original: ${result.sourceArtifactId} (evidence.get_exact_artifact)`)
        }
      }
    }

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
    let inputTokens = 0
    let outputTokens = 0
    let sawUsage = false

    for (const chunk of chunks) {
      if (chunk.content) content += chunk.content
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          collectedToolCalls.push(tc)
        }
      }
      if (chunk.usage) {
        if (typeof chunk.usage.inputTokens === 'number') {
          inputTokens = Math.max(inputTokens, chunk.usage.inputTokens)
          sawUsage = true
        }
        if (typeof chunk.usage.outputTokens === 'number') {
          outputTokens = Math.max(outputTokens, chunk.usage.outputTokens)
          sawUsage = true
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
      ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
    }
  }
}

function toolResultMetadata(result: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  return result.metadata ?? {}
}

function scoreForAction(scores: EvidenceValueScore[], actionId: string): EvidenceValueScore | undefined {
  return scores.find((score) => score.actionId === actionId)
}

function stableUuid(input: string): string {
  const chars = createHash('sha256').update(input).digest('hex').slice(0, 32).split('')
  chars[12] = '4'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Silence the unused-symbol warning while keeping the export shape stable.
void ({} as PermissionDecision)
