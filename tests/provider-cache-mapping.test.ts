/**
 * Prompt-cache boundary mapping tests.
 *
 * Coverage:
 *   - mapAnthropicMessages tags the last content block of a cacheBoundary
 *     message with `__cacheBoundary` so the provider can place a cache
 *     breakpoint there (the lever that makes the append-only history prefix
 *     cacheable on MiniMax — see agent-loop runCompletion).
 *   - the marker rides the correct block through the merge/filter passes.
 *   - mergeChunks aggregates cacheReadTokens (the diagnostic that confirms
 *     caching engages in real runs).
 *
 * All pure — no network, no provider instantiation.
 */
import { describe, it, expect } from 'vitest'
import { mapAnthropicMessages, mergeChunks } from '@forge/provider'
import type { Message, CompletionChunk } from '@forge/types'

describe('mapAnthropicMessages — cache boundary', () => {
  it('tags the last block of the cacheBoundary message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'the task' },
      { role: 'assistant', content: 'looking', toolCalls: [{ id: 't1', name: 'read', input: {} }] },
      { role: 'tool', toolCallId: 't1', content: 'file contents', cacheBoundary: true },
      { role: 'user', content: 'situation report (volatile)' },
    ]
    const mapped = mapAnthropicMessages(messages)
    // Find the block carrying the boundary marker.
    let marked: Record<string, unknown> | undefined
    for (const m of mapped) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.__cacheBoundary) marked = b
      }
    }
    expect(marked).toBeDefined()
    // It must be the tool_result block (end of stable history), NOT the
    // volatile situation text that follows it.
    expect(marked!.type).toBe('tool_result')
    expect(marked!.tool_use_id).toBe('t1')
  })

  it('places no marker when no message has cacheBoundary', () => {
    const messages: Message[] = [
      { role: 'user', content: 'the task' },
      { role: 'assistant', content: 'done' },
    ]
    const mapped = mapAnthropicMessages(messages)
    for (const m of mapped) {
      for (const b of m.content as Record<string, unknown>[]) {
        expect(b.__cacheBoundary).toBeUndefined()
      }
    }
  })
})

describe('mergeChunks — cache-read usage', () => {
  it('aggregates cacheReadTokens (max snapshot)', () => {
    const chunks: CompletionChunk[] = [
      { usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 2000 } },
      { content: 'ok' },
      { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 2000 }, finishReason: 'stop' },
    ]
    const merged = mergeChunks(chunks)
    expect(merged.usage?.inputTokens).toBe(100)
    expect(merged.usage?.outputTokens).toBe(5)
    expect(merged.usage?.cacheReadTokens).toBe(2000)
  })
})
