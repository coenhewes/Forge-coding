/**
 * Cheap-model layer — types.
 *
 * The cheap-model layer is a **best-effort, non-authoritative accelerator**
 * that runs bounded, structured sub-tasks (summarize / classify / extract /
 * rerank / embed) on a cheap model so the frontier model is not re-sent large
 * raw payloads on every turn.
 *
 * The cheap model can be **any** provider you configure:
 *   - a local model (default: Ollama, cost tier 0),
 *   - a free API model (e.g. Nous `upstage/solar-pro4:free`),
 *   - or a cheap remote model (e.g. a low-cost OpenRouter entry).
 * Set it via `ForgeConfig.cheapModel.instruct` / `cheapModel.embed`.
 *
 * Design invariants encoded directly in these types:
 *
 *   - **Never the source of truth.** Every result carries the literal
 *     `authoritative: false`. Verification gating and belief promotion ignore
 *     anything sourced from the local layer; only deterministic evidence can
 *     flip a claim to `verified`.
 *
 *   - **Exact evidence stays recoverable.** Each call records a
 *     `LocalModelProvenance` linking the *stable references* of the artifact
 *     holding the exact input and the artifact holding the model output, so a
 *     compacted summary can always be traced back to the byte-exact original.
 *
 *   - **Bounded & resumable.** Inputs are truncated to a char budget and calls
 *     are timeout-capped; on any failure the service returns a deterministic
 *     fallback (`fallbackUsed: true`) instead of throwing, so the agent loop
 *     never blocks on a missing/slow local model.
 */

import type { ProviderConfig } from './provider.js'

/** The bounded sub-tasks the local layer can perform. */
export type LocalTaskKind = 'summarize' | 'classify' | 'extract' | 'rerank' | 'embed' | 'retrieve' | 'draft'

/**
 * How the local layer is enabled:
 *   - `auto`: enabled only if a local provider is reachable (probed once).
 *   - `on`:   always attempt local delegation (still falls back on failure).
 *   - `off`:  disabled; every call returns the deterministic fallback.
 */
export type LocalModelEnablement = 'auto' | 'on' | 'off'

/** Configuration for the cheap-model layer (lives under ForgeConfig.cheapModel). */
export interface CheapModelConfig {
  enabled: LocalModelEnablement
  /** Provider used for summarize/classify/extract/rerank. Defaults to local Ollama.
   *  Set to any provider, e.g. `{ name: 'nous', model: 'upstage/solar-pro4:free' }`
   *  or a cheap OpenRouter model. */
  instruct?: ProviderConfig
  /** Provider used for embeddings. Defaults to local Ollama embedding model. */
  embed?: ProviderConfig
  /** Hard cap on input chars handed to the model (deterministic head/tail truncation). */
  maxInputChars?: number
  /** Per-call timeout. */
  timeoutMs?: number
  /** Target size (tokens) for generated summaries. */
  summaryTargetTokens?: number
  /** Content larger than this (chars) is worth compacting. */
  compactionThresholdChars?: number
}

/** @deprecated Use {@link CheapModelConfig}. Kept for backward-compatible configs. */
export type LocalModelConfig = CheapModelConfig

export interface LocalModelUsage {
  inputTokens?: number
  outputTokens?: number
}

export type LocalCompressionStrategy =
  | 'none'
  | 'head_tail'
  | 'json_array'
  | 'search_results'
  | 'log'
  | 'diff_or_code'
  | 'semantic_summary'

export interface LocalModelSavings {
  originalBytes?: number
  emittedBytes?: number
  estimatedOriginalTokens?: number
  estimatedEmittedTokens?: number
  estimatedTokensSaved?: number
  strategy?: LocalCompressionStrategy
}

/**
 * Provenance attached to every local-model result. The artifact ids are the
 * stable references through which the exact input and output are recoverable
 * (see `EvidenceMemory` / context-server `evidence.get_exact_artifact`).
 */
export interface LocalModelProvenance {
  runId: string
  taskKind: LocalTaskKind
  model: string
  provider: string
  latencyMs: number
  usage?: LocalModelUsage
  /** Model-reported (or heuristic) confidence, 0..1. Never used for gating. */
  confidence?: number
  /** True when the deterministic fallback produced this result. */
  fallbackUsed: boolean
  /** Machine-readable reason for deterministic fallback, if known. */
  fallbackReason?: string
  /** Estimated compression/cost impact; advisory observability only. */
  savings?: LocalModelSavings
  /** Stable ref to the artifact holding the exact input. */
  sourceArtifactId?: string
  /** Stable ref to the artifact holding the model output. */
  outputArtifactId?: string
  createdAt: string
}

