import type { Subtask, SubtaskStatus } from '@forge/types'

export interface SubtaskTemplate {
  label: string
  description: string
  domains: string[]
}

const DEFAULT_SUBTASK_TEMPLATES: Record<string, SubtaskTemplate[]> = {
  auth: [
    { label: 'Understand auth flow', description: 'Map the authentication and authorization code paths', domains: ['auth', 'backend'] },
    { label: 'Implement auth changes', description: 'Make the required authentication/authorization changes', domains: ['auth', 'backend'] },
    { label: 'Add auth tests', description: 'Write tests for the auth changes', domains: ['auth', 'tests'] },
    { label: 'Verify auth behavior', description: 'Run auth regression tests and verify correctness', domains: ['auth', 'tests'] },
  ],
  backend: [
    { label: 'Understand backend architecture', description: 'Map the backend code structure and APIs', domains: ['backend'] },
    { label: 'Implement backend changes', description: 'Make the required backend code changes', domains: ['backend'] },
    { label: 'Add backend tests', description: 'Write tests for backend changes', domains: ['backend', 'tests'] },
    { label: 'Verify API behavior', description: 'Test API endpoints and integration', domains: ['backend', 'tests'] },
  ],
  database: [
    { label: 'Understand schema', description: 'Map the current database schema and migrations', domains: ['database'] },
    { label: 'Create migration', description: 'Write the database migration', domains: ['database'] },
    { label: 'Apply migration', description: 'Run migration and verify it works up and down', domains: ['database'] },
    { label: 'Verify data integrity', description: 'Verify migration preserves data integrity', domains: ['database'] },
  ],
  frontend: [
    { label: 'Understand UI structure', description: 'Map the frontend component tree and routes', domains: ['frontend'] },
    { label: 'Implement UI changes', description: 'Make the required frontend changes', domains: ['frontend'] },
    { label: 'Add frontend tests', description: 'Write frontend tests for the changes', domains: ['frontend', 'tests'] },
    { label: 'Verify visual behavior', description: 'Visually verify the UI renders correctly', domains: ['frontend'] },
  ],
}

export function decomposeTask(
  taskId: string,
  taskDescription: string,
  domains?: string[],
): Subtask[] {
  const subtasks: Subtask[] = []
  const lower = taskDescription.toLowerCase()
  const domainsToUse = domains ?? inferDomains(lower)

  for (const domain of domainsToUse) {
    const templates = DEFAULT_SUBTASK_TEMPLATES[domain]
    if (!templates) continue

    for (const template of templates) {
      subtasks.push({
        id: `${taskId}-${domain}-${subtasks.length + 1}`,
        label: template.label,
        status: 'pending',
        description: template.description,
        dependsOn: [],
      })
    }
  }

  // Add final verification subtask
  if (subtasks.length > 0) {
    subtasks.push({
      id: `${taskId}-verify-${subtasks.length + 1}`,
      label: 'Final verification',
      status: 'pending',
      description: 'Run the full verification matrix and confirm acceptance criteria',
      dependsOn: subtasks.map((s) => s.id),
    })
  }

  return subtasks
}

export function updateSubtaskDependsOn(subtasks: Subtask[]): Subtask[] {
  for (let i = 0; i < subtasks.length; i++) {
    const currentDomain = subtasks[i]?.id.split('-')[1]
    for (let j = 0; j < i; j++) {
      const prevDomain = subtasks[j]?.id.split('-')[1]
      if (prevDomain !== currentDomain) {
        const current = subtasks[i]
        if (current && !current.dependsOn.includes(subtasks[j]!.id)) {
          current.dependsOn.push(subtasks[j]!.id)
        }
      }
    }
  }
  return subtasks
}

function inferDomains(taskLower: string): string[] {
  const domains: string[] = []
  if (/\b(auth|login|permission|role|invite|session)\b/i.test(taskLower)) domains.push('auth')
  if (/\b(api|endpoint|route|backend)\b/i.test(taskLower)) domains.push('backend')
  if (/\b(db|database|migration|schema|table|prisma)\b/i.test(taskLower)) domains.push('database')
  if (/\b(ui|component|page|form|button|frontend)\b/i.test(taskLower)) domains.push('frontend')
  if (domains.length === 0) domains.push('backend')
  return domains
}
