/**
 * `forge sessions` — list all tasks in the state store.
 *
 *   - Reads from the file-based `TaskStateEngine.listTasks()` and
 *     hydrates each task id to fetch its summary.
 *   - The Postgres `tasks` table (typed repos) is a separate concept
 *     keyed by `repoId`; we don't merge it here because the agent
 *     loop writes to it under its own keying scheme. This command
 *     reflects the user-facing task ledger.
 *
 * Output:
 *   --json   → { ok, exitCode, data: { count, tasks: SessionRow[] } }
 *   --text   → `Tasks (N):` followed by one row per task
 *
 * Exit codes:
 *   0  always (empty list returns 0, not 1)
 */
import { loadConfig, initConfig } from '../config.js'
import { TaskStateEngine } from '@forge/state'
import type { CommandResult, ParsedArgs } from './output.js'

export interface SessionRow {
  taskId: string
  status: string
  currentInterpretation: string
  subtaskProgress: string
  updatedAt?: string
  filesTouched: number
  failuresEncountered: number
}

export async function runSessions(_parsed: ParsedArgs): Promise<CommandResult<{ count: number; tasks: SessionRow[] }>> {
  void _parsed
  let config = await loadConfig()
  if (!config) config = await initConfig()

  const engine = new TaskStateEngine({ stateDir: config.stateDir })
  const fileIds = await engine.listTasks()
  const tasks: SessionRow[] = []
  for (const id of fileIds) {
    const t = await engine.getTask(id)
    if (!t) continue
    const completed = t.subtasks.filter((s) => s.status === 'completed').length
    tasks.push({
      taskId: t.taskId,
      status: t.status,
      currentInterpretation: t.currentInterpretation,
      subtaskProgress: t.subtasks.length > 0 ? `${completed}/${t.subtasks.length}` : '',
      updatedAt: t.updatedAt,
      filesTouched: t.filesTouched.length,
      failuresEncountered: t.failuresEncountered.length,
    })
  }
  tasks.sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''))

  const textLines = tasks.length === 0
    ? ['No tasks found.']
    : [
        `Tasks (${tasks.length}):`,
        ...tasks.map((t) => {
          const icon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'blocked' ? '⚠' : '○'
          const sub = t.subtaskProgress ? ` [${t.subtaskProgress}]` : ''
          return `  ${icon} ${t.taskId} — ${t.status}${sub} — ${t.currentInterpretation.slice(0, 80)}`
        }),
      ]

  return {
    ok: true,
    exitCode: 0,
    data: { count: tasks.length, tasks },
    message: tasks.length === 0 ? 'No tasks found.' : `${tasks.length} task(s) in state store`,
    textLines,
  }
}
