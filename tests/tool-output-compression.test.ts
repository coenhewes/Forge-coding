import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compactToolResult } from '@forge/agent'

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-compress-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('tool-output compression', () => {
  it('compresses JSON arrays while preserving notable rows and retrieval refs', async () => {
    await withTmp(async (dir) => {
      const rows = Array.from({ length: 40 }, (_, i) => ({
        id: i,
        status: i === 23 ? 'failed' : 'ok',
        message: i === 23 ? 'critical error in payment flow' : `ordinary row ${i}`,
      }))
      const result = await compactToolResult(JSON.stringify(rows, null, 2), {
        taskId: 'task-json',
        artifactsDir: dir,
        budget: 700,
        toolName: 'search_api',
      })

      expect(result.truncated).toBe(true)
      expect(result.strategy).toBe('json_array')
      expect(result.content).toContain('critical error in payment flow')
      expect(result.content).toContain('retrieve_artifact')
      expect(result.artifactRef).toMatch(/^[a-f0-9]{64}$/)
      expect(result.savings.estimatedTokensSaved).toBeGreaterThan(0)
    })
  })

  it('groups search results by file and keeps exact retrieval available', async () => {
    await withTmp(async (dir) => {
      const output = Array.from({ length: 80 }, (_, i) => `src/file${i % 4}.ts:${i + 1}:const value${i} = ${i}`).join('\n')
      const result = await compactToolResult(output, {
        taskId: 'task-search',
        artifactsDir: dir,
        budget: 900,
        toolName: 'search_code',
      })

      expect(result.strategy).toBe('search_results')
      expect(result.content).toContain('src/file0.ts')
      expect(result.content).toContain('match(es) omitted')
      expect(result.content).toContain('retrieve_artifact')
    })
  })

  it('preserves important log lines during log compression', async () => {
    await withTmp(async (dir) => {
      const lines = Array.from({ length: 180 }, (_, i) => `info line ${i}`)
      lines[91] = 'ERROR expected true received false'
      lines[92] = '    at src/example.test.ts:12:3'
      const result = await compactToolResult(lines.join('\n'), {
        taskId: 'task-log',
        artifactsDir: dir,
        budget: 1000,
        toolName: 'run_verification',
      })

      expect(result.strategy).toBe('log')
      expect(result.content).toContain('ERROR expected true received false')
      expect(result.content).toContain('src/example.test.ts')
    })
  })
})
