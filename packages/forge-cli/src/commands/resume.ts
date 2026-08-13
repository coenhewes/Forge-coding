import { AgentLoop } from '@forge/agent'
import type { AgentConfig, AgentResult } from '@forge/agent'
import { TaskStateEngine } from '@forge/state'
import type { CommandResult, ParsedArgs } from './output.js'
import { loadConfig, initConfig, isInitialized } from '../config.js'
import { createRunRenderer } from './run-renderer.js'
import { longHorizonBudget, runPreflight } from '../preflight.js'

export async function runResume(parsed: ParsedArgs): Promise<CommandResult<AgentResult | { taskId: string; status: string; summary: string }>> {
  const taskId = parsed.positional[0]
  const answer = parsed.positional.slice(1).join(' ').trim()
  if (!taskId) {
    return {
      ok: false,
      exitCode: 1,
      data: { taskId: 'unknown', status: 'error', summary: 'task ID required' },
      message: 'forge resume: task ID required',
      textLines: ['Error: task ID required. Usage: forge resume <taskId> [answer]'],
    }
  }

  let config = await loadConfig()
  if (!config) config = await initConfig()
  if (!isInitialized(config.stateDir)) config = await initConfig()

  const preflight = await runPreflight({ command: 'resume', config, parsed, requireLocalApproval: true })
  if (preflight.fatal) {
    return {
      ok: false,
      exitCode: 1,
      data: { taskId, status: 'preflight_failed', summary: preflight.errors.join(' ') },
      message: 'forge resume: preflight failed',
      textLines: preflight.textLines,
    }
  }

  if (answer) {
    const engine = new TaskStateEngine({ stateDir: config.stateDir })
    const task = await engine.getTask(taskId)
    const openQuestion = task?.openQuestions.find((q) => !q.resolved)
    if (openQuestion) {
      await engine.resolveQuestion(taskId, openQuestion.question, answer)
    }
  }

  const budget = longHorizonBudget(parsed)
  const agentConfig: AgentConfig = {
    provider: config.provider,
    workDir: config.workDir,
    stateDir: config.stateDir,
    mode: config.mode,
    maxIterations: budget.maxIterations,
    budget,
    features: config.features,
    git: config.git,
    localModel: config.cheapModel ?? config.localModel,
    stateStore: preflight.stateStore,
    stateStoreMode: preflight.stateMode,
    onEvent: createRunRenderer(!parsed.json),
  }

  try {
    const agent = new AgentLoop(agentConfig)
    await agent.buildRepoIntelligence()
    const result = await agent.resume(taskId)
    return {
      ok: result.status === 'completed' || result.status === 'success',
      exitCode: result.status === 'completed' || result.status === 'success' ? 0 : 2,
      data: result,
      message: `Task ${result.taskId} → ${result.status}`,
      textLines: [
        ...preflight.textLines,
        '',
        '─── Resume Result ───',
        `Status: ${result.status}`,
        `Iterations: ${result.iterations}`,
        `Files touched: ${result.filesTouched.length}`,
        `Commands run: ${result.commandsRun.length}`,
        `Evidence: ${result.evidenceCount} entries`,
        `Failures: ${result.failureCount} recorded`,
        `Decisions: ${result.decisionCount} recorded`,
        `Verification passed: ${result.verificationPassed}`,
        `Acceptance passed: ${result.acceptancePassed}`,
        `Summary: ${result.summary}`,
        '',
        `Task ID: ${result.taskId}`,
        result.status === 'paused'
          ? `⏸ Paused with durable state. Open Forge and choose Continue for ${result.taskId}.`
          : result.status === 'blocked'
            ? `⚠ Waiting for a human decision. Open Forge and choose Answer/Approve for ${result.taskId}.`
            : '',
      ].filter(Boolean),
    }
  } catch (err) {
    return {
      ok: false,
      exitCode: 2,
      data: { taskId, status: 'error', summary: err instanceof Error ? err.message : String(err) },
      message: `forge resume failed: ${err instanceof Error ? err.message : String(err)}`,
      textLines: [`Error: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}
