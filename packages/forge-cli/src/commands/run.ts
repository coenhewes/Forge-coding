/**
 * `forge run <task>` — invoke the agent loop on a task.
 *
 *   - The task text is taken from the remaining positional args, or
 *     read from `--file <path>` when provided.
 *   - Delegates to `AgentLoop.run(task)` and returns the result.
 *   - Streams the same human-readable progress lines that the
 *     original `cmdRun` printed, then a final summary.
 *
 * Output:
 *   --json   → { ok, exitCode, data: AgentResult }
 *   --text   → human progress + final summary
 *
 * Exit codes:
 *   0  completed (AgentResult.status === 'completed')
 *   1  bad args (no task, file not found)
 *   2  agent loop errored or task blocked
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig, initConfig, isInitialized } from '../config.js'
import { AgentLoop } from '@forge/agent'
import type { AgentResult, AgentConfig } from '@forge/agent'
import type { CommandResult, ParsedArgs } from './output.js'
import { getOption } from './output.js'
import { createRunRenderer } from './run-renderer.js'
import { longHorizonBudget, runPreflight } from '../preflight.js'

export async function runRun(parsed: ParsedArgs): Promise<CommandResult<AgentResult | { taskId: string; status: string; summary: string }>> {
  const filePath = getOption(parsed, 'file')
  let task: string
  try {
    if (filePath) {
      task = await readFile(resolve(filePath), 'utf-8')
    } else {
      task = parsed.positional.join(' ').trim()
    }
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      message: `forge run: cannot read --file: ${err instanceof Error ? err.message : String(err)}`,
      textLines: [`Error: cannot read --file: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  if (!task) {
    return {
      ok: false,
      exitCode: 1,
      message: 'forge run: no task provided. Use: forge run <task> or forge run --file <path>',
      textLines: ['Error: no task provided. Use: forge run <task> or forge run --file <path>'],
    }
  }

  let config = await loadConfig()
  if (!config) {
    config = await initConfig()
  }
  if (!isInitialized(config.stateDir)) {
    config = await initConfig()
  }

  const preflight = await runPreflight({ command: 'run', config, parsed, requireLocalApproval: true })
  if (preflight.fatal) {
    return {
      ok: false,
      exitCode: 1,
      data: { taskId: 'unknown', status: 'preflight_failed', summary: preflight.errors.join(' ') },
      message: 'forge run: preflight failed',
      textLines: preflight.textLines,
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
    stateStore: preflight.stateStore,
    stateStoreMode: preflight.stateMode,
    // Activate the non-authoritative local-model layer (compaction/triage)
    // when configured. Falls back to deterministic behavior if unavailable.
    localModel: config.localModel,
    // Live event stream to stderr (kept off stdout so --json stays clean).
    onEvent: createRunRenderer(!parsed.json),
  }

  const logLines: string[] = [
    `\nForge — Running task\n`,
    `Provider: ${config.provider.name} (${config.provider.model})`,
    `Mode: ${config.mode}`,
    `Work dir: ${config.workDir}`,
    `State dir: ${config.stateDir}`,
    '',
    ...preflight.textLines,
    '',
    '[1/5] Scanning repository...',
    '[2/5] Routing task to domains...',
    '[3/5] Creating acceptance contract...',
    '[4/5] Selecting affected tests...',
    '[5/5] Entering agent loop...',
    '',
  ]

  let result: AgentResult
  try {
    const agent = new AgentLoop(agentConfig)
    await agent.buildRepoIntelligence()
    result = await agent.run(task)
  } catch (err) {
    return {
      ok: false,
      exitCode: 2,
      data: { taskId: 'unknown', status: 'error', summary: err instanceof Error ? err.message : String(err) },
      message: `forge run: agent loop threw: ${err instanceof Error ? err.message : String(err)}`,
      textLines: [`Error: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  const summaryLines = [
    '─── Result ───',
    `Status: ${result.status}`,
    `Iterations: ${result.iterations}`,
    `Files touched: ${result.filesTouched.length}`,
    `Commands run: ${result.commandsRun.length}`,
    `Evidence: ${result.evidenceCount} entries`,
    `Failures: ${result.failureCount} recorded`,
    `Decisions: ${result.decisionCount} recorded`,
    `Verification passed: ${result.verificationPassed}`,
    `Acceptance passed: ${result.acceptancePassed}`,
    ...(result.riskLevel ? [`Risk level: ${result.riskLevel}`] : []),
    ...(result.mainModelUsage
      ? [`Main-model tokens: ${result.mainModelUsage.inputTokens} in / ${result.mainModelUsage.outputTokens} out over ${result.mainModelUsage.calls} calls (local-model work excluded)`]
      : []),
    `Summary: ${result.summary}`,
    ...(result.promotedCheckpointId ? [`Promoted checkpoint: ${result.promotedCheckpointId}`] : []),
    ...(result.branch ? [`Branch: ${result.branch}`] : []),
    ...(result.commitSha ? [`Commit: ${result.commitSha}`] : []),
    ...(result.prUrl ? [`PR: ${result.prUrl}`] : result.prPath ? [`PR body: ${result.prPath}`] : []),
    '',
    `Task ID: ${result.taskId}`,
  ]

  if (result.status === 'blocked') {
    summaryLines.push('', `⚠ Task is blocked waiting for a human decision. Open Forge with no args and select Continue/Answer for ${result.taskId}.`)
  }
  if (result.status === 'paused') {
    summaryLines.push('', `⏸ Budget reached — task paused with durable state. Open Forge and choose Continue for ${result.taskId}.`)
  }

  return {
    ok: result.status === 'completed' || result.status === 'success',
    exitCode: result.status === 'completed' || result.status === 'success' ? 0 : 2,
    data: result,
    message: `Task ${result.taskId} → ${result.status}`,
    textLines: [...logLines, ...summaryLines],
  }
}
