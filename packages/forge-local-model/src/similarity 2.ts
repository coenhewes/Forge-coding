/**
 * Vector utilities for semantic retrieval. Pure functions, no I/O — kept
 * dependency-free so embeddings can be ranked in-process without pgvector.
 */

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface RankedItem<T> {
  item: T
  index: number
  score: number
}

/**
 * Rank `items` by cosine similarity of their vector (via `vectorOf`) to
 * `query`, best first. Stable for equal scores (preserves input order).
 */
export function rankBySimilarity<T>(
  query: readonly number[],
  items: readonly T[],
  vectorOf: (item: T) => readonly number[],
): RankedItem<T>[] {
  return items
    .map((item, index) => ({ item, index, score: cosineSimilarity(query, vectorOf(item)) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
}
