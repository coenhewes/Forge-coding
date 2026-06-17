import type { TaskState, AcceptanceContract, VerificationEntry } from '@forge/types'

export function formatTaskStatus(task: TaskState): string {
  const lines: string[] = []
  lines.push(`Task: ${task.taskId}`)
  lines.push(`Status: ${task.status}`)
  lines.push(`Interpretation: ${task.currentInterpretation}`)
  lines.push(`Next action: ${task.nextAction}`)

  if (task.subtasks.length > 0) {
    lines.push('')
    lines.push('Subtasks:')
    for (const sub of task.subtasks) {
      const icon = sub.status === 'completed' ? '✓' : sub.status === 'failed' ? '✗' : sub.status === 'in_progress' ? '→' : '○'
      lines.push(`  ${icon} [${sub.id}] ${sub.label}`)
    }
  }

  if (task.filesTouched.length > 0) {
    lines.push('')
    lines.push(`Files touched: ${task.filesTouched.length}`)
    for (const f of task.filesTouched.slice(-10)) {
      lines.push(`  - ${f}`)
    }
  }

  if (task.commandsRun.length > 0) {
    lines.push('')
    lines.push(`Commands run: ${task.commandsRun.length}`)
  }

  lines.push('')
  lines.push(`Created: ${task.createdAt}`)
  lines.push(`Updated: ${task.updatedAt}`)

  return lines.join('\n')
}

export function formatContract(contract: AcceptanceContract): string {
  const lines: string[] = []
  lines.push('Acceptance Contract:')
  lines.push(`  ${contract.description}`)
  lines.push('')
  lines.push('Criteria:')
  for (const c of contract.criteria) {
    const icon = c.status === 'verified' ? '✓' : c.status === 'failed' ? '✗' : c.status === 'needs_review' ? '?' : '○'
    lines.push(`  ${icon} [${c.id}] ${c.description}`)
  }
  return lines.join('\n')
}

export function formatVerification(entries: VerificationEntry[]): string {
  const lines: string[] = []
  lines.push('Verification Matrix:')
  for (const e of entries) {
    const icon = e.status === 'passed' ? '✓' : e.status === 'failed' ? '✗' : e.status === 'needs_human_review' ? '?' : '○'
    lines.push(`  ${icon} ${e.check} → ${e.status}`)
    if (e.notes) lines.push(`       ${e.notes.slice(0, 100)}`)
  }
  return lines.join('\n')
}
