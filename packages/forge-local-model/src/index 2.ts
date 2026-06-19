/**
 * @forge/local-model — a best-effort, non-authoritative delegation layer that
 * runs bounded sub-tasks (summarize / classify / extract / rerank / embed) on
 * cheap local models so the frontier model is not re-sent large raw payloads.
 *
 * The layer never becomes the source of truth: every result is
 * `authoritative: false`, exact inputs/outputs are persisted with stable refs,
 * and every call degrades to a deterministic fallback so the agent loop stays
 * bounded and resumable. See docs/local-model.md for the full design.
 */

export { LocalModelRouter } from './router.js'
export type { RouterDeps } from './router.js'

export { LocalModelService } from './service.js'
export type {
  StoredArtifact,
  ArtifactSink,
  RunSink,
  TraceSink,
  ServiceDeps,
} from './service.js'

export { CompactionPolicy } from './compaction.js'
export type { CompactionPolicyConfig, CompactionResult } from './compaction.js'

export { cosineSimilarity, rankBySimilarity } from './similarity.js'
export type { RankedItem } from './similarity.js'

// Lower-level helpers exported for reuse and testing.
export {
  extractJson,
  parseSummary,
  parseClassify,
  parseExtract,
  parseRerank,
  truncateMiddle,
  fallbackSummary,
  fallbackExtract,
  fallbackRerankOrder,
} from './parse.js'

export const DEFAULT_LOCAL_MODEL_CONFIG = {
  enabled: 'auto',
  maxInputChars: 24_000,
  timeoutMs: 20_000,
  summaryTargetTokens: 200,
  compactionThresholdChars: 4_000,
} as const
