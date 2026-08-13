/**
 * Provider catalog tests.
 *
 * Coverage:
 *   - catalog shape (7 providers, all required fields populated)
 *   - lookup helpers (getProviderEntry, requireProviderEntry, listProviderNames)
 *   - selectProvider (capability filters, cost-tier ceiling, preferred override)
 *   - defaultProviderConfig (fills catalog defaults, preserves overrides)
 *   - probeProvider (uses an in-process fetch stub — no real network)
 *
 * All tests are hermetic. The probe tests stub `globalThis.fetch` so
 * the suite never opens a real socket; the catalog tests are pure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_CATALOG,
  defaultProviderConfig,
  getProviderEntry,
  listProviderNames,
  probeProvider,
  requireProviderEntry,
  selectProvider,
} from '@forge/provider'

describe('PROVIDER_CATALOG — shape', () => {
  it('contains exactly seven providers', () => {
    expect(PROVIDER_CATALOG).toHaveLength(7)
  })

  it('lists every provider name as a unique value', () => {
    const names = PROVIDER_CATALOG.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
    // Sanity: the names we expect to ship today.
    expect(new Set(names)).toEqual(
      new Set(['anthropic', 'openai', 'openrouter', 'minimax', 'nous', 'ollama-cloud', 'ollama']),
    )
  })

  it('every entry has the required metadata fields populated', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(entry.vendor.length).toBeGreaterThan(0)
      expect(entry.defaultBaseUrl.length).toBeGreaterThan(0)
      expect(entry.contextWindow).toBeGreaterThan(0)
      expect(entry.defaultMaxTokens).toBeGreaterThan(0)
      expect([0, 1, 2, 3]).toContain(entry.costTier)
      expect(entry.defaultModel.length).toBeGreaterThan(0)
      expect(typeof entry.requiresApiKey).toBe('boolean')
      expect(entry.capabilities.tools).toBeTypeOf('boolean')
      expect(entry.capabilities.vision).toBeTypeOf('boolean')
      expect(entry.capabilities.streaming).toBeTypeOf('boolean')
      expect(entry.capabilities.systemMessage).toBeTypeOf('boolean')
      expect(entry.capabilities.jsonMode).toBeTypeOf('boolean')
    }
  })

  it('catalog is frozen so callers cannot mutate it by accident', () => {
    expect(Object.isFrozen(PROVIDER_CATALOG)).toBe(true)
    for (const entry of PROVIDER_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true)
    }
  })

  it('paid providers require an API key; local Ollama does not', () => {
    const ollama = requireProviderEntry('ollama')
    expect(ollama.requiresApiKey).toBe(false)
    expect(ollama.apiKeyEnv).toEqual([])
    const anthropic = requireProviderEntry('anthropic')
    expect(anthropic.requiresApiKey).toBe(true)
    expect(anthropic.apiKeyEnv).toContain('ANTHROPIC_API_KEY')
  })
})

describe('lookup helpers', () => {
  it('getProviderEntry returns the entry or undefined', () => {
    expect(getProviderEntry('openai')?.vendor).toBe('OpenAI')
    expect(getProviderEntry('not-a-provider' as never)).toBeUndefined()
  })

  it('requireProviderEntry throws on unknown names', () => {
    expect(() => requireProviderEntry('not-a-provider' as never)).toThrow(/Unknown provider/)
  })

  it('listProviderNames returns every provider name in declaration order', () => {
    expect(listProviderNames()).toEqual(PROVIDER_CATALOG.map((e) => e.name))
  })
})

describe('selectProvider — capability filtering', () => {
  it('returns null when no provider satisfies the constraints', () => {
    // 1M token minimum is not offered by any cataloged provider today.
    const result = selectProvider({ minContextWindow: 1_000_000 })
    expect(result).toBeNull()
  })

  it('excludes providers that do not support required capabilities', () => {
    // Only OpenAI, Anthropic, and OpenRouter advertise vision.
    const result = selectProvider({ vision: true })
    expect(result).not.toBeNull()
    const matchedNames = new Set(result!.matchedNames)
    expect(matchedNames.has('openai')).toBe(true)
    expect(matchedNames.has('anthropic')).toBe(true)
    expect(matchedNames.has('openrouter')).toBe(true)
    expect(matchedNames.has('ollama')).toBe(false)
  })

  it('honors the cost-tier ceiling', () => {
    // Tier 0 = Ollama only.
    const cheap = selectProvider({ maxCostTier: 0 })
    expect(cheap?.entry.name).toBe('ollama')
    expect(cheap?.reason).toMatch(/free tier/i)

    // Tier 1 adds ollama-cloud.
    const tier1 = selectProvider({ maxCostTier: 1 })
    expect(tier1?.matchedNames).toEqual(expect.arrayContaining(['ollama', 'ollama-cloud']))
  })

  it('preferred provider wins outright if it passes all constraints', () => {
    const result = selectProvider({ preferred: 'anthropic', maxCostTier: 3 })
    expect(result?.entry.name).toBe('anthropic')
    expect(result?.reason).toMatch(/preferred/i)
  })

  it('preferred provider that fails a constraint is ignored (does not pick it anyway)', () => {
    // Anthropic is tier 3 — the cost ceiling excludes it, so preferred
    // must not be selected. We expect the cheapest tier-0 survivor
    // (ollama) instead of anthropic.
    const result = selectProvider({ preferred: 'anthropic', maxCostTier: 0 })
    expect(result?.entry.name).toBe('ollama')
  })

  it('preferred provider wins when it satisfies the constraints', () => {
    const result = selectProvider({ preferred: 'openai', vision: true })
    expect(result?.entry.name).toBe('openai')
    expect(result?.reason).toMatch(/preferred/i)
  })

  it('default policy (tools + streaming, no vision, no cost ceiling) returns the cheapest viable provider', () => {
    const result = selectProvider({})
    expect(result).not.toBeNull()
    expect(result!.entry.costTier).toBe(0)
    expect(result!.entry.name).toBe('ollama')
  })
})

describe('defaultProviderConfig', () => {
  it('fills catalog defaults for any field the caller omits', () => {
    const cfg = defaultProviderConfig('anthropic')
    expect(cfg.name).toBe('anthropic')
    expect(cfg.model).toBe('claude-sonnet-4-5')
    expect(cfg.apiUrl).toBe('https://api.anthropic.com')
    expect(cfg.maxTokens).toBe(8192)
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.temperature).toBeUndefined()
  })

  it('preserves caller overrides', () => {
    const cfg = defaultProviderConfig('openai', {
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 1024,
    })
    expect(cfg.model).toBe('gpt-4o-mini')
    expect(cfg.temperature).toBe(0.2)
    expect(cfg.maxTokens).toBe(1024)
    // apiUrl still falls back to the catalog default.
    expect(cfg.apiUrl).toBe('https://api.openai.com/v1')
  })

  it('throws for unknown provider names', () => {
    expect(() => defaultProviderConfig('not-a-provider' as never)).toThrow(/Unknown provider/)
  })
})

describe('probeProvider — hermetic via fetch stub', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('reports ok=true on a 2xx response and captures latency', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{}', { status: 200, statusText: 'OK' }),
    ) as unknown as typeof fetch

    const report = await probeProvider('openai', { timeoutMs: 1000 })
    expect(report.ok).toBe(true)
    expect(report.name).toBe('openai')
    expect(report.endpoint).toContain('/models')
    expect(report.latencyMs).toBeGreaterThanOrEqual(0)
    expect(report.message).toMatch(/Reachable/)
  })

  it('reports auth failure on 401/403 with a helpful hint', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof fetch

    const report = await probeProvider('openai', { timeoutMs: 1000 })
    expect(report.ok).toBe(false)
    expect(report.error).toBe('ProviderAuthError')
    expect(report.message).toMatch(/ANTHROPIC_API_KEY|authentication/i)
  })

  it('treats 5xx as a generic provider error (not auth, not unreachable)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('oops', { status: 503, statusText: 'Service Unavailable' }),
    ) as unknown as typeof fetch

    const report = await probeProvider('openai', { timeoutMs: 1000 })
    expect(report.ok).toBe(false)
    expect(report.error).toBe('ProviderProbeError')
  })

  it('reports unreachable when fetch throws (DNS / connection refused)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }) as unknown as typeof fetch

    const report = await probeProvider('openai', { timeoutMs: 1000 })
    expect(report.ok).toBe(false)
    expect(report.error).toBe('ProviderUnreachableError')
    expect(report.message).toMatch(/ECONNREFUSED/)
  })

  it('reports timeout when the request exceeds timeoutMs', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        // Never resolve naturally — the abort above is the only path out.
      })
    }) as unknown as typeof fetch

    const report = await probeProvider('openai', { timeoutMs: 50 })
    expect(report.ok).toBe(false)
    expect(report.error).toBe('ProviderTimeoutError')
  })

  it('uses Anthropic-specific probe target with x-api-key header', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await probeProvider('anthropic', { timeoutMs: 1000 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toContain('/v1/messages')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['x-api-key']).toBeDefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('uses the Ollama /api/tags probe target with no auth header', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await probeProvider('ollama', { timeoutMs: 1000 })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toContain('/api/tags')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('throws when the provider name is unknown', async () => {
    await expect(
      probeProvider('not-a-provider' as never, { timeoutMs: 1000 }),
    ).rejects.toThrow(/Unknown provider/)
  })
})
