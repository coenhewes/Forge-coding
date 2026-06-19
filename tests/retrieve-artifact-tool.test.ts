import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolExecutor, compactToolResult } from '@forge/agent'
import { EvidenceMemory } from '@forge/state'
import type { ToolExecutionContext } from '@forge/agent'

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-retrieve-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function context(stateDir: string, evidenceMemory?: EvidenceMemory): ToolExecutionContext {
  return {
    workDir: stateDir,
    stateDir,
    taskId: 'task-retrieve',
    evidenceMemory,
    taskEngine: { addFileTouched: async () => undefined },
  } as ToolExecutionContext
}

describe('retrieve_artifact tool', () => {
  it('write_file creates parent directories for blank-directory projects', async () => {
    await withTmp(async (stateDir) => {
      const result = await new ToolExecutor().execute(
        { id: 'tc1', name: 'write_file', input: { path: 'src/tools.ts', content: 'export const ok = true\n' } },
        context(stateDir),
      )

      expect(result.content).toContain('Wrote src/tools.ts')
      await expect(readFile(join(stateDir, 'src/tools.ts'), 'utf-8')).resolves.toContain('ok')
    })
  })

  it('retrieves query-filtered raw tool-output blobs by compression hash', async () => {
    await withTmp(async (stateDir) => {
      const original = [
        'line one',
        'boring middle',
        'needle appears here',
        'more boring middle',
        'final line',
      ].join('\n') + '\n' + 'x'.repeat(5000)
      const compacted = await compactToolResult(original, {
        taskId: 'task-retrieve',
        artifactsDir: join(stateDir, '.forge', 'artifacts'),
        budget: 200,
      })

      const result = await new ToolExecutor().execute(
        { id: 'tc1', name: 'retrieve_artifact', input: { artifact_ref: compacted.artifactRef!, query: 'needle', max_bytes: 2000 } },
        context(stateDir),
      )

      expect(result.content).toContain('needle appears here')
      expect(result.content).toContain('source=tool_output_blob')
      expect(result.metadata?.type).toBe('artifact_retrieval')
    })
  })

  it('retrieves exact evidence-memory artifacts by stable id', async () => {
    await withTmp(async (stateDir) => {
      const memory = new EvidenceMemory({ stateDir })
      const artifact = await memory.store({
        taskId: 'task-retrieve',
        kind: 'local_model_input',
        description: 'exact input',
        content: 'alpha\nbeta target\ngamma',
        contentType: 'text',
      })

      const result = await new ToolExecutor().execute(
        { id: 'tc1', name: 'retrieve_artifact', input: { artifact_ref: artifact.id, query: 'target' } },
        context(stateDir, memory),
      )

      expect(result.content).toContain('beta target')
      expect(result.content).toContain('source=evidence_memory')
    })
  })
})
