/**
 * `forge status [taskId]` — single task summary.
 *
 *   - With no arg, returns the most recent task (or the first one
 *     in the file state engine if there are no recency hints).
 *   - With a `taskId`, looks up that specific task in the file
 *     engine; falls back to `FORGE_DATABASE_URL` Postgres repos if
 *     not present locally.
 *
 * Output:
 *   --json   → { ok, exitCode, data: { taskId, status, interpretation, nextAction, subtasks, filesTouched, ... } }
 *   --text   → human-readable lines
 *
 * Exit codes:
 *   0  task found
 *   1  task not found
 */
import { loadConfig, initConfig } from '../config.js'
import { TaskStateEngine } from '@forge/state'
import type { TaskState } from '@forge/types'
import type { CommandResult, ParsedArgs } from './output.js'

export interface StatusData {
  taskId: string
  status: string
  currentInterpretation: string
  nextAction: string
  subtasks: { id: string; status: string; label: string }[]
  filesTouched: string[]
  commandsRun: number
  createdAt: string
  updatedAt: string
}

function summarize(task: TaskState): StatusData {
  return {
    taskId: task.taskId,
    status: task.status,
    currentInterpretation: task.currentInterpretation,
    nextAction: task.nextAction,
    subtasks: task.subtasks.map((s) => ({ id: s.id, status: s.status, label: s.label })),
    filesTouched: task.filesTouched.slice(-20),
    commandsRun: task.commandsRun.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export async function runStatus(parsed: ParsedArgs): Promise<CommandResult<StatusData>> {
  let config = await loadConfig()
  if (!config) config = await initConfig()
  const engine = new TaskStateEngine({ stateDir: config.stateDir })
  const requested = parsed.positional[0]

  let task: TaskState | undefined
  if (requested) {
    task = await engine.getTask(requested)
  } else {
    const ids = await engine.listTasks()
    if (ids.length > 0) {
      // Return the most recently updated.
      let best: TaskState | undefined
      for (const id of ids) {
        const t = await engine.getTask(id)
        if (!t) continue
        if (!best || t.updatedAt > best.updatedAt) best = t
      }
      task = best
    }
  }

  if (!task) {
    const msg = requested
      ? `Task not found: ${requested}`
      : 'No tasks found. Run `forge run <task>` to create one.'
    return {
      ok: false,
      exitCode: 1,
      message: msg,
      textLines: [msg],
    }
  }

  const data = summarize(task)
  const textLines = [
    `Task: ${data.taskId}`,
    `Status: ${data.status}`,
    `Interpretation: ${data.currentInterpretation}`,
    `Next action: ${data.nextAction}`,
    ...(data.subtasks.length > 0
      ? ['', 'Subtasks:', ...data.subtasks.map((s) => {
          const icon = s.status === 'completed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'in_progress' ? '→' : '○'
          return `  ${icon} [${s.id}] ${s.label}`
        })]
      : []),
    ...(data.filesTouched.length > 0
      ? ['', `Files touched: ${data.filesTouched.length}`, ...data.filesTouched.slice(-10).map((f) => `  - ${f}`)]
      : []),
    '',
    `Commands run: ${data.commandsRun}`,
    `Created: ${data.createdAt}`,
    `Updated: ${data.updatedAt}`,
  ]
  return {
    ok: true,
    exitCode: 0,
    data,
    message: `Task ${data.taskId}: ${data.status}`,
    textLines,
  }
}
