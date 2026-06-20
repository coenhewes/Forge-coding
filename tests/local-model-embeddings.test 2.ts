/**
 * Embedding similarity utilities — cosine + ranking correctness.
 */
import { describe, it, expect } from 'vitest'
import { cosineSimilarity, rankBySimilarity } from '@forge/local-model'

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('handles degenerate (zero / empty) vectors safely', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('rankBySimilarity', () => {
  it('orders items by similarity to the query, best first', () => {
    const query = [1, 0, 0]
    const items = [
      { id: 'orthogonal', v: [0, 1, 0] },
      { id: 'aligned', v: [0.9, 0.1, 0] },
      { id: 'opposite', v: [-1, 0, 0] },
    ]
    const ranked = rankBySimilarity(query, items, (i) => i.v)
    expect(ranked[0]!.item.id).toBe('aligned')
    expect(ranked[2]!.item.id).toBe('opposite')
    expect(ranked[0]!.index).toBe(1)
  })

  it('is stable for equal scores', () => {
    const query = [1, 0]
    const items = [{ v: [0, 1] }, { v: [0, 1] }]
    const ranked = rankBySimilarity(query, items, (i) => i.v)
    expect(ranked.map((r) => r.index)).toEqual([0, 1])
  })
})
