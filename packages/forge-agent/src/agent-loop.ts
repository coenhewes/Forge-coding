import type {
  ModelProvider,
  Message,
  TaskState,
  DomainSelection,
  AcceptanceContract,
  TaskStatus,
  EvidenceKind,
} from '@forge/types'

import { createProvider } from '@forge/provider'
import { scanRepository } from '@forge/harness'
import { buildGraph } from '@forge/harness'
import { getDomainManifests } from '@forge/harness'
import { routeTask } from '@forge/harness'
import { generateCapabilitiesFromManifests } from '@forge/harness'
import { ContextBuilder as HarnessContextBuilder } from '@forge/harness'
import type { BoundedContext } from '@forge/harness'

import { TaskStateEngine } from '@forge/state'
import { AcceptanceContractEngine } from '@forge/state'
import { EvidenceLedgerEngine } from '@forge/state'
import { FailureLedgerEngine } from '@forge/state'
import { DecisionLedgerEngine } from '@forge/state'

import { VerificationMatrixEngine, AffectedTestSelector, CheckpointManager } from '@forge/verification'

import { AgentContextBuilder } from './context-builder.js'
import { ToolExecutor, createToolDefinitions } from './tools.js'
import type { ToolExecutionContext } from './tools.js'

export interface AgentConfig {
  provider: import('@forge/types').ProviderConfig
  workDir: string
  stateDir: string
  mode: 'explore' | 'implement' | 'repair' | 'review' | 'maintain' | 'research'
  maxIterations?: number
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

    // Phase 7: Select affected tests
    if (this.domainManifests.length > 0) {
      const testSelector = new AffectedTestSelector({
        repoMap: this.repoMap!,
        repoGraph: this.repoGraph ?? { nodes: [], edges: [], regions: [], symbolDefinitions: [], symbolReferences: [], callSites: [] },
        domainManifests: this.domainManifests,
      })
      testSelector.select(taskId, [])
    }

    // Phase 8: Enter agent loop
    await this.taskEngine.updateStatus(taskId, 'exploring')

    const tools = createToolDefinitions()
    const messages: Message[] = []
    let iterations = 0
    let finalStatus = 'completed'
    let finalSummary = ''

    while (iterations < maxIterations) {
      iterations++

      const warnings = await this.failureEngine.getWarnings(taskId)
      const taskState = await this.taskEngine.getTask(taskId)
      if (!taskState) break

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

      const result = await this.provider.completeSync({
        model: this.config.provider.model,
        system: agentContext.systemPrompt,
        messages: [...agentContext.messages, ...messages],
        maxTokens: this.config.provider.maxTokens ?? 4096,
        temperature: this.config.provider.temperature ?? 0.2,
      })

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

        for (const toolCall of result.toolCalls) {
          const toolResult = await this.toolExecutor.execute(toolCall, toolContext)

          if (toolResult.metadata?.type === 'question') {
            await this.taskEngine.updateStatus(taskId, 'blocked' as TaskStatus)
            await this.taskEngine.setNextAction(taskId, `Waiting for human input: ${toolResult.metadata?.question}`)
            finalStatus = 'blocked'
            finalSummary = toolResult.content
            messages.push(...toolMessages)
            break
          }

          toolMessages.push({
            role: 'tool',
            content: toolResult.content,
            toolCallId: toolCall.id,
          })
        }

        messages.push(...toolMessages)

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
}
