/**
 * LocalModelService tests — hermetic (no network, no DB).
 *
 * A fake instruct provider returns canned JSON; we assert each task kind
 * parses correctly, that every result is non-authoritative, that provenance +
 * sinks are populated, and that EVERY path degrades to a deterministic fallback
 * when the model is unavailable or returns garbage.
 */
import { describe, it, expect } from 'vitest'
import type {
  EmbeddingProvider,
  LocalModelConfig,
  LocalModelRun,
  ModelProvider,
  ProviderConfig,
} from '@forge/types'
import { LocalModelService, LocalModelRouter } from '@forge/local-model'
import type { ArtifactSink, RunSink, TraceSink } from '@forge/local-model'

function fakeProvider(content: string): ModelProvider {
  return {
    // eslint-disable-next-line require-yield
    async *complete() {
      return
    },
    async completeSync() {
      return { content, finishReason: 'stop' as const }
    },
  }
}

function fakeEmbedProvider(dim: number): EmbeddingProvider {
  return {
    async embed({ texts }) {
      return { vectors: texts.map((_, i) => Array.from({ length: dim }, () => i + 1)) }
    },
  }
}

class MemorySinks implements ArtifactSink, RunSink, TraceSink {
  artifacts: Array<{ id: string; kind: string; content: string }> = []
  runs: LocalModelRun[] = []
  traces: Array<{ taskId: string; payload: Record<string, unknown> }> = []
  private seq = 0

  async store(input: { kind: string; content: string }) {
    const id = `art-${this.seq++}`
    this.artifacts.push({ id, kind: input.kind, content: input.content })
    return { id }
  }
  async record(run: LocalModelRun) {
    this.runs.push(run)
  }
  // TraceSink.record — distinct arity from RunSink.record above.
  async recordTrace(taskId: string, _description: string, payload: Record<string, unknown>) {
    this.traces.push({ taskId, payload })
  }
}

function makeService(opts: {
  enabled: LocalModelConfig['enabled']
  provider?: ModelProvider
  embed?: EmbeddingProvider | null
  sinks?: MemorySinks
}) {
  const sinks = opts.sinks ?? new MemorySinks()
  const config: LocalModelConfig = { enabled: opts.enabled, timeoutMs: 1_000 }
  const router = new LocalModelRouter(config, {
    createProvider: (_c: ProviderConfig) => opts.provider ?? fakeProvider('{}'),
    createEmbeddingProvider: () => opts.embed ?? null,
    probe: async () => false,
  })
  const service = new LocalModelService(config, router, {
    artifacts: sinks,
    runs: sinks,
    trace: { record: (t, d, p) => sinks.recordTrace(t, d, p) },
  })
  return { service, sinks }
}

describe('LocalModelService — happy paths', () => {
  it('summarize parses JSON and persists input/output + provenance', async () => {
    const { service, sinks } = makeService({
      enabled: 'on',
      provider: fakeProvider('{"summary": "tests failed at auth.ts:42"}'),
    })
    const res = await service.summarize({ taskId: 't1', content: 'x'.repeat(5000), label: 'pnpm test' })

    expect(res.authoritative).toBe(false)
    expect(res.summary).toBe('tests failed at auth.ts:42')
    expect(res.provenance.fallbackUsed).toBe(false)
    expect(res.sourceArtifactId).toBeDefined()
    expect(res.provenance.outputArtifactId).toBeDefined()
    // exact input retained as an artifact (stable ref)
    const input = sinks.artifacts.find((a) => a.id === res.sourceArtifactId)
    expect(input?.kind).toBe('local_model_input')
    expect(input?.content.length).toBeGreaterThan(0)
    expect(sinks.runs).toHaveLength(1)
    expect(sinks.traces).toHaveLength(1)
  })

  it('classify snaps to an allowed label with confidence', async () => {
    const { service } = makeService({
      enabled: 'on',
      provider: fakeProvider('{"label": "flaky", "confidence": 0.8}'),
    })
    const res = await service.classify({
      taskId: 't1',
      content: 'timeout in network test',
      labels: ['flaky', 'real_failure'],
      subject: 'test failure',
    })
    expect(res.authoritative).toBe(false)
    expect(res.label).toBe('flaky')
    expect(res.confidence).toBeCloseTo(0.8)
  })

  it('classify rejects out-of-set labels (confidence forced to 0)', async () => {
    const { service } = makeService({
      enabled: 'on',
      provider: fakeProvider('{"label": "made_up", "confidence": 0.99}'),
    })
    const res = await service.classify({ taskId: 't1', content: 'x', labels: ['a', 'b'] })
    expect(res.label).toBe('unknown')
    expect(res.confidence).toBe(0)
  })

  it('extract keeps only requested fields', async () => {
    const { service } = makeService({
      enabled: 'on',
      provider: fakeProvider('{"fields": {"file": "auth.ts", "line": "42", "junk": "no"}}'),
    })
    const res = await service.extract({ taskId: 't1', content: 'x', fields: ['file', 'line'] })
    expect(res.fields.map((f) => f.key).sort()).toEqual(['file', 'line'])
  })

  it('rerank returns a complete permutation', async () => {
    const { service } = makeService({
      enabled: 'on',
      provider: fakeProvider('{"order": [2, 0]}'),
    })
    const res = await service.rerank({ taskId: 't1', query: 'q', candidates: ['a', 'b', 'c'] })
    expect([...res.order].sort()).toEqual([0, 1, 2])
    expect(res.order[0]).toBe(2)
    expect(res.scores).toHaveLength(3)
  })

  it('embed delegates to the embedding provider', async () => {
    const { service } = makeService({ enabled: 'on', embed: fakeEmbedProvider(4) })
    const res = await service.embed({ taskId: 't1', texts: ['a', 'b'] })
    expect(res.authoritative).toBe(false)
    expect(res.vectors).toHaveLength(2)
    expect(res.dim).toBe(4)
    expect(res.provenance.fallbackUsed).toBe(false)
  })
})

describe('LocalModelService — deterministic fallbacks (discipline)', () => {
  it('summarize falls back to truncation when disabled', async () => {
    const { service } = makeService({ enabled: 'off' })
    const content = 'HEAD' + 'x'.repeat(5000) + 'TAIL'
    const res = await service.summarize({ taskId: 't1', content })
    expect(res.provenance.fallbackUsed).toBe(true)
    expect(res.provenance.provider).toBe('fallback')
    expect(res.summary).toContain('omitted')
    expect(res.authoritative).toBe(false)
  })

  it('falls back when the model returns unparseable text', async () => {
    const { service } = makeService({ enabled: 'on', provider: fakeProvider('not json at all') })
    const res = await service.classify({ taskId: 't1', content: 'x', labels: ['a'] })
    expect(res.provenance.fallbackUsed).toBe(true)
    expect(res.label).toBe('unknown')
  })

  it('embed falls back to empty when no embedding provider exists', async () => {
    const { service } = makeService({ enabled: 'on', embed: null })
    const res = await service.embed({ taskId: 't1', texts: ['a'] })
    expect(res.vectors).toEqual([])
    expect(res.provenance.fallbackUsed).toBe(true)
  })

  it('never throws even if the provider throws', async () => {
    const throwing: ModelProvider = {
      async *complete() {
        return
      },
      async completeSync() {
        throw new Error('boom')
      },
    }
    const { service } = makeService({ enabled: 'on', provider: throwing })
    const res = await service.summarize({ taskId: 't1', content: 'x'.repeat(100) })
    expect(res.provenance.fallbackUsed).toBe(true)
  })
})
