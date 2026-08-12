/**
 * LocalModelRouter — decides whether the local layer is usable and which
 * provider config backs each task kind.
 *
 * One layer, multiple specialized models:
 *   - instruct model → summarize | classify | extract | rerank
 *   - embedding model → embed
 *
 * Enablement:
 *   - `off`  → never available.
 *   - `on`   → always available (still falls back on per-call failure).
 *   - `auto` → available iff the local provider is reachable (probed once,
 *              result cached for the router's lifetime).
 *
 * The router reuses `selectProvider` from `@forge/provider` to keep provider
 * selection consistent with the rest of Forge (local-first, cost-tier <= 1).
 * All network/factory dependencies are injectable for hermetic tests.
 */

import type {
  EmbeddingProvider,
  LocalModelConfig,
  LocalTaskKind,
  ModelProvider,
  ProviderConfig,
} from '@forge/types'
import {
  createEmbeddingProvider as defaultCreateEmbeddingProvider,
  createProvider as defaultCreateProvider,
  defaultProviderConfig,
  DEFAULT_OLLAMA_EMBED_MODEL,
  selectProvider,
} from '@forge/provider'

export interface RouterDeps {
  createProvider: (config: ProviderConfig) => ModelProvider
  createEmbeddingProvider: (config: ProviderConfig) => EmbeddingProvider | null
  /** Reachability probe. Resolves true if the local endpoint answers. */
  probe: (baseUrl: string, timeoutMs: number) => Promise<boolean>
}

const DEFAULT_TIMEOUT_MS = 20_000

async function defaultProbe(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/tags`
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export class LocalModelRouter {
  private readonly deps: RouterDeps
  private reachable: boolean | undefined

  constructor(
    private readonly config: LocalModelConfig,
    deps?: Partial<RouterDeps>,
  ) {
    this.deps = {
      createProvider: deps?.createProvider ?? defaultCreateProvider,
      createEmbeddingProvider: deps?.createEmbeddingProvider ?? defaultCreateEmbeddingProvider,
      probe: deps?.probe ?? defaultProbe,
    }
  }

  /** The instruct provider config (config override → local Ollama default).
   *  The override may be ANY provider: local Ollama, a free API model
   *  (e.g. Nous upstage/solar-pro4:free), or a cheap remote model. */
  instructConfig(): ProviderConfig {
    if (this.config.instruct) return this.config.instruct
    // No override: default to the cheapest tools-capable provider. We no longer
    // hard-bias to Ollama here — the user can configure any cheap provider.
    const selection = selectProvider({ streaming: false })
    const name = selection?.entry.name ?? 'ollama'
    return defaultProviderConfig(name, { timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  }

  /** The embedding provider config (config override → local Ollama embed model). */
  embedConfig(): ProviderConfig {
    if (this.config.embed) return this.config.embed
    return defaultProviderConfig('ollama', {
      model: DEFAULT_OLLAMA_EMBED_MODEL,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  }

  configFor(kind: LocalTaskKind): ProviderConfig {
    return kind === 'embed' ? this.embedConfig() : this.instructConfig()
  }

  instructProvider(): ModelProvider {
    return this.deps.createProvider(this.instructConfig())
  }

  embedProvider(): EmbeddingProvider | null {
    return this.deps.createEmbeddingProvider(this.embedConfig())
  }

  /** Whether the cheap-model layer should be attempted. Caches the `auto` probe.
   *
   *  - Remote/API providers (anything other than `ollama`) are treated as
   *    available without a reachability probe — the auth + call will surface
   *    failures at request time and fall back deterministically.
   *  - Local Ollama is probed once against its `/api/tags` endpoint. */
  async available(): Promise<boolean> {
    if (this.config.enabled === 'off') return false
    if (this.config.enabled === 'on') return true
    const cfg = this.instructConfig()
    if (cfg.name !== 'ollama') return true
    if (this.reachable === undefined) {
      const baseUrl = cfg.apiUrl ?? 'http://localhost:11434'
      this.reachable = await this.deps.probe(baseUrl, this.config.timeoutMs ?? 5_000)
    }
    return this.reachable
  }

  /** Reset the cached probe result (e.g. after the user starts Ollama). */
  resetProbe(): void {
    this.reachable = undefined
  }
}
