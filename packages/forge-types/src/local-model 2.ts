/**
 * Local-model layer — types.
 *
 * The local-model layer is a **best-effort, non-authoritative accelerator**
 * that runs bounded, structured sub-tasks (summarize / classify / extract /
 * rerank / embed) on cheap local models (default: Ollama, cost tier 0) so the
 * frontier model is not re-sent large raw payloads on every turn.
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
export type LocalTaskKind = 'summarize' | 'classify' | 'extract' | 'rerank' | 'embed'

/**
 * How the local layer is enabled:
 *   - `auto`: enabled only if a local provider is reachable (probed once).
 *   - `on`:   always attempt local delegation (still falls back on failure).
 *   - `off`:  disabled; every call returns the deterministic fallback.
 */
export type LocalModelEnablement = 'auto' | 'on' | 'off'

/** Configuration for the local-model layer (lives under ForgeConfig.localModel). */
export interface LocalModelConfig {
  enabled: LocalModelEnablement
  /** Provider used for summarize/classify/extract/rerank. Defaults to local Ollama. */
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

export interface LocalModelUsage {
  inputTokens?: number
  outputTokens?: number
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
