/**
 * Provider catalog — typed registry of every LLM provider Forge supports,
 * with capability metadata that downstream systems can use for routing
 * (which provider supports tools? vision? what context window? cost tier?).
 *
 * The catalog is **static metadata**, not a runtime store. It pairs with
 * `createProvider()` from `./index.js`, which knows how to actually
 * instantiate the concrete provider class for a given `ProviderConfig`.
 *
 * Design notes:
 *
 *   - **Capability metadata is declared, not measured.** This file ships
 *     best-effort defaults (current model flagships as of 2025-2026).
 *     Operators who need fresher numbers override via `ProviderPolicy`
 *     in `policy.ts` (see companion file) or via `--model` on the CLI.
 *
 *   - **`selectProvider()` is a pure function.** Given a requested
 *     capability set + an optional user preference, return the best
 *     matching entry. It does NOT call out to any network and does NOT
 *     mutate global state — both of which would make it hostile to
 *     `provider-catalog.test.ts`.
 *
 *   - **`costTier` is a 0..3 ordinal**, not a dollar amount. The agent
 *     loop uses it for budget gating: tier 3 ("premium") is reserved
 *     for tasks where cheap tiers have already failed.
 */

import type { ProviderConfig, ProviderName } from '@forge/types'

/* ---------------------------------------------------------------- *
 *  Capability metadata
 * ---------------------------------------------------------------- */

/**
 * The set of tool/feature flags a provider exposes. New flags are
 * additive — older providers simply omit them.
 */
export interface ProviderCapabilities {
  /** Supports function/tool calling in the OpenRouter / OpenAI shape. */
  tools: boolean
  /** Accepts image inputs (multimodal). */
  vision: boolean
  /** Supports streaming via SSE / newline JSON / Anthropic event stream. */
  streaming: boolean
  /** Supports a JSON-mode / structured-outputs request option. */
  jsonMode: boolean
  /** Exposes an explicit system message slot (vs a top-level user turn). */
  systemMessage: boolean
}

/**
 * Cost tier is an ordinal (0 = cheapest, 3 = premium). The harness uses
 * this for budget gating, not for billing — billing reads the actual
 * model id and provider config.
 */
export type CostTier = 0 | 1 | 2 | 3

/**
 * One row in the provider catalog. The catalog is keyed by
 * `ProviderName` (already a string literal union in `@forge/types`).
 */
export interface ProviderCatalogEntry {
  /** Same as `ProviderName`, surfaced explicitly for ergonomic callers. */
  name: ProviderName
  /** Human-friendly vendor label. */
  vendor: string
  /** Default base URL. Empty string means "no default — must be set". */
  defaultBaseUrl: string
  /** Env vars checked for the API key, in lookup order. */
  apiKeyEnv: readonly string[]
  /** Capability flags — see `ProviderCapabilities`. */
  capabilities: ProviderCapabilities
  /** Maximum context window in tokens (input + output). */
  contextWindow: number
  /** Default max output tokens when the caller does not specify. */
  defaultMaxTokens: number
  /** Cost tier ordinal. */
  costTier: CostTier
  /** Whether this provider requires an API key (false = local). */
  requiresApiKey: boolean
  /** Recommended default model for greenfield init. */
  defaultModel: string
  /** Free-form notes shown by `forge providers list`. */
  notes?: string
}

/* ---------------------------------------------------------------- *
 *  The catalog itself
 * ---------------------------------------------------------------- */

