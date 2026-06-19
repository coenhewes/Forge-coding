import { describe, expect, it } from 'vitest'
import type { ModelProvider } from '@forge/types'
import { LocalContextIndex, LocalModelRouter, LocalModelService } from '@forge/local-model'

function serviceWithEmbeddings(vectors: number[][]) {
  const provider: ModelProvider = {
    async *complete() {
      return
    },
    async completeSync() {
      return { content: '', finishReason: 'stop' as const }
    },
  }
  const router = new LocalModelRouter(
    { enabled: 'on' },
    {
      createProvider: () => provider,
      createEmbeddingProvider: () => ({
        async embed() {
          return { vectors }
        },
      }),
      probe: async () => true,
    },
  )
  return new LocalModelService({ enabled: 'on' }, router)
}

describe('LocalContextIndex', () => {
  it('uses lexical ranking when embeddings are unavailable', async () => {
    const service = new LocalModelService(
      { enabled: 'off' },
      new LocalModelRouter({ enabled: 'off' }, {
        createProvider: () => {
          throw new Error('unused')
        },
        createEmbeddingProvider: () => null,
        probe: async () => false,
      }),
    )
    const index = new LocalContextIndex(service)
    const result = await index.retrieve({
      query: 'auth middleware',
      candidates: [
        { targetType: 'file', targetRef: 'src/billing.ts', content: 'invoice payment' },
        { targetType: 'file', targetRef: 'src/auth.ts', content: 'auth middleware validates sessions' },
      ],
    })

    expect(result.authoritative).toBe(false)
    expect(result.provenance.fallbackUsed).toBe(true)
    expect(result.results[0]?.targetRef).toBe('src/auth.ts')
  })

  it('combines local embeddings with lexical scores when available', async () => {
    const service = serviceWithEmbeddings([
      [1, 0],
      [0, 1],
      [1, 0],
    ])
    const index = new LocalContextIndex(service)
    const result = await index.retrieve({
      query: 'payments',
      candidates: [
        { targetType: 'file', targetRef: 'src/auth.ts', content: 'login sessions' },
        { targetType: 'file', targetRef: 'src/payments.ts', content: 'charge card payments' },
      ],
    })

    expect(result.provenance.fallbackUsed).toBe(false)
    expect(result.results[0]?.targetRef).toBe('src/payments.ts')
    expect(result.results[0]?.semanticScore).toBeGreaterThan(0.9)
  })
})