/** Shared shape: every local result is explicitly non-authoritative. */
export interface LocalModelResultBase {
  /** Local-model output is NEVER authoritative. Always literal `false`. */
  readonly authoritative: false
  provenance: LocalModelProvenance
}

export interface SummarizeRequest {
  taskId: string
  content: string
  /** Human label for what the content is, e.g. "output of `pnpm test`". */
  label?: string
  targetTokens?: number
}

export interface SummarizeResult extends LocalModelResultBase {
  summary: string
  /** Stable ref to recover the exact original content. */
  sourceArtifactId?: string
}

export interface ClassifyRequest {
  taskId: string
  content: string
  /** Closed label set; the model must pick one (else fallback → 'unknown'). */
  labels: string[]
  /** What is being classified, e.g. "test failure". */
  subject?: string
}

export interface ClassifyResult extends LocalModelResultBase {
  label: string
  confidence: number
  rationale?: string
}

export interface ExtractRequest {
  taskId: string
  content: string
  /** Field keys to extract, e.g. ["failing_test", "file", "line", "error_kind"]. */
  fields: string[]
  subject?: string
}

export interface ExtractedField {
  key: string
  value: string
}

export interface ExtractResult extends LocalModelResultBase {
  fields: ExtractedField[]
}

export interface RerankRequest {
  taskId: string
  query: string
  candidates: string[]
}

export interface RerankResult extends LocalModelResultBase {
  /** Indices into the input candidate list, best first. */
  order: number[]
  scores: number[]
}

export interface EmbedRequest {
  taskId?: string
  texts: string[]
}

export interface EmbedResult extends LocalModelResultBase {
  vectors: number[][]
  dim: number
}

export type RetrieveTargetType =
  | 'graph_node'
  | 'evidence_artifact'
  | 'claim'
  | 'text'
  | 'artifact'
  | 'file'
  | 'task_state'
  | 'decision'
  | 'failure'

export interface RetrieveCandidate {
  id: string
  targetType: RetrieveTargetType
  targetRef: string
  content: string
  lexicalScore?: number
  semanticScore?: number
  score: number
  metadata?: Record<string, unknown>
}

export interface RetrieveRequest {
  taskId?: string
  repoId?: string
  query: string
  candidates?: Array<{
    targetType: RetrieveCandidate['targetType']
    targetRef: string
    content: string
    metadata?: Record<string, unknown>
  }>
  limit?: number
}

export interface RetrieveResult extends LocalModelResultBase {
  query: string
  results: RetrieveCandidate[]
}

export interface DraftRequest {
  taskId: string
  prompt: string
  context?: string
  kind?: 'boilerplate' | 'test_skeleton' | 'small_patch' | 'migration_template' | 'notes'
  targetTokens?: number
}

export interface DraftResult extends LocalModelResultBase {
  draft: string
  kind: NonNullable<DraftRequest['kind']>
  /** Drafts are patch candidates only; the frontier model must accept/rewrite. */
  requiresFrontierReview: true
}

/* ---------------------------------------------------------------- *
 *  Embedding provider — kept separate from `ModelProvider` so the
 *  core chat interface is not bloated. Implemented by providers that
 *  expose an embeddings endpoint (e.g. Ollama `/api/embeddings`).
 * ---------------------------------------------------------------- */

export interface EmbeddingRequest {
  model: string
  texts: string[]
}

export interface EmbeddingResult {
  vectors: number[][]
  usage?: LocalModelUsage
}

export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>
}

/* ---------------------------------------------------------------- *
 *  Durable provenance records (mirrors migration v4 tables).
 * ---------------------------------------------------------------- */

export interface LocalModelRun {
  id: string
  taskId?: string
  taskKind: LocalTaskKind
  model: string
  provider: string
  inputArtifactId?: string
  outputArtifactId?: string
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  confidence?: number
  fallbackReason?: string
  savings?: LocalModelSavings
  fallbackUsed: boolean
  createdAt: string
}

export type EmbeddingTargetType = 'graph_node' | 'evidence_artifact' | 'claim' | 'text'

export interface EmbeddingRecord {
  id: string
  repoId: string
  targetType: EmbeddingTargetType
  targetRef: string
  model: string
  dim: number
  vector: number[]
  contentHash: string
  createdAt: string
}
