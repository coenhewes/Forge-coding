import type {
  ModelProvider,
  Message,
  TaskState,
  DomainSelection,
  AcceptanceContract,
  TaskStatus,
  EvidenceKind,
  ToolCall,
  ToolDefinition,
  CompletionChunk,
  CompletionResult,
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

import { PRGenerator, renderPRSummaryMarkdown, GitClient, ghAvailable, createGhPr } from '@forge/pr'
import type { GitConfig } from '@forge/types'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import { AgentContextBuilder } from './context-builder.js'
import { ToolExecutor, createToolDefinitions } from './tools.js'
import type { ToolExecutionContext } from './tools.js'

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'file_touched' | 'command_run' | 'status' | 'error' | 'model_response'
  iteration: number
  message: string
  detail?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  filePath?: string
  status?: string
  error?: string
}

export interface AgentConfig {
  provider: import('@forge/types').ProviderConfig
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
}

export class AgentLoop {
  private config: AgentConfig
  private provider: ModelProvider

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
  private domainManifests: import('@forge/types').DomainManifest[] = []
  private domainSelection?: DomainSelection

  private git: GitConfig
  private gitClient: GitClient
  private baseBranch?: string
  private workingBranch?: string

  private capabilityRegistry?: CapabilityRegistry
  private capabilityExecutor?: CapabilityExecutor
  private taskRisk?: TaskRiskAssessment
  private activeDomains: string[] = []

