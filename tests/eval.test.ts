import { describe, it, expect } from 'vitest'
import { formatReport, DEMO_TASK, type ComparisonReport } from '@forge/eval'
import type { AgentResult } from '@forge/agent'

function fakeResult(over: Partial<AgentResult>): AgentResult {
  return {
    taskId: 't',
    status: 'completed',
    summary: 's',
    iterations: 5,
    filesTouched: ['a.ts'],
    commandsRun: [],
    evidenceCount: 0,
    failureCount: 0,
    decisionCount: 0,
    verificationPassed: false,
    acceptancePassed: false,
    ...over,
  }
}

describe('forge-eval', () => {
  it('exposes a multi-domain demo task', () => {
    expect(DEMO_TASK).toMatch(/invitation/i)
    expect(DEMO_TASK).toMatch(/test/i)
  })

  it('formats a side-by-side comparison report', () => {
    const report: ComparisonReport = {
      task: 'demo',
      generatedAt: new Date().toISOString(),
      forge: { label: 'forge', runtimeMs: 1000, result: fakeResult({ iterations: 4, evidenceCount: 3 }) },
      flat: { label: 'flat', runtimeMs: 2000, result: fakeResult({ iterations: 9, evidenceCount: 0 }) },
    }
    const out = formatReport(report)
    expect(out).toContain('forge')
    expect(out).toContain('flat')
    expect(out).toContain('iterations')
    expect(out).toContain('evidence entries')
  })
})
