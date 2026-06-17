import { describe, it, expect, afterEach } from 'vitest'
import { routeTask } from '@forge/harness'
import { PRGenerator, renderPRSummaryMarkdown } from '@forge/pr'
import { TaskStateEngine } from '@forge/state'
import { tmpStateDir, cleanup } from './helpers.js'

const dirs: string[] = []
async function stateDir(): Promise<string> {
  const d = await tmpStateDir()
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('routeTask', () => {
  it('returns a domain selection with selected + withheld domains', () => {
    const selection = routeTask('Add login and permission checks to the auth flow')
    expect(Array.isArray(selection.selectedDomains)).toBe(true)
    expect(selection.selectedDomains.length).toBeGreaterThan(0)
    // Selected and withheld should be disjoint.
    for (const d of selection.selectedDomains) {
      expect(selection.withheldDomains).not.toContain(d)
    }
  })

  it('selects the auth domain for an auth-related task', () => {
    const selection = routeTask('Fix the permission check so admins can invite users')
    expect(selection.selectedDomains).toContain('auth')
  })
})

describe('PRGenerator + renderPRSummaryMarkdown', () => {
  it('produces a reviewable PR body from task state', async () => {
    const engine = new TaskStateEngine({ stateDir: await stateDir() })
    await engine.createTask('t', 'Add multiply to math utils')
    await engine.setInterpretation('t', 'Add a multiply() helper to the math module')
    await engine.addFileTouched('t', 'src/math.ts')
    const taskState = await engine.getTask('t')
    expect(taskState).toBeDefined()

    const generator = new PRGenerator()
    const summary = await generator.generate(taskState!, undefined, [], [], [], [], [], [])
    expect(summary.title.length).toBeGreaterThan(0)
    expect(summary.filesChanged.map((f) => f.path)).toContain('src/math.ts')

    const md = renderPRSummaryMarkdown(summary)
    expect(md).toContain('# ')
    expect(md).toContain('## Review guidance')
    expect(md).toContain('## Test plan')
  })
})