/**
 * Single source of truth for the supported provider set. Order is
 * meaningful — `selectProvider` walks it in declaration order when
 * scoring, so put preferred providers first.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = Object.freeze([
  Object.freeze<ProviderCatalogEntry>({
    name: 'anthropic',
    vendor: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      jsonMode: false,
      systemMessage: true,
    },
    contextWindow: 200_000,
    defaultMaxTokens: 8192,
    costTier: 3,
    requiresApiKey: true,
    defaultModel: 'claude-sonnet-4-5',
    notes: 'Claude Sonnet 4.5 — strong on long-horizon engineering tasks',
  }),
  Object.freeze<ProviderCatalogEntry>({
    name: 'openai',
    vendor: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      jsonMode: true,
      systemMessage: true,
    },
    contextWindow: 128_000,
    defaultMaxTokens: 8192,
    costTier: 3,
    requiresApiKey: true,
    defaultModel: 'gpt-4o',
    notes: 'GPT-4o — vision-capable, native JSON-mode',
  }),
  Object.freeze<ProviderCatalogEntry>({
    name: 'openrouter',
    vendor: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      jsonMode: true,
      systemMessage: true,
    },
    contextWindow: 200_000,
    defaultMaxTokens: 8192,
    costTier: 2,
    requiresApiKey: true,
    defaultModel: 'anthropic/claude-sonnet-4-5',
    notes: 'Aggregates 100+ models — single billing surface',
  }),
  Object.freeze<ProviderCatalogEntry>({
    name: 'minimax',
    vendor: 'MiniMax',
    defaultBaseUrl: 'https://api.MiniMax.io/v1',
    apiKeyEnv: ['MINIMAX_API_KEY'],
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      jsonMode: true,
      systemMessage: true,
    },
    contextWindow: 128_000,
    defaultMaxTokens: 8192,
    costTier: 2,
    requiresApiKey: true,
    defaultModel: 'MiniMax-M3',
    notes: 'Internal MiniMax M3 — used for evaluation runs',
  }),
  Object.freeze<ProviderCatalogEntry>({
    name: 'ollama-cloud',
    vendor: 'Ollama Cloud',
    defaultBaseUrl: 'https://ollama.cloud/v1',
    apiKeyEnv: ['OLLAMA_API_KEY'],
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      jsonMode: true,
      systemMessage: true,
    },
    contextWindow: 32_000,
    defaultMaxTokens: 4096,
    costTier: 1,
    requiresApiKey: true,
    defaultModel: 'qwen2.5-coder:32b',
    notes: 'Ollama Cloud — OpenAI-compatible surface',
  }),
  Object.freeze<ProviderCatalogEntry>({
    name: 'ollama',
    vendor: 'Ollama (local)',
    defaultBaseUrl: 'http://localhost:11434',
    apiKeyEnv: [],
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      jsonMode: false,
      systemMessage: true,
    },
    contextWindow: 32_000,
    defaultMaxTokens: 4096,
    costTier: 0,
    requiresApiKey: false,
    defaultModel: 'qwen3:8b',
    notes: 'Local Ollama — zero-cost, requires ollama serve; override localModel.instruct for another installed model',
  }),
])

/** Map keyed by provider name for O(1) lookup. Built once at module load. */
const CATALOG_BY_NAME: ReadonlyMap<ProviderName, ProviderCatalogEntry> = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.name, entry] as const),
)

/** Get the catalog entry for a provider name. Returns undefined if unknown. */
export function getProviderEntry(name: ProviderName): ProviderCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name)
}

/** Get the catalog entry for a provider name, throwing if unknown. */
export function requireProviderEntry(name: ProviderName): ProviderCatalogEntry {
  const entry = CATALOG_BY_NAME.get(name)
  if (!entry) {
    throw new Error(`Unknown provider: ${name}`)
  }
  return entry
}

/** All supported provider names. */
export function listProviderNames(): readonly ProviderName[] {
  return PROVIDER_CATALOG.map((entry) => entry.name)
}

/* ---------------------------------------------------------------- *
 *  Policy — what the harness wants
 * ---------------------------------------------------------------- */

/** Requirements the harness declares for a given run. */
export interface ProviderPolicy {
  /** Provider must support tool calling. Default: true. */
  tools?: boolean
  /** Provider must accept vision inputs. Default: false. */
  vision?: boolean
  /** Provider must support streaming. Default: true. */
  streaming?: boolean
  /** Minimum context window in tokens. Default: 0. */
  minContextWindow?: number
  /** Maximum cost tier (0..3). Default: 3 (any). */
  maxCostTier?: CostTier
  /** Preferred provider — wins ties. */
  preferred?: ProviderName
}

