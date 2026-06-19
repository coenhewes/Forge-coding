/**
 * LocalContextIndex — local-first hybrid retrieval over Forge context.
 *
 * V1 deliberately indexes caller-supplied candidates rather than owning a
 * database. The agent/context-server can pass repo graph nodes, evidence,
 * failures, decisions, or task snapshots; this service combines exact lexical
 * scoring with optional local embeddings and returns advisory rankings.
 */
import type {
  RetrieveCandidate,
  RetrieveRequest,
  RetrieveResult,
  LocalModelProvenance,
} from '@forge/types'

import type { LocalModelService } from './service.js'
import { cosineSimilarity } from './similarity.js'

export interface LocalContextIndexConfig {
  lexicalWeight?: number
  semanticWeight?: number
  maxCandidateChars?: number
}

const DEFAULT_LEXICAL_WEIGHT = 0.65
const DEFAULT_SEMANTIC_WEIGHT = 0.35
const DEFAULT_MAX_CANDIDATE_CHARS = 6_000

export class LocalContextIndex {
  private readonly config: Required<LocalContextIndexConfig>

  constructor(private readonly service: LocalModelService, config: LocalContextIndexConfig = {}) {
    this.config = {
      lexicalWeight: config.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT,
      semanticWeight: config.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
      maxCandidateChars: config.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS,
    }
  }

  async retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
    const started = Date.now()
    const candidates = (req.candidates ?? []).map((candidate, index) => ({
      id: `${candidate.targetType}:${candidate.targetRef}:${index}`,
      targetType: candidate.targetType,
      targetRef: candidate.targetRef,
      content: candidate.content.slice(0, this.config.maxCandidateChars),
      metadata: candidate.metadata,
    }))
    const queryTerms = tokenize(req.query)

    const lexical = candidates.map((candidate) => lexicalScore(queryTerms, candidate.content, candidate.targetRef))
    let semantic: number[] = candidates.map(() => 0)
    let fallbackUsed = true
    let fallbackReason: string | undefined = 'embeddings unavailable'

    if (candidates.length > 0 && req.query.trim()) {
      const embedded = await this.service.embed({
        taskId: req.taskId,
        texts: [req.query, ...candidates.map((c) => c.content)],
      })
      if (!embedded.provenance.fallbackUsed && embedded.vectors.length === candidates.length + 1) {
        const queryVector = embedded.vectors[0]!
        semantic = embedded.vectors.slice(1).map((vector) => cosineSimilarity(queryVector, vector))
        fallbackUsed = false
        fallbackReason = undefined
      }
    }

    const maxLexical = Math.max(1, ...lexical)
    const results: RetrieveCandidate[] = candidates
      .map((candidate, index) => {
        const lexicalScoreValue = lexical[index]! / maxLexical
        const semanticScoreValue = semantic[index] ?? 0
        return {
          ...candidate,
          lexicalScore: lexicalScoreValue,
          semanticScore: semanticScoreValue,
          score: (lexicalScoreValue * this.config.lexicalWeight) + (semanticScoreValue * this.config.semanticWeight),
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, req.limit ?? 10)

    return {
      authoritative: false,
      query: req.query,
      results,
      provenance: {
        runId: `retrieve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        taskKind: 'retrieve',
        provider: fallbackUsed ? 'fallback' : 'local',
        model: fallbackUsed ? 'lexical' : 'embedding',
        latencyMs: Date.now() - started,
        fallbackUsed,
        fallbackReason,
        createdAt: new Date().toISOString(),
      } satisfies LocalModelProvenance,
    }
  }
}

function lexicalScore(queryTerms: string[], content: string, ref: string): number {
  if (queryTerms.length === 0) return 0
  const haystack = `${ref}\n${content}`.toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 2
    const occurrences = haystack.split(term).length - 1
    score += Math.min(occurrences, 8) * 0.25
  }
  return score
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_./-]+/).filter((part) => part.length >= 2))]
}
