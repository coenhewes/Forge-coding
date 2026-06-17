import type {
  ModelProvider,
  Message,
  TaskState,
  DomainSelection,
  AcceptanceContract,
  TaskStatus,
  EvidenceKind,
  ToolCall,
  CompletionChunk,
  CompletionResult,
} from '@forge/types'

import { createProvider } from '@forge/provider'
import { scanRepository } from '@forge/harness'
import { buildGraph } from '@forge/harness'
import { getDomainManifests } from '@forge/harness'
import { routeTask } from '@forge/harness'
import { generateCapabilitiesFromManifests } from '@forge/harness'
import { ContextBuilder as HarnessContextBuilder } from '@forge/harness'
import type { BoundedContext } from '@forge/harness'

import { TraceRecorder } from '@forge/trace'
import type { TraceEventType } from '@forge/types'

import { TaskStateEngine, EvidenceMemory, EvidenceLedgerEngine } from '@forge/state'
import { AcceptanceContractEngine } from '@forge/state'
import { FailureLedgerEngine } from '@forge/state'
import { DecisionLedgerEngine } from '@forge/state'

import { VerificationMatrixEngine, AffectedTestSelector, CheckpointManager } from '@forge/verification'

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
    this.checkpointManager = new CheckpointManager({ stateDir })
    this.toolExecutor = new ToolExecutor()
    this.contextBuilder = new AgentContextBuilder()
    this.traceRecorder = new TraceRecorder({ stateDir })
    this.evidenceMemory = new EvidenceMemory({ stateDir })
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

    // Phase 3: Route task to domains
    this.domainSelection = routeTask(task, this.repoMap, this.repoGraph)
    const selectedDomains = this.domainSelection.selectedDomains

    // Phase 4: Generate capabilities for selected domains
    generateCapabilitiesFromManifests(
      this.domainManifests.filter((d) => selectedDomains.includes(d.domain)),
    )

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

    const tools = createToolDefinitions()
    let messages: Message[] = []
    let iterations = 0
    let finalStatus = 'completed'
    let finalSummary = ''

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

          const toolResult = await this.toolExecutor.execute(toolCall, toolContext)

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

          if (toolResult.metadata?.type === 'question') {
            await this.taskEngine.updateStatus(taskId, 'blocked' as TaskStatus)
            await this.taskEngine.setNextAction(taskId, `Waiting for human input: ${toolResult.metadata?.question}`)
            finalStatus = 'blocked'
            finalSummary = toolResult.content
            messages.push(...toolMessages)
            break
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
        }

        messages.push(...toolMessages)

        // Run affected-test selection when files changed
        if (changedFiles.length > 0 && this.testSelector) {
          const selection = this.testSelector.select(taskId, changedFiles)
          await this.traceRecorder.record(taskId, 'decision' as TraceEventType, `Selected ${selection.selectedTests.length} affected tests`, {
            payload: { filesChanged: changedFiles, testCount: selection.selectedTests.length },
          })
        }

    await this.traceRecorder.completeTask(taskId)

    const state = await this.taskEngine.getTask(taskId)
        if (state?.status === 'completed' || state?.status === 'failed' || state?.status === 'blocked') {
          finalStatus = state.status
          break
        }

        const completed = await this.acceptanceEngine.getCompletionStatus(taskId)
        if (completed.allVerified) {
          await this.taskEngine.updateStatus(taskId, 'verifying' as TaskStatus)
        }

      } else {
        messages.push({ role: 'assistant', content: result.content || '' })
        if (result.finishReason === 'stop') {
          // Continue — model may not have called tools yet
        }
      }
    }

    const state = await this.taskEngine.getTask(taskId)
    const evidenceSummary = await this.evidenceEngine.getSummary(taskId)
    const failures = await this.failureEngine.getEntries(taskId)
    const decisions = await this.decisionEngine.getEntries(taskId)
    const verification = await this.verificationEngine.getSummary(taskId)

    const acceptanceStatus = await this.acceptanceEngine.getCompletionStatus(taskId)
    const promotedCheckpoints = await this.checkpointManager.getPromotedCheckpoints(taskId)

    return {
      taskId,
      status: finalStatus,
      summary: finalSummary || state?.nextAction || 'Task completed.',
      iterations,
      filesTouched: state?.filesTouched ?? [],
      commandsRun: state?.commandsRun ?? [],
      evidenceCount: evidenceSummary.total,
      failureCount: failures.length,
      decisionCount: decisions.length,
      verificationPassed: (verification as any).passed > 0 && (verification as any).failed === 0,
      acceptancePassed: acceptanceStatus.allVerified,
      promotedCheckpointId: promotedCheckpoints[0]?.id,
    }
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
