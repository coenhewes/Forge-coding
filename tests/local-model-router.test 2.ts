/**
 * LocalModelRouter tests — enablement logic and provider-config selection.
 * Hermetic: the reachability probe is injected, never a real socket.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LocalModelConfig } from '@forge/types'
import { LocalModelRouter } from '@forge/local-model'

const deps = (probeResult: boolean, probeSpy?: () => void) => ({
  createProvider: () => ({
    async *complete() {
      return
    },
    async completeSync() {
      return { content: '', finishReason: 'stop' as const }
    },
  }),
  createEmbeddingProvider: () => null,
  probe: async () => {
    probeSpy?.()
    return probeResult
  },
})

describe('LocalModelRouter — enablement', () => {
  it('off is never available and never probes', async () => {
    const spy = vi.fn()
    const router = new LocalModelRouter({ enabled: 'off' }, deps(true, spy))
    expect(await router.available()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('on is always available without probing', async () => {
    const spy = vi.fn()
    const router = new LocalModelRouter({ enabled: 'on' }, deps(false, spy))
    expect(await router.available()).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('auto probes once and caches the result', async () => {
    const spy = vi.fn()
    const router = new LocalModelRouter({ enabled: 'auto' }, deps(true, spy))
    expect(await router.available()).toBe(true)
    expect(await router.available()).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('auto reflects an unreachable endpoint', async () => {
    const router = new LocalModelRouter({ enabled: 'auto' }, deps(false))
    expect(await router.available()).toBe(false)
  })
})

describe('LocalModelRouter — config selection', () => {
  it('defaults instruct + embed to local Ollama', () => {
    const router = new LocalModelRouter({ enabled: 'auto' }, deps(true))
    expect(router.instructConfig().name).toBe('ollama')
    expect(router.embedConfig().name).toBe('ollama')
    expect(router.configFor('embed').model).not.toBe(router.configFor('summarize').model)
  })

  it('honors explicit provider overrides', () => {
    const config: LocalModelConfig = {
      enabled: 'on',
      instruct: { name: 'ollama-cloud', model: 'qwen2.5-coder:32b', apiUrl: 'https://x' },
    }
    const router = new LocalModelRouter(config, deps(true))
    expect(router.instructConfig().name).toBe('ollama-cloud')
    expect(router.instructConfig().apiUrl).toBe('https://x')
  })
})
