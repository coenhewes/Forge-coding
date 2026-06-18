import type { ProviderConfig, ModelProvider } from '@forge/types'

import { OpenRouterProvider } from './openrouter.js'
import { OllamaProvider } from './ollama.js'
import { OpenAIProvider } from './openai.js'
import { AnthropicProvider } from './anthropic.js'
import { MinimaxProvider } from './minimax.js'

export { OpenRouterProvider } from './openrouter.js'
export { OllamaProvider } from './ollama.js'
export { OpenAIProvider } from './openai.js'
export { AnthropicProvider } from './anthropic.js'
export { MinimaxProvider } from './minimax.js'
export { ProviderError } from './base.js'

// Provider catalog — static metadata for routing and CLI tooling.
export {
  PROVIDER_CATALOG,
  getProviderEntry,
  requireProviderEntry,
  listProviderNames,
  selectProvider,
  defaultProviderConfig,
  probeProvider,
} from './catalog.js'
export type {
  ProviderCapabilities,
  CostTier,
  ProviderCatalogEntry,
  ProviderPolicy,
  ProviderSelection,
  ProviderProbeReport,
} from './catalog.js'

/**
 * Environment variables checked for each provider's API key, in order. The
 * config value always wins; env is the fallback so secrets need not be written
 * to .forge/config.json (which is committed-adjacent).
 */
const API_KEY_ENV: Record<ProviderConfig['name'], string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  ollama: [],
  'ollama-cloud': ['OLLAMA_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
}

/** Resolve the API key from config, falling back to the provider's env vars. */
export function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKey) return config.apiKey
  for (const name of API_KEY_ENV[config.name] ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export function createProvider(config: ProviderConfig): ModelProvider {
  const resolved: ProviderConfig = { ...config, apiKey: resolveApiKey(config) }
  config = resolved
  switch (config.name) {
    case 'openrouter':
      return new OpenRouterProvider(config)
    case 'ollama':
    case 'ollama-cloud':
      return new OllamaProvider(config)
    case 'openai':
      return new OpenAIProvider(config)
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'minimax':
      return new MinimaxProvider(config)
    default: {
      const _exhaustive: never = config.name
      throw new Error(`Unknown provider: ${_exhaustive}`)
    }
  }
}
