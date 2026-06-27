import type { TokenUsage } from '@forge/types'

/**
 * Approximate USD pricing per 1M tokens, by model substring. Used to turn token
 * usage into the AGENTS.md North Star: cost per verified completed task. These
 * are estimates — update as provider pricing changes. Matched by substring so
 * versioned model ids ("claude-opus-4-8", "gpt-5.2-...") resolve to a family.
 */
export interface ModelPrice {
  /** Lowercased substring matched against the model id. */
  match: string
  inputPerMTok: number
  outputPerMTok: number
}

export const MODEL_PRICES: ModelPrice[] = [
  { match: 'opus', inputPerMTok: 15, outputPerMTok: 75 },
  { match: 'sonnet', inputPerMTok: 3, outputPerMTok: 15 },
  { match: 'haiku', inputPerMTok: 0.8, outputPerMTok: 4 },
  { match: 'gpt-5', inputPerMTok: 5, outputPerMTok: 15 },
  { match: 'gpt-4o', inputPerMTok: 2.5, outputPerMTok: 10 },
  { match: 'o3', inputPerMTok: 2, outputPerMTok: 8 },
  { match: 'minimax', inputPerMTok: 0.3, outputPerMTok: 1.2 },
  { match: 'llama', inputPerMTok: 0.2, outputPerMTok: 0.2 },
]

/** Fallback price when no model matches (keeps cost non-zero but conservative). */
const DEFAULT_PRICE: Omit<ModelPrice, 'match'> = { inputPerMTok: 1, outputPerMTok: 3 }

/** Estimate the USD cost of a completion given the model id and token usage. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const m = model.toLowerCase()
  const price = MODEL_PRICES.find((p) => m.includes(p.match)) ?? DEFAULT_PRICE
  const cost = (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  return Math.round(cost * 1e6) / 1e6
}