  constructor(config: AgentConfig) {
    this.config = config
    this.provider = createProvider(config.provider)

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

  async run(task: string): Promise<AgentResult> {
    const taskId = `task-${Date.now()}`
    const maxIterations = this.config.maxIterations ?? 50

    // Phase 1: Initialize task state
    await this.taskEngine.createTask(taskId, task)
    await this.traceRecorder.initTask(taskId)

    // Phase 2: Build repo intelligence
    if (!this.repoMap) await this.buildRepoIntelligence()

    // Phase 2b: Create a working branch for implementation work so changes are
    // isolated from the user's current branch (best-effort; no-op outside git).
    this.startGitBranch(taskId)

    // Phase 3: Route task to domains
    this.domainSelection = routeTask(task, this.repoMap, this.repoGraph)
    const selectedDomains = this.domainSelection.selectedDomains

    // Phase 3b: Assess task risk — drives verification/approval discipline.
    this.taskRisk = assessTaskRisk({
      task,
      selectedDomains,
      manifests: this.domainManifests,
      repoMap: this.repoMap,
    })

    // Phase 4: Build the semantic capability fabric for the selected domains.
    // This is the discovery surface AGENTS.md calls for — repo/graph-backed
    // capabilities (find_callers, dependency paths, table schemas, related
    // tests, …) rather than only flat read/write primitives. The active domain
    // set can grow mid-run via the cross-domain expansion protocol.
    this.activeDomains = [...selectedDomains]
    let capabilityTools: ToolDefinition[] = this.buildFabric()

    // Phase 5: Create acceptance contract
    const contract = await this.acceptanceEngine.generateContract(taskId, task, selectedDomains)

    // Phase 6: Build bounded context for initial prompt
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

    // Phase 8: Enter agent loop
    await this.taskEngine.updateStatus(taskId, 'exploring')

    // The model sees the semantic capabilities (discovery/localization) first,
    // then the generic primitives (edit/run/verify/track). Rebuilt if scope expands.
    let tools = [...capabilityTools, ...createToolDefinitions()]
    let messages: Message[] = []
    let iterations = 0
    let finalStatus = 'in_progress'
    let finalSummary = ''
    let consecutiveNoTool = 0

    const fire = (event: Omit<AgentEvent, 'iteration'>) => {
      this.config.onEvent?.({ ...event, iteration: iterations } as AgentEvent)
    }

    while (iterations < maxIterations) {
      iterations++

      const warnings = await this.failureEngine.getWarnings(taskId)
      const taskState = await this.taskEngine.getTask(taskId)
      if (!taskState) break

      // Compact message history when it grows large
      if (iterations > 10 && messages.length > 30) {
        messages = this.compactMessages(messages)
      }

      const agentContext = this.contextBuilder.build({
        taskId,
        task,
        taskState,
        domainSelection: this.domainSelection,
        boundedContext,
        acceptanceContract: contract,
        tools,
        mode: this.config.mode,
        warnings,
        capabilityNames: capabilityTools.map((t) => t.name),
        riskAssessment: this.taskRisk,
      })

      fire({ type: 'status', message: `Iteration ${iterations}: generating...`, status: 'thinking' })

      // Stream the response for real-time feedback
      const streamChunks: CompletionChunk[] = []
      let result: CompletionResult

      try {
        for await (const chunk of this.provider.complete({
          model: this.config.provider.model,
          system: agentContext.systemPrompt,
          messages: [...agentContext.messages, ...messages],
          tools: tools,
          toolChoice: 'auto',
          maxTokens: this.config.provider.maxTokens ?? 4096,
          temperature: this.config.provider.temperature ?? 0.2,
        })) {
          streamChunks.push(chunk)
          if (chunk.content) {
            fire({ type: 'thinking', message: chunk.content })
          }
        }
        result = this.mergeStreamResult(streamChunks)
      } catch (err) {
        fire({ type: 'error', message: `Provider error: ${err}`, error: String(err) })
        break
      }

      if (result.content) {
        fire({ type: 'thinking', message: result.content.slice(0, 2000) })
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        const toolMessages: Message[] = [
          {
            role: 'assistant',
            content: result.content || '',
            toolCalls: result.toolCalls,
          },
        ]

        const toolContext: ToolExecutionContext = {
          workDir: this.config.workDir,
          repoMap: this.repoMap,
          repoGraph: this.repoGraph,
          domainManifests: this.domainManifests,
          taskId,
          taskEngine: this.taskEngine,
          acceptanceEngine: this.acceptanceEngine,
          evidenceEngine: this.evidenceEngine,
          failureEngine: this.failureEngine,
          decisionEngine: this.decisionEngine,
          verificationEngine: this.verificationEngine,
          checkpointManager: this.checkpointManager,
        }

        const changedFiles: string[] = []
        let terminalSignal: { status: string; summary: string } | undefined
        let expandedThisTurn: string[] | undefined

        consecutiveNoTool = 0

        for (const toolCall of result.toolCalls) {
          fire({
            type: 'tool_call',
            message: `Tool: ${toolCall.name}`,
            toolName: toolCall.name,
            toolInput: toolCall.input as Record<string, unknown> | undefined,
            detail: JSON.stringify(toolCall.input).slice(0, 500),
          })

          await this.traceRecorder.record(taskId, 'tool_called' as TraceEventType, toolCall.name, {
            payload: { input: toolCall.input },
          })

          // Route semantic-capability calls through the fabric; everything else
          // (edit/run/verify/track) through the primitive tool executor.
          let toolResult: { content: string; metadata?: Record<string, unknown> }
          if (this.capabilityExecutor && this.capabilityRegistry?.get(toolCall.name)) {
            const capResult = await this.capabilityExecutor.execute(
              toolCall.name,
              toolCall.input,
              { bypassPermissions: true },
            )
            toolResult = { content: this.formatCapabilityResult(toolCall.name, capResult) }
          } else {
            toolResult = await this.toolExecutor.execute(toolCall, toolContext)
          }

          // Track changed files and record trace events
          const toolInput = toolCall.input as Record<string, unknown> | undefined
          if (toolCall.name === 'read_file' && toolInput?.path) {
            await this.traceRecorder.record(taskId, 'file_read' as TraceEventType, toolInput.path as string, {
              payload: { path: toolInput.path },
            })
          }
          if ((toolCall.name === 'write_file' || toolCall.name === 'edit_file') && toolInput?.path) {
            const path = toolInput.path as string
            changedFiles.push(path)
            await this.traceRecorder.record(taskId, 'file_edited' as TraceEventType, path, {
              payload: { path, toolName: toolCall.name },
            })
          }
          if (toolCall.name === 'run_command' && toolInput?.command) {
            await this.traceRecorder.record(taskId, 'command_run' as TraceEventType, toolInput.command as string, {
              payload: { command: toolInput.command },
            })
          }

          // Store tool result as evidence
          if (this.config.features?.evidenceLedger !== false) {
            await this.evidenceMemory.storeCommandOutput(
              taskId,
              toolCall.name,
              toolResult.content.slice(0, 5000),
              !toolResult.content.startsWith('Error:'),
            )
          }

          const resultPreview = toolResult.content.slice(0, 200)
          fire({
            type: 'tool_result',
            message: `Result (${toolResult.content.length} chars)`,
            detail: resultPreview,
          })

          toolMessages.push({
            role: 'tool',
            content: toolResult.content,
            toolCallId: toolCall.id,
          })

          // Terminal signals: the agent declared the task done, or it is waiting
          // on a human. Record the signal and stop processing further tool calls
          // this iteration so we exit the loop cleanly after the messages are saved.
          if (toolResult.metadata?.type === 'finish') {
            terminalSignal = {
              status: (toolResult.metadata.status as string) || 'completed',
              summary: (toolResult.metadata.summary as string) || toolResult.content,
            }
            break
          }
          if (toolResult.metadata?.type === 'question') {
            const question = String(toolResult.metadata?.question ?? 'Needs human input')
            await this.taskEngine.addQuestion(taskId, {
              question,
              options: toolResult.metadata?.options as { label: string; description: string }[] | undefined,
              resolved: false,
              timestamp: new Date().toISOString(),
            })
            await this.taskEngine.setNextAction(taskId, `Waiting for human input: ${question}`)
            terminalSignal = { status: 'blocked', summary: toolResult.content }
            break
          }
          if (toolResult.metadata?.type === 'expansion') {
            const ds = (toolResult.metadata.domains as string[]) ?? []
            expandedThisTurn = [...(expandedThisTurn ?? []), ...ds]
          }
        }

        messages.push(...toolMessages)

        // Cross-domain expansion: widen the active domain set and rebuild the
        // capability fabric so the new domains' capabilities become available.
        if (expandedThisTurn && expandedThisTurn.length > 0) {
          this.activeDomains = [...new Set([...this.activeDomains, ...expandedThisTurn])]
          capabilityTools = this.buildFabric()
          tools = [...capabilityTools, ...createToolDefinitions()]
          fire({
            type: 'status',
            message: `Expanded scope to: ${this.activeDomains.join(', ')}`,
            status: 'expansion',
          })
        }

        // Run affected-test selection when files changed
        if (changedFiles.length > 0 && this.testSelector) {
          const selection = this.testSelector.select(taskId, changedFiles)
          await this.traceRecorder.record(taskId, 'decision' as TraceEventType, `Selected ${selection.selectedTests.length} affected tests`, {
            payload: { filesChanged: changedFiles, testCount: selection.selectedTests.length },
          })
        }

        if (terminalSignal) {
          await this.taskEngine.updateStatus(taskId, terminalSignal.status as TaskStatus)
          finalStatus = terminalSignal.status
          finalSummary = terminalSignal.summary
          break
        }
      } else {
        // No tool calls this turn. Nudge once; if the model still produces no
        // actions, treat its stop as completion rather than spinning to maxIterations.
        messages.push({ role: 'assistant', content: result.content || '' })
        consecutiveNoTool++
        if (consecutiveNoTool >= 2) {
          finalStatus = 'completed'
          finalSummary = result.content || 'Task completed.'
          break
        }
        messages.push({
          role: 'user',
          content:
            'You did not call any tool. If the task is complete and verified, call finish_task. ' +
            'Otherwise continue working: use the available tools to explore, edit, and verify.',
        })
      }

      // Once per iteration: honor a terminal status set via update_task_status,
      // and transition to verifying when all acceptance criteria are verified.
      const iterState = await this.taskEngine.getTask(taskId)
      if (
        iterState?.status === 'completed' ||
        iterState?.status === 'failed' ||
        iterState?.status === 'blocked'
      ) {
        finalStatus = iterState.status
        break
      }
      const completed = await this.acceptanceEngine.getCompletionStatus(taskId)
      if (completed.total > 0 && completed.allVerified && iterState?.status !== 'verifying') {
        await this.taskEngine.updateStatus(taskId, 'verifying' as TaskStatus)
      }
    }

    await this.traceRecorder.completeTask(taskId)

    const state = await this.taskEngine.getTask(taskId)
    const evidenceSummary = await this.evidenceEngine.getSummary(taskId)
    const failures = await this.failureEngine.getEntries(taskId)
    const decisions = await this.decisionEngine.getEntries(taskId)
    const verification = await this.verificationEngine.getSummary(taskId)

    const acceptanceStatus = await this.acceptanceEngine.getCompletionStatus(taskId)
    const promotedCheckpoints = await this.checkpointManager.getPromotedCheckpoints(taskId)

    // Finalize: commit changes and produce a reviewable PR when the task succeeded.
    const pr = await this.finalizeGit(taskId, finalStatus, fire)

    return {
      taskId,
      status: finalStatus,
      summary:
        finalSummary ||
        state?.nextAction ||
        (finalStatus === 'in_progress'
          ? `Reached iteration limit (${maxIterations}) before finishing.`
          : `Task ${finalStatus}.`),
      iterations,
      filesTouched: state?.filesTouched ?? [],
      commandsRun: state?.commandsRun ?? [],
      evidenceCount: evidenceSummary.total,
      failureCount: failures.length,
      decisionCount: decisions.length,
      verificationPassed: (verification as any).passed > 0 && (verification as any).failed === 0,
      acceptancePassed: acceptanceStatus.allVerified,
      promotedCheckpointId: promotedCheckpoints[0]?.id,
      branch: this.workingBranch,
      commitSha: pr.commitSha,
      prUrl: pr.prUrl,
      prPath: pr.prPath,
      riskLevel: this.taskRisk?.level,
    }
  }

  /**
   * Create an isolated working branch at task start. Best-effort: skips cleanly
   * when git is unavailable, when disabled, or outside implement/repair modes
   * (explore/review/research should not mutate branches).
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
   * On success, commit the agent's changes and render a PR. The PR body is
   * always written to .forge as an artifact; a real GitHub PR is opened only
   * when configured (`git.pr === 'gh'`) and the toolchain supports it.
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

    // Build the reviewable PR body from durable state.
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

    // Always persist the PR body as an artifact.
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

  /**
   * (Re)build the semantic capability fabric for the current active domain set.
   * Called once at start and again whenever the cross-domain expansion protocol
   * widens scope. Returns the capability tool definitions for the model.
   */
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

  /** Render a capability result as compact text for the model's tool message. */
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

    // Deduplicate by ID (handles Anthropic-style final-chunk emissions)
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

  private compactMessages(messages: Message[]): Message[] {
    if (messages.length <= 30) return messages

    // Keep first 2 messages (context intro + user task) and last 10 (recent turns)
    const keepStart = 2
    const keepEnd = 10

    const start = messages.slice(0, keepStart)
    const end = messages.slice(-keepEnd)
    const middle = messages.slice(keepStart, -keepEnd)

    // Summarize tool call patterns in the compacted section
    const toolCallCounts: Record<string, number> = {}
    let fileOps = 0
    let commandOps = 0
    for (const m of middle) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] || 0) + 1
          if (tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'edit_file') fileOps++
          if (tc.name === 'run_command') commandOps++
        }
      }
    }

    const summaryLines: string[] = [
      `[Compacted ${middle.length} messages from previous iterations]`,
      `- File operations: ${fileOps} | Commands: ${commandOps}`,
    ]
    for (const [name, count] of Object.entries(toolCallCounts)) {
      if (count > 1) summaryLines.push(`- ${name}: ${count} calls`)
    }

    return [
      ...start,
      { role: 'system', content: summaryLines.join('\n') },
      ...end,
    ]
  }
}
