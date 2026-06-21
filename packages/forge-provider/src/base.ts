import type {
  CompletionRequest,
  Message,
  ToolDefinition,
  ToolCall,
  CompletionChunk,
  CompletionResult,
} from '@forge/types'

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function buildApiUrl(base: string, path: string): string {
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return `${normalized}${path}`
}

export async function fetchStream(
  url: string,
  options: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOptions } = options
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ProviderError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        body,
      )
    }

    return response
  } finally {
    clearTimeout(timeout)
  }
}

export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderError('Response body is not readable')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''

      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6)
          if (data === '[DONE]') return
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6)
        if (data !== '[DONE]') {
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            // skip
          }
        }
      }
    }
}

export async function* parseAnthropicEventStream(response: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7)
      } else if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6)
        try {
          yield { event: currentEvent, data: JSON.parse(data) as Record<string, unknown> }
        } catch {
          // skip
        }
        currentEvent = ''
      }
    }
  }
}

export async function* parseNewlineJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderError('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue
      try {
        yield JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // skip
      }
    }
  }
}

export function mapMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role }
    if (m.role === 'tool') {
      base.content = m.content
      base.tool_call_id = m.toolCallId
    } else {
      base.content = m.content
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      }))
    }
    return base
  })
}

export function mapAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
  // Anthropic-format endpoints (Anthropic + MiniMax) require: no inline
  // `system` turns (system is a top-level param), strictly alternating
  // user/assistant roles, and non-empty content. The agent loop can produce
  // sequences that violate these (compaction injects a mid-stream system
  // message; consecutive nudges create same-role runs), which yields HTTP 400.
  // So we normalize to content-block arrays, then merge consecutive same-role
  // turns and drop empties to guarantee a valid request.
  type Block = Record<string, unknown>
  const normalized: { role: 'user' | 'assistant'; content: Block[] }[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      // Inline system → a user note (system proper is passed separately).
      if (m.content) normalized.push({ role: 'user', content: [{ type: 'text', text: m.content }] })
      continue
    }
    if (m.role === 'tool') {
      normalized.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      })
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: Block[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      normalized.push({ role: 'assistant', content })
    } else {
      const content: Block[] = m.content ? [{ type: 'text', text: m.content }] : []
      normalized.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content })
    }

    // Tag the last content block of a cache-boundary message so the provider
    // can place a prompt-cache breakpoint there. The marker rides on the block
    // object (by reference), so it survives the merge/filter passes below.
    if (m.cacheBoundary) {
      const lastEntry = normalized[normalized.length - 1]
      const lastBlock = lastEntry?.content[lastEntry.content.length - 1]
      if (lastBlock) lastBlock.__cacheBoundary = true
    }
  }

  // Merge consecutive same-role turns (concatenate their blocks).
  const merged: { role: 'user' | 'assistant'; content: Block[] }[] = []
  for (const msg of normalized) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) last.content.push(...msg.content)
    else merged.push({ role: msg.role, content: [...msg.content] })
  }

  // Remove orphan tool blocks. Anthropic requires every `tool_use` to be
  // followed by a matching `tool_result` and rejects a `tool_result` with no
  // preceding `tool_use` (HTTP 400). History compaction can drop one side of a
  // pair (e.g. keep a tool_result whose tool_use was trimmed), so we keep only
  // blocks whose partner id is present somewhere in the sequence.
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const m of merged) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id)
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') toolResultIds.add(b.tool_use_id)
    }
  }

  const filtered = merged
    .map((m) => ({
      role: m.role,
      content: m.content.filter((b) => {
        if (b.type === 'text') return (b.text as string)?.length > 0
        if (b.type === 'tool_use') return toolResultIds.has(b.id as string)
        if (b.type === 'tool_result') return toolUseIds.has(b.tool_use_id as string)
        return true
      }),
    }))
    .filter((m) => m.content.length > 0)

  // Re-merge: dropping an emptied turn can leave two same-role turns adjacent,
  // which Anthropic also rejects.
  const result: { role: 'user' | 'assistant'; content: Block[] }[] = []
  for (const m of filtered) {
    const last = result[result.length - 1]
    if (last && last.role === m.role) last.content.push(...m.content)
    else result.push(m)
  }
  return result
}

export function mapTools(tools?: ToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

export function mapAnthropicTools(tools?: ToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

/**
 * Parse tool-call argument JSON without ever throwing. Models frequently emit
 * truncated argument strings when a response hits its token cap (the JSON ends
 * mid-string). We try a strict parse, then a best-effort repair (close any open
 * string and balance brackets), and finally give up by returning `undefined` so
 * the caller can drop the malformed call rather than crash the whole run.
 */
export function safeParseToolInput(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Best-effort repair of a truncated object: close an unterminated string,
    // then append the missing closing brackets in reverse nesting order.
    try {
      let s = raw
      const quotes = (s.match(/(?<!\\)"/g) ?? []).length
      if (quotes % 2 === 1) s += '"'
      const stack: string[] = []
      let inStr = false
      let esc = false
      for (const ch of s) {
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{') stack.push('}')
        else if (ch === '[') stack.push(']')
        else if (ch === '}' || ch === ']') stack.pop()
      }
      while (stack.length) s += stack.pop()
      return JSON.parse(s) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}

export function parseToolCallsFromChunk(data: Record<string, unknown>): ToolCall[] | undefined {
  const choices = data.choices as Record<string, unknown>[] | undefined
  if (!choices || choices.length === 0) return undefined

  const delta = choices[0]?.delta as Record<string, unknown> | undefined
  if (!delta) return undefined

  const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => {
    const func = tc.function as Record<string, unknown> | undefined
    return {
      id: tc.id as string,
      name: func?.name as string ?? '',
      input: safeParseToolInput(func?.arguments as string | undefined) ?? {},
    }
  })
}

export function mergeChunks(chunks: CompletionChunk[]): CompletionResult {
  let content = ''
  const toolCalls: ToolCall[] = []
  let finishReason: CompletionResult['finishReason'] = 'stop'
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let sawUsage = false

  for (const chunk of chunks) {
    if (chunk.content) content += chunk.content
    if (chunk.toolCalls) {
      for (const tc of chunk.toolCalls) {
        toolCalls.push(tc)
      }
    }
    if (chunk.finishReason) finishReason = chunk.finishReason
    if (chunk.usage) {
      // Usage fields are cumulative snapshots, not increments — take the max
      // seen so a late partial snapshot can't lower the count.
      if (typeof chunk.usage.inputTokens === 'number') {
        inputTokens = Math.max(inputTokens, chunk.usage.inputTokens)
        sawUsage = true
      }
      if (typeof chunk.usage.outputTokens === 'number') {
        outputTokens = Math.max(outputTokens, chunk.usage.outputTokens)
        sawUsage = true
      }
      if (typeof chunk.usage.cacheReadTokens === 'number') {
        cacheReadTokens = Math.max(cacheReadTokens, chunk.usage.cacheReadTokens)
        sawUsage = true
      }
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(sawUsage ? { usage: { inputTokens, outputTokens, cacheReadTokens } } : {}),
  }
}

export function getSystemMessage(messages: Message[]): string | undefined {
  const system = messages.find((m) => m.role === 'system')
  return system?.content as string | undefined
}
