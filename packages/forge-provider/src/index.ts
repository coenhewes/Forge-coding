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

export function createProvider(config: ProviderConfig): ModelProvider {
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
