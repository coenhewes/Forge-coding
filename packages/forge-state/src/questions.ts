import type { OpenQuestion } from '@forge/types'

export class QuestionTracker {
  private questions = new Map<string, OpenQuestion[]>()

  add(taskId: string, question: OpenQuestion): void {
    const existing = this.questions.get(taskId) ?? []
    existing.push(question)
    this.questions.set(taskId, existing)
  }

  getUnresolved(taskId: string): OpenQuestion[] {
    return (this.questions.get(taskId) ?? []).filter((q) => !q.resolved)
  }

  getAll(taskId: string): OpenQuestion[] {
    return this.questions.get(taskId) ?? []
  }

  resolve(taskId: string, questionText: string, answer: string): boolean {
    const existing = this.questions.get(taskId)
    if (!existing) return false

    const found = existing.find((q) => q.question === questionText)
    if (!found) return false

    found.resolved = true
    found.answer = answer
    return true
  }

  clear(taskId: string): void {
    this.questions.delete(taskId)
  }
}

export function createQuestion(
  question: string,
  options?: { label: string; description: string }[],
): OpenQuestion {
  return {
    question,
    options,
    resolved: false,
    timestamp: new Date().toISOString(),
  }
}

// Common question templates for engineering decisions
export const QUESTION_TEMPLATES = {
  architecture: (): OpenQuestion => createQuestion(
    'What architectural approach should be used?',
    [
      { label: 'Extend existing pattern', description: 'Follow the established patterns in the codebase' },
      { label: 'Refactor first', description: 'Clean up the area before making changes' },
      { label: 'New abstraction', description: 'Introduce a new abstraction layer' },
    ],
  ),
  securitySensitive: (): OpenQuestion => createQuestion(
    'Does this change require a security review?',
    [
      { label: 'Yes — flag for review', description: 'This touches auth/permissions/billing and needs human review' },
      { label: 'No — standard change', description: 'This is a routine change with no security implications' },
    ],
  ),
  migrationRisk: (): OpenQuestion => createQuestion(
    'How should the migration risk be handled?',
    [
      { label: 'Rolling migration', description: 'Backward-compatible changes only, deploy first, migrate later' },
      { label: 'Explicit migration step', description: 'Separate migration with up/down scripts' },
      { label: 'No migration needed', description: 'Schema changes are backward compatible' },
    ],
  ),
}
