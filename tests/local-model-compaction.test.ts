/**
 * CompactionPolicy tests — the core "reduce context without losing evidence"
 * guarantee. We assert that oversized tool outputs are replaced by
 * `summary + ref`, that small messages are untouched, and — critically — that
 * the byte-exact original is recoverable through the stored artifact (stable
 * ref), even in fallback mode with no model available.
 */
import { describe, it, expect } from 'vitest'
import type { LocalModelRun, Message, ModelProvider } from '@forge/types'
import { LocalModelService, LocalModelRouter, CompactionPolicy } from '@forge/local-model'

class ArtifactStore {
  private map = new Map<string, string>()
  private seq = 0
  async store(input: { content: string }) {
    const id = `art-${this.seq++}`
    this.map.set(id, input.content)
    return { id }
  }
  get(id: string) {
    return this.map.get(id)
  }
}

function service(enabled: 'on' | 'off', store: ArtifactStore, provider?: ModelProvider) {
  const router = new LocalModelRouter(
    { enabled },
    {
      createProvider: () =>
        provider ?? {
          async *complete() {
            return
          },
          async completeSync() {
            return { content: '{"summary":"compacted ok"}', finishReason: 'stop' as const }
          },
        },
      createEmbeddingProvider: () => null,
      probe: async () => true,
    },
  )
  const runs: LocalModelRun[] = []
  return new LocalModelService({ enabled }, router, {
    artifacts: store,
    runs: { record: async (r) => void runs.push(r) },
  })
}

describe('CompactionPolicy', () => {
  it('leaves small tool outputs and non-tool messages untouched', async () => {
    const store = new ArtifactStore()
    const policy = new CompactionPolicy(service('on', store), { thresholdChars: 1000 })
    const messages: Message[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'tool', content: 'small output', toolCallId: 'c1' },
    ]
    const result = await policy.compactToolOutputs('t1', messages)
    expect(result.compacted).toBe(0)
    expect(result.messages).toEqual(messages)
  })

  it('replaces oversized tool output with summary + recoverable ref', async () => {
    const store = new ArtifactStore()
    const policy = new CompactionPolicy(service('on', store), { thresholdChars: 100 })
    const huge = 'BEGIN-MARKER ' + 'x'.repeat(5000) + ' END-MARKER'
    const messages: Message[] = [{ role: 'tool', content: huge, toolCallId: 'c1' }]

    const result = await policy.compactToolOutputs('t1', messages)
    expect(result.compacted).toBe(1)
    expect(result.refs).toHaveLength(1)

    const rewritten = result.messages[0]!.content
    expect(rewritten.length).toBeLessThan(huge.length)
    expect(rewritten).toContain('compacted ok')
    expect(rewritten).toContain(result.refs[0]!)

    // The exact original is recoverable via the stable ref.
    expect(store.get(result.refs[0]!)).toBe(huge)
  })

  it('still compacts and retains the exact original when the model is unavailable', async () => {
    const store = new ArtifactStore()
    const policy = new CompactionPolicy(service('off', store), { thresholdChars: 100 })
    const huge = 'EXACT-ORIGINAL ' + 'y'.repeat(5000)
    const result = await policy.compactToolOutputs('t1', [{ role: 'tool', content: huge, toolCallId: 'c1' }])

    expect(result.compacted).toBe(1)
    // Fallback summary is deterministic truncation, but nothing is lost:
    expect(store.get(result.refs[0]!)).toBe(huge)
  })
})
