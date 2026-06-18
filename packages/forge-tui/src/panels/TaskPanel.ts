/**
 * TaskPanel — current task status, interpretation, next action.
 *
 * Read-only view of `TaskState`. No writes; no engine calls. The dashboard host
 * wires `render(width, height) -> string` into a blessed box.
 *
 * Fixture contract: any object with the fields below (subset of `TaskState` from
 * `@forge/types`). Keeps the panel testable without instantiating a full task.
 */

export interface TaskPanelFixture {
  taskId: string
  status: string
  originalRequest: string
  currentInterpretation: string
  nextAction: string
  filesTouched?: string[]
  commandsRun?: string[]
  testsRun?: string[]
  reviewBlockers?: string[]
  updatedAt?: string
}

export class TaskPanel {
  private fixture: TaskPanelFixture
  private lastKey = ''

  constructor(fixture: TaskPanelFixture) {
    this.fixture = fixture
  }

  /** Replace fixture (e.g. when dashboard refreshes). */
  setFixture(fixture: TaskPanelFixture): void {
    this.fixture = fixture
  }

  /** Render to a plain-text grid of `width` columns x `height` rows. */
  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))
    const f = this.fixture

    const statusIcon = iconForStatus(f.status)
    const lines: string[] = []
    lines.push(`${statusIcon} ${truncate(f.taskId, w - 4)}`)
    lines.push(`status: ${truncate(f.status, w - 8)}`)
    lines.push(`Next: ${truncate(f.nextAction, w - 7)}`)
    lines.push('')
    lines.push('Goal:')
    for (const chunk of wrap(f.originalRequest, w - 2)) lines.push(`  ${chunk}`)
    lines.push('')
    lines.push('Interpretation:')
    for (const chunk of wrap(f.currentInterpretation, w - 2)) lines.push(`  ${chunk}`)
    lines.push('')

    const tail: string[] = []
    tail.push(`Files: ${f.filesTouched?.length ?? 0}  Cmds: ${f.commandsRun?.length ?? 0}  Tests: ${f.testsRun?.length ?? 0}`)
    const blockers = f.reviewBlockers ?? []
    if (blockers.length > 0) {
      tail.push(`Blockers (${blockers.length}):`)
      for (const b of blockers.slice(0, 3)) tail.push(`  · ${truncate(b, w - 4)}`)
    }
    if (f.updatedAt) tail.push(`updated: ${truncate(f.updatedAt, w - 9)}`)

    const out = trimTo(lines.concat(tail), h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
  }

  getLastKey(): string {
    return this.lastKey
  }
}

function iconForStatus(status: string): string {
  switch (status) {
    case 'completed':
      return '[OK]'
    case 'failed':
      return '[!!]'
    case 'blocked':
    case 'needs_review':
      return '[??]'
    case 'implementing':
    case 'verifying':
    case 'exploring':
      return '[..]'
    default:
      return '[--]'
  }
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const out: string[] = []
  for (const para of text.split(/\n/)) {
    if (para.length <= width) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (line.length === 0) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }
  return out.length > 0 ? out : ['']
}

function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function trimTo(lines: string[], height: number): string[] {
  return lines.slice(0, height)
}

function padWidth(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => (line.length < width ? line + ' '.repeat(width - line.length) : line.slice(0, width)))
    .join('\n')
}