/** Result of `selectProvider` — what was picked and why. */
export interface ProviderSelection {
  /** The chosen provider entry. */
  entry: ProviderCatalogEntry
  /** Why this provider was chosen (human-readable). */
  reason: string
  /** Number of entries that satisfied all hard constraints. */
  matched: number
  /** Names of entries that satisfied all hard constraints. */
  matchedNames: readonly ProviderName[]
}

/**
 * Select the best provider for a given policy. Pure function: no I/O,
 * no mutation, deterministic. Returns `null` when no entry satisfies
 * all hard constraints.
 *
 * Scoring:
 *   - Entries that violate any required capability are excluded.
 *   - The remaining entries are ranked by cost tier ascending (cheapest
 *     first), then alphabetically by name.
 *   - The `preferred` provider, if it satisfies all constraints, wins
 *     regardless of cost tier.
 */
export function selectProvider(policy: ProviderPolicy): ProviderSelection | null {
  const wantTools = policy.tools ?? true
  const wantVision = policy.vision ?? false
  const wantStreaming = policy.streaming ?? true
  const minContext = policy.minContextWindow ?? 0
  const maxCost = policy.maxCostTier ?? 3

  const matched: ProviderCatalogEntry[] = []
  for (const entry of PROVIDER_CATALOG) {
    if (wantTools && !entry.capabilities.tools) continue
    if (wantVision && !entry.capabilities.vision) continue
    if (wantStreaming && !entry.capabilities.streaming) continue
    if (entry.contextWindow < minContext) continue
    if (entry.costTier > maxCost) continue
    matched.push(entry)
  }

  if (matched.length === 0) {
    return null
  }

  // Preferred provider wins outright if it survived filtering.
  if (policy.preferred) {
    const preferred = matched.find((e) => e.name === policy.preferred)
    if (preferred) {
      return {
        entry: preferred,
        reason: `Preferred provider '${policy.preferred}' satisfies all requirements.`,
        matched: matched.length,
        matchedNames: matched.map((e) => e.name),
      }
    }
  }

  // Otherwise: cheapest tier wins, ties broken by name.
  const sorted = [...matched].sort((a, b) => {
    if (a.costTier !== b.costTier) return a.costTier - b.costTier
    return a.name.localeCompare(b.name)
  })
  const picked = sorted[0]!
  const reason = picked.costTier === 0
    ? `Cheapest viable provider (free tier).`
    : `Cheapest viable provider at cost tier ${picked.costTier}.`
  return {
    entry: picked,
    reason,
    matched: matched.length,
    matchedNames: matched.map((e) => e.name),
  }
}

/* ---------------------------------------------------------------- *
 *  Config helpers
 * ---------------------------------------------------------------- */

/**
 * Build a `ProviderConfig` for a given provider name, filling in the
 * catalog's defaults for any field the caller omits. The apiKey is
 * left for `resolveApiKey()` from `./index.js` to populate.
 */
export function defaultProviderConfig(
  name: ProviderName,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  const entry = requireProviderEntry(name)
  return {
    name: entry.name,
    model: overrides.model ?? entry.defaultModel,
    apiUrl: overrides.apiUrl ?? entry.defaultBaseUrl,
    apiKey: overrides.apiKey,
    maxTokens: overrides.maxTokens ?? entry.defaultMaxTokens,
    temperature: overrides.temperature,
    timeoutMs: overrides.timeoutMs,
  }
}

/* ---------------------------------------------------------------- *
 *  Probe — used by `forge providers test <name>`
 * ---------------------------------------------------------------- */

