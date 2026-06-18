/**
 * `forge verify <taskId>` — list the open verification matrix.
 *
 *   - Reads from the file-based `VerificationMatrixEngine.getMatrix`.
 *   - When `--status <name>` is set, only entries with that status
 *     are returned (default: 'open', which means everything that
 *     is NOT `passed`, `not_applicable`, or `skipped`).
 *   - Returns a per-status summary alongside the filtered rows.
 *
 * Output:
 *   --json   → { ok, exitCode, data: { taskId, summary, openCount, entries: VerificationEntry[] } }
 *   --text   → `Verification Matrix:` followed by status icons + check names
 *
 * Exit codes:
 *   0  matrix found (or matrix is empty — that's a valid "no checks" state)
 *   1  task not provided
 */
import { loadConfig, initConfig } from '../config.js'
import { VerificationMatrixEngine } from '@forge/verification'
import type { VerificationEntry, VerificationStatus } from '@forge/types'
import type { CommandResult, ParsedArgs } from './output.js'
import { getOption } from './output.js'

export interface VerifyData {
  taskId: string
  summary: Record<VerificationStatus, number>
  openCount: number
  filterStatus: string
  entries: VerificationEntry[]
}

function isClosedStatus(s: VerificationStatus): boolean {
  return s === 'passed' || s === 'not_applicable' || s === 'skipped'
}

export async function runVerify(parsed: ParsedArgs): Promise<CommandResult<VerifyData>> {
  const taskId = parsed.positional[0]
  if (!taskId) {
    return {
      ok: false,
      exitCode: 1,
      message: 'forge verify requires a taskId. Usage: forge verify <taskId> [--status open|passed|failed|...]',
      textLines: ['Error: task ID required. Usage: forge verify <taskId> [--status <name>]'],
    }
  }

  const filter = (getOption(parsed, 'status') ?? 'open') as VerificationStatus | 'open'

  let config = await loadConfig()
  if (!config) config = await initConfig()
  const engine = new VerificationMatrixEngine({ stateDir: config.stateDir })

  const matrix = await engine.getMatrix(taskId)
  const allEntries = matrix?.entries ?? []
  const summary = await engine.getSummary(taskId)

  const filtered = filter === 'open'
    ? allEntries.filter((e) => !isClosedStatus(e.status))
    : allEntries.filter((e) => e.status === filter)

  const data: VerifyData = {
    taskId,
    summary,
    openCount: allEntries.filter((e) => !isClosedStatus(e.status)).length,
    filterStatus: filter,
    entries: filtered,
  }

  const icon = (s: VerificationStatus) => {
    if (s === 'passed') return '✓'
    if (s === 'failed') return '✗'
    if (s === 'needs_human_review') return '?'
    return '○'
  }

  const textLines = [
    `Verification Matrix for ${taskId} (filter: ${filter}):`,
    `  Total: ${allEntries.length}, open: ${data.openCount}`,
    '',
    ...(filtered.length === 0
      ? ['  (no entries match the filter)']
      : filtered.map((e) => `  ${icon(e.status)} ${e.check} → ${e.status}${e.notes ? `  (${e.notes.slice(0, 80)})` : ''}`)),
  ]

  return {
    ok: true,
    exitCode: 0,
    data,
    message: `${taskId}: ${data.openCount} open verification entries`,
    textLines,
  }
}