export interface ProviderProbeReport {
  name: ProviderName
  ok: boolean
  /** Endpoint probed (base URL, base URL + `/v1`, etc.). */
  endpoint: string
  /** Latency in milliseconds (round-trip). -1 if no response. */
  latencyMs: number
  /** Resolved API key presence (true/false) — never the value itself. */
  hasApiKey: boolean
  /** Diagnostic message. */
  message: string
  /** When `ok=false`, the underlying error class name. */
  error?: string
}

/**
 * Probe a provider's reachability. The probe does NOT issue a chat
 * completion — it issues the cheapest available health check (HEAD or
 * `/models` for OpenAI-compatible, `/` for Anthropic, `/api/tags` for
 * Ollama). It returns within `timeoutMs`.
 *
 * The probe is **read-only and side-effect-free**. It never throws —
 * errors are captured in the `ProviderProbeReport`.
 */
export async function probeProvider(
  name: ProviderName,
  options: { timeoutMs?: number; apiKey?: string } = {},
): Promise<ProviderProbeReport> {
  const entry = requireProviderEntry(name)
  const timeoutMs = options.timeoutMs ?? 5_000
  const apiKey = options.apiKey ?? resolveEnvKey(entry)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Each provider gets one probe target. Keep these conservative —
  // a HEAD on the base URL is usually fine, but Anthropic and Ollama
  // have their own health endpoints.
  const probe: { url: string; init: RequestInit } = (() => {
    switch (entry.name) {
      case 'anthropic':
        return {
          url: entry.defaultBaseUrl + '/v1/messages',
          init: {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey ?? '',
              'anthropic-version': '2023-06-01',
            },
            // Empty body is intentional — Anthropic rejects with 400 (not 401/403),
            // which is still enough to prove reachability + auth state.
            body: '{}',
          },
        }
      case 'ollama':
        return {
          url: entry.defaultBaseUrl + '/api/tags',
          init: { method: 'GET', signal: controller.signal },
        }
      default: {
        const headers: Record<string, string> = {}
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        return {
          url: entry.defaultBaseUrl + '/models',
          init: {
            method: 'GET',
            signal: controller.signal,
            headers,
          },
        }
      }
    }
  })()

  const started = Date.now()
  try {
    const response = await fetch(probe.url, probe.init)
    clearTimeout(timer)
    const latencyMs = Date.now() - started
    // 2xx = healthy. 401/403 = reachable but auth missing/invalid.
    // 4xx other = reachable but something's off. 5xx = server error.
    if (response.ok) {
      return {
        name,
        ok: true,
        endpoint: probe.url,
        latencyMs,
        hasApiKey: Boolean(apiKey),
        message: `Reachable; ${response.status} ${response.statusText}`,
      }
    }
    if (response.status === 401 || response.status === 403) {
      return {
        name,
        ok: false,
        endpoint: probe.url,
        latencyMs,
        hasApiKey: Boolean(apiKey),
        message: `Reachable but authentication failed (${response.status}). Set ${entry.apiKeyEnv.join(' or ') ?? 'no key needed'}.`,
        error: 'ProviderAuthError',
      }
    }
    return {
      name,
      ok: false,
      endpoint: probe.url,
      latencyMs,
      hasApiKey: Boolean(apiKey),
      message: `Reachable but unexpected status: ${response.status} ${response.statusText}`,
      error: 'ProviderProbeError',
    }
  } catch (err) {
    clearTimeout(timer)
    const latencyMs = Date.now() - started
    const reason =
      controller.signal.aborted
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      name,
      ok: false,
      endpoint: probe.url,
      latencyMs,
      hasApiKey: Boolean(apiKey),
      message: reason,
      error: controller.signal.aborted ? 'ProviderTimeoutError' : 'ProviderUnreachableError',
    }
  }
}

/** Read the first non-empty API key from the entry's env list. */
function resolveEnvKey(entry: ProviderCatalogEntry): string | undefined {
  for (const envName of entry.apiKeyEnv) {
    const value = process.env[envName]
    if (value) return value
  }
  return undefined
}
